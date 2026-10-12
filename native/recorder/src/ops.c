/* The recording.* operations (see include/anytune_recorder.h and docs/RECORDING.md). Every operation runs under one lock: the Polycall runtime serves each
 * connection on its own thread. */
#include "anytune_recorder.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include "json_reader.h"
#include "platform.h"
#include "recording_format.h"

#define REC_MAX_OPEN 8
#define REC_ID_LEN 32
#define REC_MAX_META (16u * 1024u)
#define REC_MAX_EVENTS_PER_APPEND 4096
#define REC_MAX_EVENT_KIND 32
#define REC_MAX_PATH 1024
#define REC_READ_DEFAULT_MAX 500
#define REC_READ_LIMIT 5000
#define REC_LIST_DEFAULT_MAX 100
#define REC_LIST_LIMIT 500

typedef struct {
    int used;
    char id[REC_ID_LEN + 1];
    FILE *f;
    double last_t;
    unsigned long long events;
} open_recording;

static struct {
    int configured;
    char root[REC_MAX_PATH];
    char token[ANYTUNE_RECORDER_MAX_TOKEN + 1];
    size_t token_len;
    open_recording open[REC_MAX_OPEN];
} g;

/* ------------------------------------------------------------------------------------------------------------------------------- output, bounded */

typedef struct {
    char *p;
    size_t cap;
    size_t len;
    int overflow;
} out_t;

static void out_raw(out_t *o, const char *s, size_t n) {
    if (o->overflow || o->len + n + 1 > o->cap) {
        o->overflow = 1;
        return;
    }
    memcpy(o->p + o->len, s, n);
    o->len += n;
    o->p[o->len] = '\0';
}

static void out_cstr(out_t *o, const char *s) { out_raw(o, s, strlen(s)); }

static void out_fmt(out_t *o, const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= sizeof buf) o->overflow = 1;
    else out_raw(o, buf, (size_t)n);
}

/* a C string as a JSON string */
static void out_json_string(out_t *o, const char *s) {
    out_raw(o, "\"", 1);
    for (; *s; s++) {
        unsigned char ch = (unsigned char)*s;
        if (ch == '"' || ch == '\\') {
            char e[2] = {'\\', (char)ch};
            out_raw(o, e, 2);
        } else if (ch < 0x20) {
            out_fmt(o, "\\u%04x", ch);
        } else {
            out_raw(o, (const char *)&ch, 1);
        }
    }
    out_raw(o, "\"", 1);
}

static polycall_op_status_t fail(char *ec, size_t ec_cap, char *em, size_t em_cap, polycall_op_status_t status, const char *code, const char *fmt, ...) {
    va_list ap;
    snprintf(ec, ec_cap, "%s", code);
    va_start(ap, fmt);
    vsnprintf(em, em_cap, fmt, ap);
    va_end(ap);
    return status;
}

#define FAIL(status, code, ...) fail(ec, ec_cap, em, em_cap, status, code, __VA_ARGS__)

/* ------------------------------------------------------------------------------------------------------------------------------- shared checks */

static int token_ok(jr_span input) {
    jr_span t;
    char given[ANYTUNE_RECORDER_MAX_TOKEN + 2];
    if (jr_get(input, "token", &t) != 0) return 0;
    long n = jr_string(t, given, sizeof given);
    if (n < 0 || (size_t)n != g.token_len) return 0;
    unsigned char diff = 0;
    for (size_t i = 0; i < g.token_len; i++) diff |= (unsigned char)(given[i] ^ g.token[i]); /* constant time in the token's content */
    return diff == 0;
}

static int id_of(jr_span input, char id[REC_ID_LEN + 1]) {
    jr_span s;
    if (jr_get(input, "recordingId", &s) != 0 || jr_string(s, id, REC_ID_LEN + 1) != REC_ID_LEN) return -1;
    for (int i = 0; i < REC_ID_LEN; i++) {
        if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return -1; /* never a path */
    }
    return 0;
}

static void path_of(const char *id, char *path, size_t cap) { snprintf(path, cap, "%s/%s.atrec", g.root, id); }

static open_recording *find_open(const char *id) {
    for (int i = 0; i < REC_MAX_OPEN; i++) {
        if (g.open[i].used && strcmp(g.open[i].id, id) == 0) return &g.open[i];
    }
    return NULL;
}

