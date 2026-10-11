#include "json_reader.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const char *s;
    size_t n;
    size_t at;
} cursor;

static void skip_ws(cursor *c) {
    while (c->at < c->n && (c->s[c->at] == ' ' || c->s[c->at] == '\t' || c->s[c->at] == '\n' || c->s[c->at] == '\r')) c->at++;
}

static int literal(cursor *c, const char *word) {
    size_t len = strlen(word);
    if (c->n - c->at < len || memcmp(c->s + c->at, word, len) != 0) return -1;
    c->at += len;
    return 0;
}

static int hex4(const char *p, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char ch = p[i];
        v <<= 4;
        if (ch >= '0' && ch <= '9') v |= (unsigned)(ch - '0');
        else if (ch >= 'a' && ch <= 'f') v |= (unsigned)(ch - 'a' + 10);
        else if (ch >= 'A' && ch <= 'F') v |= (unsigned)(ch - 'A' + 10);
        else return -1;
    }
    *out = v;
    return 0;
}

/* Checks UTF-8 well-formedness of one code point starting at s[at]; returns its byte length or -1. */
static int utf8_len(const unsigned char *s, size_t n, size_t at) {
    unsigned char b = s[at];
    if (b < 0x80) return 1;
    int len;
    unsigned cp;
    if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07; }
    else return -1;
    if (n - at < (size_t)len) return -1;
    for (int i = 1; i < len; i++) {
        if ((s[at + i] & 0xc0) != 0x80) return -1;
        cp = (cp << 6) | (s[at + i] & 0x3f);
    }
    if ((len == 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (len == 4 && (cp < 0x10000 || cp > 0x10ffff))) return -1;
    return len;
}

static int parse_string(cursor *c) {
    if (c->at >= c->n || c->s[c->at] != '"') return -1;
    c->at++;
    while (c->at < c->n) {
        unsigned char ch = (unsigned char)c->s[c->at];
        if (ch == '"') {
            c->at++;
            return 0;
        }
        if (ch < 0x20) return -1;
        if (ch == '\\') {
            if (c->n - c->at < 2) return -1;
            char e = c->s[c->at + 1];
            if (e == 'u') {
                unsigned v;
                if (c->n - c->at < 6 || hex4(c->s + c->at + 2, &v) != 0) return -1;
                c->at += 6;
                if (v >= 0xdc00 && v <= 0xdfff) return -1; /* a lone low surrogate */
                if (v >= 0xd800 && v <= 0xdbff) {
                    unsigned low;
                    if (c->n - c->at < 6 || c->s[c->at] != '\\' || c->s[c->at + 1] != 'u' || hex4(c->s + c->at + 2, &low) != 0 || low < 0xdc00 || low > 0xdfff) return -1;
                    c->at += 6;
                }
                continue;
            }
            if (!strchr("\"\\/bfnrt", e) || e == '\0') return -1;
            c->at += 2;
            continue;
        }
        int len = utf8_len((const unsigned char *)c->s, c->n, c->at);
        if (len < 0) return -1;
        c->at += (size_t)len;
    }
    return -1;
}

static int parse_number(cursor *c) {
    size_t start = c->at;
    if (c->at < c->n && c->s[c->at] == '-') c->at++;
    if (c->at >= c->n) return -1;
    if (c->s[c->at] == '0') c->at++;
    else if (c->s[c->at] >= '1' && c->s[c->at] <= '9') while (c->at < c->n && c->s[c->at] >= '0' && c->s[c->at] <= '9') c->at++;
    else return -1;
    if (c->at < c->n && c->s[c->at] == '.') {
        c->at++;
        if (c->at >= c->n || c->s[c->at] < '0' || c->s[c->at] > '9') return -1;
        while (c->at < c->n && c->s[c->at] >= '0' && c->s[c->at] <= '9') c->at++;
    }
    if (c->at < c->n && (c->s[c->at] == 'e' || c->s[c->at] == 'E')) {
        c->at++;
        if (c->at < c->n && (c->s[c->at] == '+' || c->s[c->at] == '-')) c->at++;
        if (c->at >= c->n || c->s[c->at] < '0' || c->s[c->at] > '9') return -1;
        while (c->at < c->n && c->s[c->at] >= '0' && c->s[c->at] <= '9') c->at++;
    }
    return c->at > start ? 0 : -1;
}

static int parse_value(cursor *c, int depth, jr_type *type) {
    if (depth > JR_MAX_DEPTH) return -1;
    skip_ws(c);
    if (c->at >= c->n) return -1;
    char ch = c->s[c->at];
    if (ch == '{') {
        *type = JR_OBJECT;
        c->at++;
        skip_ws(c);
        if (c->at < c->n && c->s[c->at] == '}') { c->at++; return 0; }
        for (;;) {
            jr_type t;
            skip_ws(c);
            if (parse_string(c) != 0) return -1;
            skip_ws(c);
            if (c->at >= c->n || c->s[c->at] != ':') return -1;
            c->at++;
            if (parse_value(c, depth + 1, &t) != 0) return -1;
            skip_ws(c);
            if (c->at >= c->n) return -1;
            if (c->s[c->at] == ',') { c->at++; continue; }
            if (c->s[c->at] == '}') { c->at++; return 0; }
            return -1;
        }
    }
    if (ch == '[') {
        *type = JR_ARRAY;
        c->at++;
        skip_ws(c);
        if (c->at < c->n && c->s[c->at] == ']') { c->at++; return 0; }
        for (;;) {
            jr_type t;
            if (parse_value(c, depth + 1, &t) != 0) return -1;
            skip_ws(c);
            if (c->at >= c->n) return -1;
            if (c->s[c->at] == ',') { c->at++; continue; }
            if (c->s[c->at] == ']') { c->at++; return 0; }
            return -1;
        }
    }
    if (ch == '"') { *type = JR_STRING; return parse_string(c); }
    if (ch == 't') { *type = JR_TRUE; return literal(c, "true"); }
    if (ch == 'f') { *type = JR_FALSE; return literal(c, "false"); }
    if (ch == 'n') { *type = JR_NULL; return literal(c, "null"); }
    *type = JR_NUMBER;
    return parse_number(c);
}

