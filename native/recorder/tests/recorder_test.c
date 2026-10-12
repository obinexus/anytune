/* The recorder's C unit tests: the JSON reader on what the network may send, the format's round trip and every way a file can be damaged, and the
 * registration of the operations in a real Polycall runtime. The operations themselves are exercised end to end, through polycall.exe and its wire, by
 * tests/recording/recorder-polycall.test.ts. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(_WIN32)
#include <direct.h>
#else
#include <sys/stat.h>
#endif

#include "anytune_recorder.h"
#include "json_reader.h"
#include "platform.h"
#include "recording_format.h"

static int failures = 0;
#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
            failures++;                                                          \
        }                                                                        \
    } while (0)

static int parses(const char *s) {
    jr_span v;
    return jr_parse(s, strlen(s), &v) == 0;
}

static void test_json_reader(void) {
    /* accepted */
    CHECK(parses("{}"));
    CHECK(parses(" [1, -0.5e+3, true, false, null, \"a\\u00e9\\ud83c\\udfb8\"] "));
    CHECK(parses("{\"a\":{\"b\":[{}]}}"));
    /* refused: what is not JSON, or what a bounded reader must not follow */
    CHECK(!parses(""));
    CHECK(!parses("{"));
    CHECK(!parses("{\"a\":1,}"));
    CHECK(!parses("[01]"));
    CHECK(!parses("[1.]"));
    CHECK(!parses("[.5]"));
    CHECK(!parses("\"\\x\""));
    CHECK(!parses("\"\\udc00\""));        /* a lone low surrogate */
    CHECK(!parses("\"\\ud800x\""));       /* a high surrogate with no low one */
    CHECK(!parses("\"\xc0\xaf\""));       /* overlong UTF-8 */
    CHECK(!parses("\"\xed\xa0\x80\""));   /* an encoded surrogate */
    CHECK(!parses("\"a\nb\""));           /* a raw control character */
    CHECK(!parses("[1] [2]"));
    CHECK(!parses("NaN"));
    char deep[200];
    memset(deep, '[', 100);
    memset(deep + 100, ']', 100);
    CHECK(jr_parse(deep, 200, &(jr_span){0}) != 0); /* deeper than JR_MAX_DEPTH */

    jr_span obj, v, e;
    const char *text = "{\"t\":12.5,\"kind\":\"no\\u0074e\",\"list\":[1,{\"x\":2},\"z\"],\"k\\\"q\":true}";
    CHECK(jr_parse(text, strlen(text), &obj) == 0 && obj.type == JR_OBJECT);
    double d = 0;
    CHECK(jr_get(obj, "t", &v) == 0 && jr_number(v, &d) == 0 && d == 12.5);
    char buf[32];
    CHECK(jr_get(obj, "kind", &v) == 0 && jr_string(v, buf, sizeof buf) == 4 && strcmp(buf, "note") == 0);
    CHECK(jr_get(obj, "k\"q", &v) == 0 && v.type == JR_TRUE);
    CHECK(jr_get(obj, "absent", &v) == 1);
    CHECK(jr_get(obj, "list", &v) == 0 && v.type == JR_ARRAY);
    size_t cursor = 0;
    int count = 0;
    while (jr_next(v, &cursor, &e) == 0) count++;
    CHECK(count == 3);
    CHECK(jr_string(v, buf, sizeof buf) == -1);              /* not a string */
    jr_span s;
    CHECK(jr_parse("\"\\u0000\"", 8, &s) == 0 && jr_string(s, buf, sizeof buf) == -1); /* a NUL cannot live in a C string */
    CHECK(jr_parse("\"abcdef\"", 8, &s) == 0 && jr_string(s, buf, 4) == -1);           /* too long for the buffer */
    CHECK(jr_parse("1e400", 5, &s) == 0 && jr_number(s, &d) == -1);                   /* not finite */
    CHECK(jr_parse("0.1", 3, &s) == 0 && jr_number(s, &d) == 0 && d == 0.1);          /* correctly rounded */
}

static FILE *temp_file(const char *dir, const char *name, char *path, size_t cap) {
    snprintf(path, cap, "%s/%s", dir, name);
    return rec_fopen(path, "w+b", 0);
}