/* The integer member `key` in lo…hi, or `fallback` when absent. 0, or -1 when present and not such an integer. */
static int int_member(jr_span input, const char *key, long lo, long hi, long fallback, long *out) {
    jr_span v;
    double d;
    int found = jr_get(input, key, &v);
    if (found == 1) {
        *out = fallback;
        return 0;
    }
    if (found != 0 || jr_number(v, &d) != 0 || d != (double)(long)d || d < (double)lo || d > (double)hi) return -1;
    *out = (long)d;
    return 0;
}

/* The prelude of every operation: the input is a JSON object carrying the session token. */
#define PRELUDE()                                                                                                           \
    jr_span input;                                                                                                          \
    (void)deadline_ms;                                                                                                      \
    (void)user;                                                                                                             \
    if (!g.configured) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recorder.unconfigured", "the recorder has no storage directory and token"); \
    if (jr_parse(input_json, strlen(input_json), &input) != 0 || input.type != JR_OBJECT)                                   \
        return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "the input is not a JSON object");                             \
    if (!token_ok(input)) return FAIL(POLYCALL_OP_ERR_INPUT, "auth.denied", "the session token is missing or wrong")

/* ------------------------------------------------------------------------------------------------------------------------------- operations */

static polycall_op_status_t op_create(const char *input_json, uint32_t deadline_ms, char *out, size_t out_cap, char *ec, size_t ec_cap, char *em, size_t em_cap, void *user) {
    PRELUDE();
    jr_span kind_span, meta;
    char kind[16];
    if (jr_get(input, "kind", &kind_span) != 0 || jr_string(kind_span, kind, sizeof kind) < 0 || (strcmp(kind, "attempt") != 0 && strcmp(kind, "reference") != 0))
        return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "kind is \"attempt\" or \"reference\"");
    if (jr_get(input, "meta", &meta) != 0 || meta.type != JR_OBJECT) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "meta is an object");
    if (meta.n > REC_MAX_META) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "meta is at most %u bytes", REC_MAX_META);
    if (strcmp(kind, "attempt") == 0) {
        jr_span ref;
        char reference[129];
        if (jr_get(meta, "referenceId", &ref) != 0 || jr_string(ref, reference, sizeof reference) <= 0)
            return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "an attempt names the reference it was played against: meta.referenceId");
    }
    open_recording *slot = NULL;
    for (int i = 0; i < REC_MAX_OPEN && !slot; i++) {
        if (!g.open[i].used) slot = &g.open[i];
    }
    if (!slot) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recorder.busy", "%d recordings are already open: finish one first", REC_MAX_OPEN);

    unsigned char random[REC_ID_LEN / 2];
    if (rec_random(random, sizeof random) != 0) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recorder.random", "the operating system gave no random bytes for an id");
    char id[REC_ID_LEN + 1];
    for (int i = 0; i < REC_ID_LEN / 2; i++) snprintf(id + 2 * i, 3, "%02x", random[i]);
    char path[REC_MAX_PATH + 48];
    path_of(id, path, sizeof path);
    FILE *f = rec_fopen(path, "wb", 1);
    if (!f) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recording.io", "cannot create the recording file");

    char created[32];
    rec_utc_now(created, sizeof created);
    size_t cap = meta.n + 256;
    char *header = (char *)malloc(cap);
    if (!header) {
        fclose(f);
        return FAIL(POLYCALL_OP_ERR_INTERNAL, "internal", "out of memory");
    }
    out_t h = {header, cap, 0, 0};
    out_fmt(&h, "{\"format\":\"anytune-recording\",\"version\":\"%d.%d\",\"recordingId\":\"%s\",\"kind\":\"%s\",\"createdAt\":\"%s\",\"meta\":", ATREC_VERSION_MAJOR, ATREC_VERSION_MINOR, id, kind, created);
    out_raw(&h, meta.p, meta.n);
    out_cstr(&h, "}");
    atrec_status st = h.overflow ? ATREC_TOO_LARGE : atrec_write_file_header(f);
    if (st == ATREC_OK) st = atrec_write_record(f, ATREC_RECORD_HEADER, header, (uint32_t)h.len);
    free(header);
    if (st == ATREC_OK && rec_fsync(f) != 0) st = ATREC_IO;
    if (st != ATREC_OK) {
        fclose(f);
        return FAIL(POLYCALL_OP_ERR_INTERNAL, "recording.io", "cannot write the recording header: %s", atrec_status_text(st));
    }
    slot->used = 1;
    memcpy(slot->id, id, sizeof id);
    slot->f = f;
    slot->last_t = 0;
    slot->events = 0;
    out_t o = {out, out_cap, 0, 0};
    out_fmt(&o, "{\"recordingId\":\"%s\",\"kind\":\"%s\",\"createdAt\":\"%s\"}", id, kind, created);
    return POLYCALL_OP_OK;
}

