#include "platform.h"

#include <string.h>
#include <time.h>

#if defined(_WIN32)
#include <windows.h>
#include <bcrypt.h>
#include <io.h>

static SRWLOCK lock = SRWLOCK_INIT;
void rec_lock(void) { AcquireSRWLockExclusive(&lock); }
void rec_unlock(void) { ReleaseSRWLockExclusive(&lock); }

int rec_random(unsigned char *out, size_t n) {
    return BCryptGenRandom(NULL, out, (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 ? 0 : -1;
}

static wchar_t *wide(const char *utf8) {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, NULL, 0);
    if (n <= 0) return NULL;
    wchar_t *w = (wchar_t *)malloc((size_t)n * sizeof(wchar_t));
    if (w && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8, -1, w, n) <= 0) {
        free(w);
        return NULL;
    }
    return w;
}

FILE *rec_fopen(const char *path_utf8, const char *mode, int exclusive) {
    wchar_t *wpath = wide(path_utf8);
    wchar_t wmode[8];
    size_t i = 0;
    for (; mode[i] && i < 5; i++) wmode[i] = (wchar_t)mode[i];
    if (exclusive) wmode[i++] = L'x';
    wmode[i] = 0;
    FILE *f = wpath ? _wfopen(wpath, wmode) : NULL;
    free(wpath);
    return f;
}

int rec_fsync(FILE *f) { return (fflush(f) == 0 && _commit(_fileno(f)) == 0) ? 0 : -1; }

int rec_is_directory(const char *path_utf8) {
    wchar_t *w = wide(path_utf8);
    DWORD attributes = w ? GetFileAttributesW(w) : INVALID_FILE_ATTRIBUTES;
    free(w);
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

int rec_list_directory(const char *path_utf8, int (*visit)(const char *, void *), void *user) {
    size_t len = strlen(path_utf8);
    char *pattern = (char *)malloc(len + 3);
    if (!pattern) return -1;
    memcpy(pattern, path_utf8, len);
    memcpy(pattern + len, "\\*", 3);
    wchar_t *w = wide(pattern);
    free(pattern);
    if (!w) return -1;
    WIN32_FIND_DATAW data;
    HANDLE h = FindFirstFileW(w, &data);
    free(w);
    if (h == INVALID_HANDLE_VALUE) return -1;
    do {
        char name[MAX_PATH * 4];
        if (WideCharToMultiByte(CP_UTF8, 0, data.cFileName, -1, name, (int)sizeof name, NULL, NULL) > 0 && visit(name, user) != 0) break;
    } while (FindNextFileW(h, &data));
    FindClose(h);
    return 0;
}

void rec_utc_now(char *buf, size_t cap) {
    time_t now = time(NULL);
    struct tm t;
    gmtime_s(&t, &now);
    strftime(buf, cap, "%Y-%m-%dT%H:%M:%SZ", &t);
}

#else
#include <dirent.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
void rec_lock(void) { pthread_mutex_lock(&lock); }
void rec_unlock(void) { pthread_mutex_unlock(&lock); }

int rec_random(unsigned char *out, size_t n) {
#if defined(__ANDROID__) || defined(__APPLE__) || defined(__OpenBSD__) || defined(__FreeBSD__)
    arc4random_buf(out, n); /* bionic and the BSDs: seeded from the kernel's CSPRNG, cannot fail */
    return 0;
#else
    FILE *r = fopen("/dev/urandom", "rb");
    if (!r) return -1;
    size_t got = fread(out, 1, n, r);
    fclose(r);
    return got == n ? 0 : -1;
#endif
}

FILE *rec_fopen(const char *path_utf8, const char *mode, int exclusive) {
    if (!exclusive) return fopen(path_utf8, mode);
    int fd = open(path_utf8, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0) return NULL;
    FILE *f = fdopen(fd, mode);
    if (!f) close(fd);
    return f;
}

int rec_fsync(FILE *f) { return (fflush(f) == 0 && fsync(fileno(f)) == 0) ? 0 : -1; }

int rec_is_directory(const char *path_utf8) {
    struct stat s;
    return stat(path_utf8, &s) == 0 && S_ISDIR(s.st_mode);
}

int rec_list_directory(const char *path_utf8, int (*visit)(const char *, void *), void *user) {
    DIR *d = opendir(path_utf8);
    if (!d) return -1;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (visit(e->d_name, user) != 0) break;
    }
    closedir(d);
    return 0;
}

void rec_utc_now(char *buf, size_t cap) {
    time_t now = time(NULL);
    struct tm t;
    gmtime_r(&now, &t);
    strftime(buf, cap, "%Y-%m-%dT%H:%M:%SZ", &t);
}
#endif