static void test_format(const char *dir) {
    char path[1024];
    FILE *f = temp_file(dir, "format.atrec", path, sizeof path);
    CHECK(f != NULL);
    if (!f) return;
    const char *header = "{\"format\":\"anytune-recording\"}";
    const char *events = "[{\"t\":0,\"kind\":\"onset\"}]";
    CHECK(atrec_write_file_header(f) == ATREC_OK);
    CHECK(atrec_write_record(f, ATREC_RECORD_HEADER, header, (uint32_t)strlen(header)) == ATREC_OK);
    CHECK(atrec_write_record(f, ATREC_RECORD_EVENTS, events, (uint32_t)strlen(events)) == ATREC_OK);
    long size = ftell(f);
    CHECK(size == 16 + 12 + (long)strlen(header) + 12 + (long)strlen(events));

    /* read back: the same records, then a clean end */
    rewind(f);
    uint16_t major = 0, minor = 0;
    char buf[256];
    atrec_record_type type;
    uint32_t len;
    CHECK(atrec_read_file_header(f, &major, &minor) == ATREC_OK && major == 1 && minor == 0);
    CHECK(atrec_read_record(f, &type, buf, sizeof buf, &len) == ATREC_OK && type == ATREC_RECORD_HEADER && strcmp(buf, header) == 0);
    CHECK(atrec_read_record(f, &type, buf, sizeof buf, &len) == ATREC_OK && type == ATREC_RECORD_EVENTS && strcmp(buf, events) == 0);
    CHECK(atrec_read_record(f, &type, buf, sizeof buf, &len) == ATREC_END_OF_FILE);

    /* damage, one byte at a time: every kind is caught, and the reader is left at the damaged record's start */
    unsigned char *all = (unsigned char *)malloc((size_t)size);
    rewind(f);
    CHECK(fread(all, 1, (size_t)size, f) == (size_t)size);
    long second = 16 + 12 + (long)strlen(header);
    struct { long at; unsigned char xor; atrec_status expected; } cases[] = {
        {second + 12 + 3, 0x01, ATREC_BAD_CHECKSUM}, /* a payload byte */
        {second + 0, 0x02, ATREC_MALFORMED},         /* the type: 2 becomes 0, which no record is */
        {second + 1, 0x01, ATREC_MALFORMED},         /* a reserved byte */
        {second + 4, 0x01, ATREC_TORN},              /* the length, one more than written */
        {second + 9, 0x10, ATREC_BAD_CHECKSUM},      /* the CRC itself */
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        unsigned char *copy = (unsigned char *)malloc((size_t)size);
        memcpy(copy, all, (size_t)size);
        copy[cases[i].at] ^= cases[i].xor;
        rewind(f);
        CHECK(fwrite(copy, 1, (size_t)size, f) == (size_t)size);
        fflush(f);
        rewind(f);
        CHECK(atrec_read_file_header(f, &major, &minor) == ATREC_OK);
        CHECK(atrec_read_record(f, &type, buf, sizeof buf, &len) == ATREC_OK);
        atrec_status st = atrec_read_record(f, &type, buf, sizeof buf, &len);
        if (st != cases[i].expected) fprintf(stderr, "  case %zu: %s, expected %s\n", i, atrec_status_text(st), atrec_status_text(cases[i].expected));
        CHECK(st == cases[i].expected);
        CHECK(ftell(f) == second);
        free(copy);
    }
    free(all);
    fclose(f);

    /* a torn tail: the file cut inside the last record's payload */
    f = temp_file(dir, "torn.atrec", path, sizeof path);
    atrec_write_file_header(f);
    atrec_write_record(f, ATREC_RECORD_HEADER, header, (uint32_t)strlen(header));
    fwrite("\x02\0\0\0\x40\0\0\0\0\0\0\0[{\"t\"", 1, 17, f);
    rewind(f);
    atrec_read_file_header(f, &major, &minor);
    CHECK(atrec_read_record(f, &type, buf, sizeof buf, &len) == ATREC_OK);
    CHECK(atrec_read_record(f, &type, buf, sizeof buf, &len) == ATREC_TORN);
    fclose(f);

    /* not this format; a future major version */
    f = temp_file(dir, "other.atrec", path, sizeof path);
    fwrite("MThd\0\0\0\6\0\1\0\1\1\xe0\0\0", 1, 16, f);
    rewind(f);
    CHECK(atrec_read_file_header(f, &major, &minor) == ATREC_NOT_A_RECORDING);
    fclose(f);
    f = temp_file(dir, "future.atrec", path, sizeof path);
    unsigned char future[16];
    memcpy(future, ATREC_SIGNATURE, 8);
    memcpy(future + 8, "\x02\0\0\0\0\0\0\0", 8);
    fwrite(future, 1, 16, f);
    rewind(f);
    CHECK(atrec_read_file_header(f, &major, &minor) == ATREC_UNSUPPORTED && major == 2);
    fclose(f);

    CHECK(atrec_crc32(0, "123456789", 9) == 0xcbf43926u); /* CRC-32/ISO-HDLC's check value */
}

static void test_registration(const char *dir) {
    CHECK(anytune_recorder_configure(dir, "short") == -1);                                  /* a token under 32 characters */
    CHECK(anytune_recorder_configure(dir, "0123456789abcdef0123456789abcde\x01") == -1);    /* not printable */
    CHECK(anytune_recorder_configure("Z:/no/such/directory/here", "0123456789abcdef0123456789abcdef") == -1);
    polycall_runtime_t *rt = polycall_runtime_create();
    CHECK(rt != NULL);
    CHECK(anytune_recorder_configure(dir, "0123456789abcdef0123456789abcdef") == 0);
    CHECK(anytune_recorder_register(rt) == 0);
    CHECK(anytune_recorder_register(rt) == -1); /* recording.create twice: Polycall refuses a duplicate */
    polycall_runtime_destroy(rt);
}

int main(int argc, char **argv) {
    const char *dir = argc > 1 ? argv[1] : ".";
#if defined(_WIN32)
    _mkdir(dir);
#else
    mkdir(dir, 0700);
#endif
    test_json_reader();
    test_format(dir);
    test_registration(dir);
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("recorder_test: all checks passed\n");
    return 0;
}