static polycall_op_status_t op_append(const char *input_json, uint32_t deadline_ms, char *out, size_t out_cap, char *ec, size_t ec_cap, char *em, size_t em_cap, void *user) {
    PRELUDE();
    char id[REC_ID_LEN + 1];
    if (id_of(input, id) != 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "recordingId is 32 lowercase hex digits");
    open_recording *r = find_open(id);
    if (!r) return FAIL(POLYCALL_OP_ERR_NOTFOUND, "recording.not_open", "no open recording %s: it was finished, interrupted, or never created", id);
    jr_span events, e;
    if (jr_get(input, "events", &events) != 0 || events.type != JR_ARRAY) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "events is an array");
    size_t cursor = 0;
    long count = 0;
    double last = r->last_t;
    int has_last = r->events > 0;
    int step;
    while ((step = jr_next(events, &cursor, &e)) == 0) {
        jr_span t, k;
        double time;
        char kind[REC_MAX_EVENT_KIND + 1];
        if (e.type != JR_OBJECT) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "event %ld is not an object", count);
        if (jr_get(e, "t", &t) != 0 || jr_number(t, &time) != 0 || time < 0)
            return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "event %ld has no time t (seconds on the recording's clock, >= 0)", count);
        if (jr_get(e, "kind", &k) != 0 || jr_string(k, kind, sizeof kind) <= 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "event %ld has no kind (1-32 bytes)", count);
        if (has_last && time < last) return FAIL(POLYCALL_OP_ERR_INPUT, "recording.order", "event %ld at t=%.6f comes before t=%.6f: a recording keeps time order", count, time, last);
        last = time;
        has_last = 1;
        if (++count > REC_MAX_EVENTS_PER_APPEND) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "at most %d events per append", REC_MAX_EVENTS_PER_APPEND);
    }
    if (step < 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "events is not a well-formed array");
    if (count > 0) {
        atrec_status st = atrec_write_record(r->f, ATREC_RECORD_EVENTS, events.p, (uint32_t)events.n);
        if (st != ATREC_OK) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recording.io", "cannot append: %s", atrec_status_text(st));
        r->last_t = last;
        r->events += (unsigned long long)count;
    }
    out_t o = {out, out_cap, 0, 0};
    out_fmt(&o, "{\"appended\":%ld,\"events\":%llu}", count, r->events);
    return POLYCALL_OP_OK;
}

static polycall_op_status_t op_finish(const char *input_json, uint32_t deadline_ms, char *out, size_t out_cap, char *ec, size_t ec_cap, char *em, size_t em_cap, void *user) {
    PRELUDE();
    char id[REC_ID_LEN + 1];
    if (id_of(input, id) != 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "recordingId is 32 lowercase hex digits");
    open_recording *r = find_open(id);
    if (!r) return FAIL(POLYCALL_OP_ERR_NOTFOUND, "recording.not_open", "no open recording %s", id);
    char finished[32], end[160];
    rec_utc_now(finished, sizeof finished);
    if (r->events > 0) snprintf(end, sizeof end, "{\"events\":%llu,\"lastT\":%.17g,\"finishedAt\":\"%s\"}", r->events, r->last_t, finished);
    else snprintf(end, sizeof end, "{\"events\":0,\"lastT\":null,\"finishedAt\":\"%s\"}", finished);
    atrec_status st = atrec_write_record(r->f, ATREC_RECORD_END, end, (uint32_t)strlen(end));
    if (st == ATREC_OK && rec_fsync(r->f) != 0) st = ATREC_IO;
    unsigned long long events = r->events;
    fclose(r->f);
    memset(r, 0, sizeof *r);
    if (st != ATREC_OK) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recording.io", "cannot finish: %s", atrec_status_text(st));
    out_t o = {out, out_cap, 0, 0};
    out_fmt(&o, "{\"recordingId\":\"%s\",\"events\":%llu,\"finishedAt\":\"%s\"}", id, events, finished);
    return POLYCALL_OP_OK;
}

