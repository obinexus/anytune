#include "recording_format.h"

#include <string.h>

const unsigned char ATREC_SIGNATURE[ATREC_SIGNATURE_LEN] = {0x89, 'A', 'T', 'R', 0x0d, 0x0a, 0x1a, 0x0a};

const char *atrec_status_text(atrec_status status) {
    switch (status) {
        case ATREC_OK: return "ok";
        case ATREC_END_OF_FILE: return "end of file";
        case ATREC_TORN: return "a record cut short";
        case ATREC_BAD_CHECKSUM: return "a record whose CRC does not hold";
        case ATREC_MALFORMED: return "a malformed record";
        case ATREC_TOO_LARGE: return "a record too large";
        case ATREC_NOT_A_RECORDING: return "not an anytune-recording file";
        case ATREC_UNSUPPORTED: return "an unsupported version of anytune-recording";
        case ATREC_IO: return "an input/output error";
    }
    return "unknown";
}

/* Bitwise, with no table: no shared state for the runtime's connection threads to race on, and the cost is nothing beside the file I/O around it. */
uint32_t atrec_crc32(uint32_t crc, const void *data, size_t n) {
    const unsigned char *p = (const unsigned char *)data;
    crc = ~crc;
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int k = 0; k < 8; k++) crc = (crc & 1) ? 0xedb88320u ^ (crc >> 1) : crc >> 1;
    }
    return ~crc;
}

static void put_u16(unsigned char *p, uint16_t v) { p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8); }
static void put_u32(unsigned char *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (unsigned char)(v >> (8 * i)); }
static uint16_t get_u16(const unsigned char *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t get_u32(const unsigned char *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

atrec_status atrec_write_file_header(FILE *f) {
    unsigned char h[ATREC_FILE_HEADER_LEN] = {0};
    memcpy(h, ATREC_SIGNATURE, ATREC_SIGNATURE_LEN);
    put_u16(h + 8, ATREC_VERSION_MAJOR);
    put_u16(h + 10, ATREC_VERSION_MINOR);
    if (fwrite(h, 1, sizeof h, f) != sizeof h || fflush(f) != 0) return ATREC_IO;
    return ATREC_OK;
}

atrec_status atrec_write_record(FILE *f, atrec_record_type type, const char *payload, uint32_t len) {
    if (len > ATREC_MAX_PAYLOAD) return ATREC_TOO_LARGE;
    unsigned char h[ATREC_RECORD_HEADER_LEN] = {0};
    h[0] = (unsigned char)type;
    put_u32(h + 4, len);
    put_u32(h + 8, atrec_crc32(atrec_crc32(0, h, 8), payload, len));
    if (fwrite(h, 1, sizeof h, f) != sizeof h) return ATREC_IO;
    if (len > 0 && fwrite(payload, 1, len, f) != len) return ATREC_IO;
    if (fflush(f) != 0) return ATREC_IO;
    return ATREC_OK;
}

atrec_status atrec_read_file_header(FILE *f, uint16_t *major, uint16_t *minor) {
    unsigned char h[ATREC_FILE_HEADER_LEN];
    size_t n = fread(h, 1, sizeof h, f);
    if (n < ATREC_SIGNATURE_LEN || memcmp(h, ATREC_SIGNATURE, ATREC_SIGNATURE_LEN) != 0) return ATREC_NOT_A_RECORDING;
    if (n < sizeof h) return ATREC_TORN;
    *major = get_u16(h + 8);
    *minor = get_u16(h + 10);
    if (*major != ATREC_VERSION_MAJOR) return ATREC_UNSUPPORTED;
    if (get_u32(h + 12) != 0) return ATREC_MALFORMED;
    return ATREC_OK;
}

atrec_status atrec_read_record(FILE *f, atrec_record_type *type, char *buf, uint32_t cap, uint32_t *len) {
    long start = ftell(f);
    unsigned char h[ATREC_RECORD_HEADER_LEN];
    size_t n = fread(h, 1, sizeof h, f);
    atrec_status status = ATREC_OK;
    if (n == 0 && feof(f)) return ATREC_END_OF_FILE;
    if (n < sizeof h) status = ATREC_TORN;
    else if (h[1] != 0 || h[2] != 0 || h[3] != 0 || h[0] < ATREC_RECORD_HEADER || h[0] > ATREC_RECORD_END) status = ATREC_MALFORMED;
    else {
        uint32_t length = get_u32(h + 4);
        if (length > ATREC_MAX_PAYLOAD || length + 1 > cap) status = ATREC_TOO_LARGE;
        else if (fread(buf, 1, length, f) != length) status = ATREC_TORN;
        else if (atrec_crc32(atrec_crc32(0, h, 8), buf, length) != get_u32(h + 8)) status = ATREC_BAD_CHECKSUM;
        else {
            buf[length] = '\0';
            *type = (atrec_record_type)h[0];
            *len = length;
        }
    }
    if (status != ATREC_OK) fseek(f, start, SEEK_SET);
    return status;
}