/* One value at the cursor, as a span (the cursor's text has already been validated, or is being). */
static int span_at(cursor *c, int depth, jr_span *out) {
    skip_ws(c);
    size_t start = c->at;
    jr_type type;
    if (parse_value(c, depth, &type) != 0) return -1;
    out->p = c->s + start;
    out->n = c->at - start;
    out->type = type;
    return 0;
}

int jr_parse(const char *s, size_t n, jr_span *out) {
    if (!s || !out) return -1;
    cursor c = {s, n, 0};
    if (span_at(&c, 0, out) != 0) return -1;
    skip_ws(&c);
    return c.at == n ? 0 : -1;
}

long jr_string(jr_span str, char *buf, size_t cap) {
    if (str.type != JR_STRING || str.n < 2 || cap == 0) return -1;
    size_t out = 0;
    for (size_t i = 1; i + 1 < str.n;) {
        char ch = str.p[i];
        unsigned cp;
        if (ch != '\\') {
            if (out + 1 >= cap) return -1;
            buf[out++] = ch;
            i++;
            continue;
        }
        char e = str.p[i + 1];
        i += 2;
        switch (e) {
            case '"': cp = '"'; break;
            case '\\': cp = '\\'; break;
            case '/': cp = '/'; break;
            case 'b': cp = '\b'; break;
            case 'f': cp = '\f'; break;
            case 'n': cp = '\n'; break;
            case 'r': cp = '\r'; break;
            case 't': cp = '\t'; break;
            case 'u':
                if (hex4(str.p + i, &cp) != 0) return -1;
                i += 4;
                if (cp >= 0xd800 && cp <= 0xdbff) {
                    unsigned low;
                    if (hex4(str.p + i + 2, &low) != 0) return -1;
                    i += 6;
                    cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                }
                break;
            default: return -1;
        }
        unsigned char enc[4];
        int len;
        if (cp < 0x80) { enc[0] = (unsigned char)cp; len = 1; }
        else if (cp < 0x800) { enc[0] = (unsigned char)(0xc0 | (cp >> 6)); enc[1] = (unsigned char)(0x80 | (cp & 0x3f)); len = 2; }
        else if (cp < 0x10000) { enc[0] = (unsigned char)(0xe0 | (cp >> 12)); enc[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3f)); enc[2] = (unsigned char)(0x80 | (cp & 0x3f)); len = 3; }
        else { enc[0] = (unsigned char)(0xf0 | (cp >> 18)); enc[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3f)); enc[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3f)); enc[3] = (unsigned char)(0x80 | (cp & 0x3f)); len = 4; }
        if (cp == 0) return -1; /* a NUL inside a string would end it early in C */
        if (out + (size_t)len >= cap) return -1;
        memcpy(buf + out, enc, (size_t)len);
        out += (size_t)len;
    }
    buf[out] = '\0';
    return (long)out;
}

int jr_get(jr_span obj, const char *key, jr_span *out) {
    if (obj.type != JR_OBJECT) return -1;
    cursor c = {obj.p, obj.n, 1};
    skip_ws(&c);
    if (c.at < c.n && c.s[c.at] == '}') return 1;
    for (;;) {
        jr_span k, v;
        char name[128];
        if (span_at(&c, 1, &k) != 0 || k.type != JR_STRING) return -1;
        skip_ws(&c);
        c.at++; /* ':' — validated by jr_parse */
        if (span_at(&c, 1, &v) != 0) return -1;
        if (jr_string(k, name, sizeof name) >= 0 && strcmp(name, key) == 0) {
            *out = v;
            return 0;
        }
        skip_ws(&c);
        if (c.at >= c.n || c.s[c.at] != ',') return 1;
        c.at++;
    }
}

int jr_next(jr_span arr, size_t *cursor_at, jr_span *element) {
    if (arr.type != JR_ARRAY) return -1;
    cursor c = {arr.p, arr.n, *cursor_at == 0 ? 1 : *cursor_at};
    skip_ws(&c);
    if (c.at >= c.n || c.s[c.at] == ']') return 1;
    if (c.s[c.at] == ',') c.at++;
    if (span_at(&c, 1, element) != 0) return -1;
    *cursor_at = c.at;
    return 0;
}

int jr_number(jr_span num, double *out) {
    if (num.type != JR_NUMBER || num.n == 0 || num.n > 63) return -1;
    /* strtod is correctly rounded, so a time read here compares as JavaScript compares it. Its decimal point is the C locale's: neither the Polycall
     * host nor the Android bridge calls setlocale, and the grammar was checked by jr_parse (a '.' only). */
    char text[64];
    memcpy(text, num.p, num.n);
    text[num.n] = '\0';
    char *end = NULL;
    double value = strtod(text, &end);
    if (end != text + num.n || !isfinite(value)) return -1;
    *out = value;
    return 0;
}