static polycall_op_status_t op_read(const char *input_json, uint32_t deadline_ms, char *out, size_t out_cap, char *ec, size_t ec_cap, char *em, size_t em_cap, void *user) {
    PRELUDE();
    char id[REC_ID_LEN + 1];
    long from, max;
    if (id_of(input, id) != 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "recordingId is 32 lowercase hex digits");
    if (int_member(input, "from", 0, 0x7fffffffL, 0, &from) != 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "from is an integer >= 0");
    if (int_member(input, "max", 1, REC_READ_LIMIT, REC_READ_DEFAULT_MAX, &max) != 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "max is an integer in 1..%d", REC_READ_LIMIT);
    char path[REC_MAX_PATH + 48];
    path_of(id, path, sizeof path);
    FILE *f = rec_fopen(path, "rb", 0);
    if (!f) return FAIL(POLYCALL_OP_ERR_NOTFOUND, "recording.unknown", "no recording %s", id);
    uint16_t major = 0, minor = 0;
    atrec_status st = atrec_read_file_header(f, &major, &minor);
    if (st != ATREC_OK) {
        fclose(f);
        if (st == ATREC_UNSUPPORTED) return FAIL(POLYCALL_OP_ERR_INPUT, "recording.unsupported", "anytune-recording %u.%u: this recorder reads 1.x", major, minor);
        return FAIL(POLYCALL_OP_ERR_INPUT, "recording.unreadable", "%s", atrec_status_text(st));
    }
    char *buf = (char *)malloc(ATREC_MAX_PAYLOAD + 1);
    if (!buf) {
        fclose(f);
        return FAIL(POLYCALL_OP_ERR_INTERNAL, "internal", "out of memory");
    }
    /* the reply's tail ({"next":…,"stop":{…}}) needs at most this much */
    const size_t reserve = 512;
    out_t o = {out, out_cap > reserve ? out_cap - reserve : 0, 0, 0};
    out_fmt(&o, "{\"recordingId\":\"%s\",\"header\":", id);
    long index = 0, returned = 0, next = -1;
    int complete = 0, have_header = 0, intact = 1;
    long stop_offset = -1;
    const char *stop_reason = NULL;
    for (;;) {
        atrec_record_type type;
        uint32_t len;
        long at = ftell(f);
        st = atrec_read_record(f, &type, buf, ATREC_MAX_PAYLOAD + 1, &len);
        if (st == ATREC_END_OF_FILE) break;
        jr_span payload;
        if (st == ATREC_OK && (jr_parse(buf, len, &payload) != 0 || (type == ATREC_RECORD_EVENTS ? payload.type != JR_ARRAY : payload.type != JR_OBJECT))) st = ATREC_MALFORMED;
        if (st == ATREC_OK && ((type == ATREC_RECORD_HEADER) == have_header || complete)) st = ATREC_MALFORMED; /* one header, first; nothing after the end */
        if (st != ATREC_OK) {
            intact = 0;
            stop_offset = at;
            stop_reason = atrec_status_text(st);
            break;
        }
        if (type == ATREC_RECORD_HEADER) {
            have_header = 1;
            out_raw(&o, buf, len);
            out_fmt(&o, ",\"from\":%ld,\"events\":[", from);
        } else if (type == ATREC_RECORD_EVENTS) {
            size_t cursor = 0;
            jr_span e;
            while (jr_next(payload, &cursor, &e) == 0) {
                if (index >= from && next < 0) {
                    size_t before = o.len;
                    if (returned >= max || o.len + e.n + 2 > o.cap) next = index;
                    else {
                        if (returned > 0) out_raw(&o, ",", 1);
                        out_raw(&o, e.p, e.n);
                        if (o.overflow) { /* cannot happen after the check above; kept as a guard */
                            o.overflow = 0;
                            o.len = before;
                            next = index;
                        } else returned++;
                    }
                }
                index++;
            }
        } else {
            complete = 1;
        }
    }
    fclose(f);
    free(buf);
    if (!have_header) return FAIL(POLYCALL_OP_ERR_INPUT, "recording.unreadable", "the recording has no readable header record");
    o.cap = out_cap; /* the reserve is for the tail */
    out_fmt(&o, "],\"next\":");
    if (next >= 0) out_fmt(&o, "%ld", next);
    else out_cstr(&o, "null");
    out_fmt(&o, ",\"total\":%ld,\"complete\":%s,\"intact\":%s,\"stop\":", index, complete ? "true" : "false", intact ? "true" : "false");
    if (stop_reason) {
        out_fmt(&o, "{\"offset\":%ld,\"reason\":", stop_offset);
        out_json_string(&o, stop_reason);
        out_cstr(&o, "}}");
    } else {
        out_cstr(&o, "null}");
    }
    if (o.overflow) return FAIL(POLYCALL_OP_ERR_INTERNAL, "internal", "the reply did not fit");
    return POLYCALL_OP_OK;
}

