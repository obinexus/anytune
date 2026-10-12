/*
 * anytune-recording/1 — AnyTune's own recording format (docs/RECORDING.md). A file is a 16-byte file header, then records:
 *
 *   file header   signature 89 41 54 52 0D 0A 1A 0A ("\x89ATR\r\n\x1a\n")   version major u16 LE = 1   version minor u16 LE = 0   reserved u32 = 0
 *   record        type u8   reserved u8[3] = 0   payload_len u32 LE (≤ 1 MiB)   crc32 u32 LE   payload (UTF-8 JSON)
 *
 * The CRC (CRC-32/ISO-HDLC) covers the record's first 8 bytes (type, reserved, length) and its payload, so a flipped type or length is caught as surely as
 * a flipped payload byte. The first record is the HEADER, exactly once; then EVENTS records; an END record closes a finished recording, and nothing follows
 * it. A reader stops at the first record that does not hold, keeps what came before it, and says where and why: a recording cut short by a crash is read
 * as far as it was written, and reported incomplete — never repaired, never guessed.
 */
#ifndef ANYTUNE_RECORDING_FORMAT_H
#define ANYTUNE_RECORDING_FORMAT_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define ATREC_SIGNATURE_LEN 8
#define ATREC_FILE_HEADER_LEN 16
#define ATREC_RECORD_HEADER_LEN 12
#define ATREC_VERSION_MAJOR 1
#define ATREC_VERSION_MINOR 0
#define ATREC_MAX_PAYLOAD (1u << 20)

extern const unsigned char ATREC_SIGNATURE[ATREC_SIGNATURE_LEN];

typedef enum { ATREC_RECORD_HEADER = 1, ATREC_RECORD_EVENTS = 2, ATREC_RECORD_END = 3 } atrec_record_type;

typedef enum {
    ATREC_OK = 0,
    ATREC_END_OF_FILE,     /* a clean end: no byte after the last record */
    ATREC_TORN,            /* a header or payload cut short: a write that did not finish */
    ATREC_BAD_CHECKSUM,    /* the CRC does not hold */
    ATREC_MALFORMED,       /* reserved bytes set, an unknown type, a record out of place */
    ATREC_TOO_LARGE,       /* a payload over 1 MiB, or over the caller's buffer */
    ATREC_NOT_A_RECORDING, /* the signature is not this format's */
    ATREC_UNSUPPORTED,     /* a major version this reader does not read */
    ATREC_IO
} atrec_status;

const char *atrec_status_text(atrec_status status);

uint32_t atrec_crc32(uint32_t crc, const void *data, size_t n);

/* Writes the 16-byte file header. */
atrec_status atrec_write_file_header(FILE *f);
/* Appends one record and flushes it to the operating system (fsync is the caller's, at the points it chooses). */
atrec_status atrec_write_record(FILE *f, atrec_record_type type, const char *payload, uint32_t len);

/* Reads and checks the file header; the version found is returned even when unsupported. */
atrec_status atrec_read_file_header(FILE *f, uint16_t *major, uint16_t *minor);
/* Reads the record at the file position into buf (NUL-terminated, cap ≥ len + 1). On any status but ATREC_OK the position is left at the record's start. */
atrec_status atrec_read_record(FILE *f, atrec_record_type *type, char *buf, uint32_t cap, uint32_t *len);

#endif
