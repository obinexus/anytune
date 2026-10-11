/*
 * A strict, bounded JSON reader (RFC 8259) for the recorder's operation inputs. It never allocates: a value is a span of the input text, checked once by
 * jr_parse and then navigated (object members, array elements) and decoded (strings, numbers) on demand. Input arrives over Polycall's loopback wire from
 * another process, so it is untrusted: every read is bounded by the span's length, nesting is limited, and anything that is not JSON is refused.
 */
#ifndef ANYTUNE_JSON_READER_H
#define ANYTUNE_JSON_READER_H

#include <stddef.h>

#define JR_MAX_DEPTH 32

typedef enum { JR_NULL, JR_FALSE, JR_TRUE, JR_NUMBER, JR_STRING, JR_ARRAY, JR_OBJECT } jr_type;

typedef struct {
    const char *p; /* the value's first byte */
    size_t n;      /* its length in bytes */
    jr_type type;
} jr_span;

/* Parse exactly one JSON value spanning all of s[0..n) (surrounding whitespace allowed). 0 on success, -1 on anything else. */
int jr_parse(const char *s, size_t n, jr_span *out);

/* The member `key` of an object (keys compared after unescaping). 0 found, 1 absent, -1 not an object. */
int jr_get(jr_span object, const char *key, jr_span *out);

/* Iterate an array: start with *cursor = 0; 0 gives the next element, 1 at the end, -1 not an array. */
int jr_next(jr_span array, size_t *cursor, jr_span *element);

/* A string's unescaped UTF-8 into buf (NUL-terminated). Its length, or -1 when not a string, invalid, or too long for buf. */
long jr_string(jr_span string, char *buf, size_t cap);

/* A number as a double (locale-independent). 0, or -1 when not a number or not finite. */
int jr_number(jr_span number, double *out);

#endif