typedef struct {
    out_t *o;
    char reference[129];
    int filter;
    long max;
    long count;
    int truncated;
} list_state;

static int is_recording_name(const char *name) {
    if (strlen(name) != REC_ID_LEN + 6 || strcmp(name + REC_ID_LEN, ".atrec") != 0) return 0;
    for (int i = 0; i < REC_ID_LEN; i++) {
        if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f'))) return 0;
    }
    return 1;
}

static int list_one(const char *name, void *user) {
    list_state *s = (list_state *)user;
    if (!is_recording_name(name)) return 0;
    char id[REC_ID_LEN + 1], path[REC_MAX_PATH + 48];
    memcpy(id, name, REC_ID_LEN);
    id[REC_ID_LEN] = '\0';
    path_of(id, path, sizeof path);
    FILE *f = rec_fopen(path, "rb", 0);
    if (!f) return 0;
    uint16_t major, minor;
    char *buf = (char *)malloc(ATREC_MAX_PAYLOAD + 1);
    atrec_record_type type;
    uint32_t len;
    jr_span header, v, meta;
    char kind[16] = "", created[32] = "", reference[129] = "";
    long events = -1;
    int complete = 0;
    if (buf && atrec_read_file_header(f, &major, &minor) == ATREC_OK && atrec_read_record(f, &type, buf, ATREC_MAX_PAYLOAD + 1, &len) == ATREC_OK && type == ATREC_RECORD_HEADER && jr_parse(buf, len, &header) == 0) {
        if (jr_get(header, "kind", &v) == 0) jr_string(v, kind, sizeof kind);
        if (jr_get(header, "createdAt", &v) == 0) jr_string(v, created, sizeof created);
        if (jr_get(header, "meta", &meta) == 0 && jr_get(meta, "referenceId", &v) == 0) jr_string(v, reference, sizeof reference);
        /* the rest: a summary, by the END record's count — read() is what checks every record */
        while (atrec_read_record(f, &type, buf, ATREC_MAX_PAYLOAD + 1, &len) == ATREC_OK) {
            jr_span end;
            double n;
            if (type == ATREC_RECORD_END && jr_parse(buf, len, &end) == 0 && jr_get(end, "events", &v) == 0 && jr_number(v, &n) == 0) {
                complete = 1;
                events = (long)n;
            }
        }
        if (!s->filter || strcmp(reference, s->reference) == 0) {
            if (s->count >= s->max) s->truncated = 1;
            else {
                out_t *o = s->o;
                if (s->count > 0) out_raw(o, ",", 1);
                out_fmt(o, "{\"recordingId\":\"%s\",\"kind\":", id);
                out_json_string(o, kind);
                out_cstr(o, ",\"createdAt\":");
                out_json_string(o, created);
                out_cstr(o, ",\"referenceId\":");
                if (reference[0]) out_json_string(o, reference);
                else out_cstr(o, "null");
                out_fmt(o, ",\"complete\":%s,\"events\":", complete ? "true" : "false");
                if (events >= 0) out_fmt(o, "%ld}", events);
                else out_cstr(o, "null}");
                s->count++;
            }
        }
    }
    free(buf);
    fclose(f);
    return s->o->overflow ? 1 : 0;
}

static polycall_op_status_t op_list(const char *input_json, uint32_t deadline_ms, char *out, size_t out_cap, char *ec, size_t ec_cap, char *em, size_t em_cap, void *user) {
    PRELUDE();
    out_t o = {out, out_cap > 64 ? out_cap - 64 : 0, 0, 0};
    list_state s = {&o, "", 0, 0, 0, 0};
    jr_span ref;
    if (jr_get(input, "referenceId", &ref) == 0) {
        if (jr_string(ref, s.reference, sizeof s.reference) <= 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "referenceId is a string of 1-128 bytes");
        s.filter = 1;
    }
    if (int_member(input, "max", 1, REC_LIST_LIMIT, REC_LIST_DEFAULT_MAX, &s.max) != 0) return FAIL(POLYCALL_OP_ERR_INPUT, "input.invalid", "max is an integer in 1..%d", REC_LIST_LIMIT);
    out_cstr(&o, "{\"recordings\":[");
    if (rec_list_directory(g.root, list_one, &s) != 0) return FAIL(POLYCALL_OP_ERR_INTERNAL, "recording.io", "cannot read the recordings directory");
    if (o.overflow) return FAIL(POLYCALL_OP_ERR_INTERNAL, "internal", "the list did not fit: ask for fewer (max)");
    o.cap = out_cap;
    out_fmt(&o, "],\"truncated\":%s}", s.truncated ? "true" : "false");
    return POLYCALL_OP_OK;
}

