/* What the recorder needs of the operating system, on Windows and on POSIX (Android's bionic included): a lock, secure random bytes, files by UTF-8 path,
 * durable writes, the entries of a directory, and the time of day in UTC. */
#ifndef ANYTUNE_RECORDER_PLATFORM_H
#define ANYTUNE_RECORDER_PLATFORM_H

#include <stddef.h>
#include <stdio.h>

void rec_lock(void);
void rec_unlock(void);

/* n bytes from the operating system's CSPRNG. 0, or -1 when it cannot give them (the caller refuses rather than falling back). */
int rec_random(unsigned char *out, size_t n);

/* fopen with a UTF-8 path. `exclusive` creates a file that must not exist yet (and fails if it does). */
FILE *rec_fopen(const char *path_utf8, const char *mode, int exclusive);

/* Ask the operating system to write the file's data to storage. 0 or -1. */
int rec_fsync(FILE *f);

/* 1 when path_utf8 is an existing directory. */
int rec_is_directory(const char *path_utf8);

/* Call `visit` with each entry name (UTF-8) of a directory, until it returns non-zero. 0, or -1 when the directory cannot be read. */
int rec_list_directory(const char *path_utf8, int (*visit)(const char *name, void *user), void *user);

/* The current time in UTC as "YYYY-MM-DDTHH:MM:SSZ" (buf ≥ 21 bytes). */
void rec_utc_now(char *buf, size_t cap);

#endif