/* Every operation holds the lock: the runtime serves each connection on its own thread. */
#define LOCKED(name, fn)                                                                                                                                  \
    static polycall_op_status_t name(const char *i, uint32_t d, char *o, size_t oc, char *ec, size_t ecc, char *em, size_t emc, void *u) {                \
        rec_lock();                                                                                                                                       \
        polycall_op_status_t s = fn(i, d, o, oc, ec, ecc, em, emc, u);                                                                                    \
        rec_unlock();                                                                                                                                     \
        return s;                                                                                                                                         \
    }
LOCKED(locked_create, op_create)
LOCKED(locked_append, op_append)
LOCKED(locked_finish, op_finish)
LOCKED(locked_read, op_read)
LOCKED(locked_list, op_list)

static const polycall_op_desc_t OPS[] = {
    {"recording", "create", "start an anytune-recording/1 (an attempt or a timed reference)", "{\"token\":\"string\",\"kind\":\"attempt|reference\",\"meta\":\"object\"}", "{\"recordingId\":\"string\",\"kind\":\"string\",\"createdAt\":\"string\"}", false, locked_create, NULL},
    {"recording", "append", "append timed events, in time order", "{\"token\":\"string\",\"recordingId\":\"string\",\"events\":\"[{t:number,kind:string}]\"}", "{\"appended\":\"integer\",\"events\":\"integer\"}", false, locked_append, NULL},
    {"recording", "finish", "close a recording: it is complete", "{\"token\":\"string\",\"recordingId\":\"string\"}", "{\"recordingId\":\"string\",\"events\":\"integer\",\"finishedAt\":\"string\"}", false, locked_finish, NULL},
    {"recording", "read", "replay a recording's events, in pages, with its integrity", "{\"token\":\"string\",\"recordingId\":\"string\",\"from\":\"integer?\",\"max\":\"integer?\"}", "{\"header\":\"object\",\"events\":\"array\",\"next\":\"integer|null\",\"complete\":\"boolean\",\"intact\":\"boolean\"}", true, locked_read, NULL},
    {"recording", "list", "the recordings kept, optionally of one reference", "{\"token\":\"string\",\"referenceId\":\"string?\",\"max\":\"integer?\"}", "{\"recordings\":\"array\",\"truncated\":\"boolean\"}", true, locked_list, NULL},
};

void anytune_recorder_close_all(void) {
    rec_lock();
    for (int i = 0; i < REC_MAX_OPEN; i++) {
        if (g.open[i].used) fclose(g.open[i].f);
        memset(&g.open[i], 0, sizeof g.open[i]);
    }
    rec_unlock();
}

int anytune_recorder_configure(const char *directory_utf8, const char *token) {
    if (!directory_utf8 || !token) return -1;
    size_t dir_len = strlen(directory_utf8), token_len = strlen(token);
    if (dir_len == 0 || dir_len >= REC_MAX_PATH || !rec_is_directory(directory_utf8)) return -1;
    if (token_len < ANYTUNE_RECORDER_MIN_TOKEN || token_len > ANYTUNE_RECORDER_MAX_TOKEN) return -1;
    for (size_t i = 0; i < token_len; i++) {
        if (token[i] < 0x21 || token[i] > 0x7e) return -1;
    }
    anytune_recorder_close_all();
    rec_lock();
    memcpy(g.root, directory_utf8, dir_len + 1);
    while (dir_len > 1 && (g.root[dir_len - 1] == '/' || g.root[dir_len - 1] == '\\')) g.root[--dir_len] = '\0';
    memcpy(g.token, token, token_len + 1);
    g.token_len = token_len;
    g.configured = 1;
    rec_unlock();
    return 0;
}

int anytune_recorder_register(polycall_runtime_t *rt) {
    if (!g.configured || !rt) return -1;
    for (size_t i = 0; i < sizeof OPS / sizeof OPS[0]; i++) {
        if (polycall_runtime_register(rt, &OPS[i]) != 0) return -1;
    }
    return 0;
}
