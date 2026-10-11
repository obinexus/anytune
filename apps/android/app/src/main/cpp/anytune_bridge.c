/*
 * AnyTune's JNI bridge: the narrow native boundary of the Android app. It does three things, and nothing musical:
 *
 *   nativeStart(dir, token)                     configure AnyTune's recorder (native/recorder) with the app's recordings directory and a per-session token,
 *                                               register its operations in a Polycall runtime (libpolycall.so, Polycall 1.1.0) and serve it on 127.0.0.1,
 *                                               on an ephemeral port, on a thread of its own; returns the bound "host:port"
 *   nativeCall(service, op, input, timeoutMs)   one polycall_rpc v1 round trip through Polycall's Binding ABI (polycall_call); returns a reply envelope
 *                                               {"ok":true,"output":…} or {"ok":false,"error":{"code","message"}}, as src/polycall/wire.ts reads it
 *   nativeStop()                                stop the runtime, wait for it, close what the recorder still has open
 *
 * So Kotlin, and the WebView through Kotlin, reach the recorder through Polycall exactly as Node does on the desktop. The loopback socket is reachable by
 * other apps on the device: Polycall authenticates no request, so the recorder requires the session token on every operation (docs/RECORDING.md), and the
 * runtime's shutdown takes a second random token that never leaves this file.
 */
#include <jni.h>

#include <android/log.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "anytune_recorder.h"
#include "polycall.h"
#include "polycall_runtime.h"

#define TAG "AnyTuneBridge"

static struct {
    pthread_mutex_t lock;
    pthread_cond_t changed;
    polycall_runtime_t *rt;
    pthread_t thread;
    int running;
    int bound; /* 1 bound, -1 serve returned before binding */
    int serve_result;
    char endpoint[POLYCALL_ENDPOINT_MAX];
    char shutdown_token[65];
} B = {PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, NULL, 0, 0, 0, 0, "", ""};

static void POLYCALL_CALL on_bound(const char *endpoint, void *user) {
    (void)user;
    pthread_mutex_lock(&B.lock);
    snprintf(B.endpoint, sizeof B.endpoint, "%s", endpoint);
    B.bound = 1;
    pthread_cond_broadcast(&B.changed);
    pthread_mutex_unlock(&B.lock);
}

static void *serve(void *arg) {
    (void)arg;
    int result = polycall_runtime_serve(B.rt, "127.0.0.1", 0, B.shutdown_token, on_bound, NULL);
    pthread_mutex_lock(&B.lock);
    B.serve_result = result;
    if (B.bound == 0) B.bound = -1;
    pthread_cond_broadcast(&B.changed);
    pthread_mutex_unlock(&B.lock);
    __android_log_print(ANDROID_LOG_INFO, TAG, "polycall runtime stopped (%d)", result);
    return NULL;
}

static void throw_state(JNIEnv *env, const char *message) {
    jclass cls = (*env)->FindClass(env, "java/lang/IllegalStateException");
    if (cls) (*env)->ThrowNew(env, cls, message);
}

/* A JNI string as UTF-8 (JNI's GetStringUTFChars is "modified" UTF-8, which differs for NUL and supplementary characters: those are converted here). */
static char *utf8_of(JNIEnv *env, jstring s) {
    if (!s) return NULL;
    jsize n = (*env)->GetStringLength(env, s);
    const jchar *u = (*env)->GetStringChars(env, s, NULL);
    if (!u) return NULL;
    char *out = (char *)malloc((size_t)n * 3 + 1);
    size_t at = 0;
    for (jsize i = 0; out && i < n; i++) {
        unsigned cp = u[i];
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n && u[i + 1] >= 0xdc00 && u[i + 1] <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (u[i + 1] - 0xdc00u);
            i++;
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
            cp = 0xfffd; /* a lone surrogate is not text */
        }
        if (cp < 0x80) out[at++] = (char)cp;
        else if (cp < 0x800) { out[at++] = (char)(0xc0 | (cp >> 6)); out[at++] = (char)(0x80 | (cp & 0x3f)); }
        else if (cp < 0x10000) { out[at++] = (char)(0xe0 | (cp >> 12)); out[at++] = (char)(0x80 | ((cp >> 6) & 0x3f)); out[at++] = (char)(0x80 | (cp & 0x3f)); }
        else { out[at++] = (char)(0xf0 | (cp >> 18)); out[at++] = (char)(0x80 | ((cp >> 12) & 0x3f)); out[at++] = (char)(0x80 | ((cp >> 6) & 0x3f)); out[at++] = (char)(0x80 | (cp & 0x3f)); }
    }
    if (out) out[at] = '\0';
    (*env)->ReleaseStringChars(env, s, u);
    return out;
}

/* UTF-8 (the reply) as a Java string: decoded to UTF-16 here, for the same reason. */
static jstring string_of(JNIEnv *env, const char *s, size_t n) {
    jchar *u = (jchar *)malloc((n + 1) * sizeof(jchar));
    if (!u) return NULL;
    size_t at = 0;
    for (size_t i = 0; i < n;) {
        unsigned char b = (unsigned char)s[i];
        unsigned cp;
        int len;
        if (b < 0x80) { cp = b; len = 1; }
        else if ((b & 0xe0) == 0xc0 && i + 1 < n) { cp = ((b & 0x1fu) << 6) | (s[i + 1] & 0x3fu); len = 2; }
        else if ((b & 0xf0) == 0xe0 && i + 2 < n) { cp = ((b & 0x0fu) << 12) | ((s[i + 1] & 0x3fu) << 6) | (s[i + 2] & 0x3fu); len = 3; }
        else if ((b & 0xf8) == 0xf0 && i + 3 < n) { cp = ((b & 0x07u) << 18) | ((s[i + 1] & 0x3fu) << 12) | ((s[i + 2] & 0x3fu) << 6) | (s[i + 3] & 0x3fu); len = 4; }
        else { cp = 0xfffd; len = 1; }
        if (cp >= 0x10000) {
            cp -= 0x10000;
            u[at++] = (jchar)(0xd800 + (cp >> 10));
            u[at++] = (jchar)(0xdc00 + (cp & 0x3ff));
        } else {
            u[at++] = (jchar)cp;
        }
        i += (size_t)len;
    }
    jstring result = (*env)->NewString(env, u, (jsize)at);
    free(u);
    return result;
}

static void stop_locked_out(void) {
    /* called without the lock: stop, join, destroy */
    polycall_runtime_stop(B.rt);
    pthread_join(B.thread, NULL);
    polycall_runtime_destroy(B.rt);
    anytune_recorder_close_all();
    pthread_mutex_lock(&B.lock);
    B.rt = NULL;
    B.running = 0;
    B.bound = 0;
    B.endpoint[0] = '\0';
    pthread_mutex_unlock(&B.lock);
}

JNIEXPORT jstring JNICALL Java_org_obinexus_anytune_polycall_PolycallBridge_nativeStart(JNIEnv *env, jclass cls, jstring directory, jstring token) {
    (void)cls;
    pthread_mutex_lock(&B.lock);
    if (B.running && B.bound == 1) {
        jstring same = (*env)->NewStringUTF(env, B.endpoint);
        pthread_mutex_unlock(&B.lock);
        return same;
    }
    pthread_mutex_unlock(&B.lock);
    char *dir = utf8_of(env, directory);
    char *tok = utf8_of(env, token);
    int configured = anytune_recorder_configure(dir, tok);
    free(dir);
    free(tok);
    if (configured != 0) {
        throw_state(env, "the recorder refused its configuration: an existing directory and a token of 32-128 printable characters are needed");
        return NULL;
    }
    polycall_runtime_t *rt = polycall_runtime_create();
    if (!rt || anytune_recorder_register(rt) != 0 || polycall_runtime_set_limits(rt, 8, 10000, 2000) != 0) {
        if (rt) polycall_runtime_destroy(rt);
        throw_state(env, "the Polycall runtime could not register the recorder's operations");
        return NULL;
    }
    unsigned char random[32];
    arc4random_buf(random, sizeof random);
    pthread_mutex_lock(&B.lock);
    for (size_t i = 0; i < sizeof random; i++) snprintf(B.shutdown_token + 2 * i, 3, "%02x", random[i]);
    B.rt = rt;
    B.bound = 0;
    B.running = 1;
    if (pthread_create(&B.thread, NULL, serve, NULL) != 0) {
        B.running = 0;
        B.rt = NULL;
        pthread_mutex_unlock(&B.lock);
        polycall_runtime_destroy(rt);
        throw_state(env, "no thread for the Polycall runtime");
        return NULL;
    }
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    until.tv_sec += 5;
    while (B.bound == 0) {
        if (pthread_cond_timedwait(&B.changed, &B.lock, &until) == ETIMEDOUT) break;
    }
    int bound = B.bound;
    int serve_result = B.serve_result;
    char endpoint[POLYCALL_ENDPOINT_MAX];
    snprintf(endpoint, sizeof endpoint, "%s", B.endpoint);
    pthread_mutex_unlock(&B.lock);
    if (bound != 1) {
        stop_locked_out();
        char message[128];
        snprintf(message, sizeof message, "the Polycall runtime did not bind 127.0.0.1 (serve returned %d)", serve_result);
        throw_state(env, message);
        return NULL;
    }
    __android_log_print(ANDROID_LOG_INFO, TAG, "polycall runtime serving the recorder on %s", endpoint);
    return (*env)->NewStringUTF(env, endpoint);
}

static const char *code_of(int status) {
    switch (status) {
        case POLYCALL_E_TIMEOUT: return "deadline.exceeded";
        case POLYCALL_E_TRANSPORT: return "transport.unreachable";
        case POLYCALL_E_PROTOCOL: return "protocol.malformed";
        case POLYCALL_E_TOO_LARGE: return "protocol.too_large";
        case POLYCALL_E_INVALID_ARGUMENT: return "input.invalid";
        case POLYCALL_E_BUSY: return "server.busy";
        default: return "polycall.failed";
    }
}

/* JSON-escape a message into the envelope */
static size_t escape_into(char *out, size_t cap, const char *s) {
    size_t at = 0;
    for (; *s && at + 7 < cap; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { out[at++] = '\\'; out[at++] = (char)c; }
        else if (c < 0x20) at += (size_t)snprintf(out + at, cap - at, "\\u%04x", c);
        else out[at++] = (char)c;
    }
    out[at] = '\0';
    return at;
}

JNIEXPORT jstring JNICALL Java_org_obinexus_anytune_polycall_PolycallBridge_nativeCall(JNIEnv *env, jclass cls, jstring service, jstring operation, jstring input, jint timeoutMs) {
    (void)cls;
    pthread_mutex_lock(&B.lock);
    char endpoint[POLYCALL_ENDPOINT_MAX];
    int ready = B.running && B.bound == 1;
    snprintf(endpoint, sizeof endpoint, "%s", B.endpoint);
    pthread_mutex_unlock(&B.lock);
    if (!ready) return (*env)->NewStringUTF(env, "{\"ok\":false,\"error\":{\"code\":\"transport.unreachable\",\"message\":\"the Polycall runtime is not started\"}}");
    char *svc = utf8_of(env, service);
    char *op = utf8_of(env, operation);
    char *in = utf8_of(env, input);
    const size_t cap = POLYCALL_CALL_MAX_OUTPUT + 64;
    char *envelope = (char *)malloc(cap + 64);
    jstring result = NULL;
    if (svc && op && in && envelope) {
        const size_t prefix = 22; /* room for {"ok":false,"error": (20 bytes) */
        size_t len = 0;
        envelope[prefix] = '\0';
        int status = polycall_call(endpoint, svc, op, in, (uint32_t)(timeoutMs > 0 ? timeoutMs : 5000), envelope + prefix, cap - prefix - 2, &len);
        /* A reply came back when polycall_call wrote a JSON value: its output, or the remote error object. Polycall gives some remote errors a status
         * of their own (auth.denied -> POLYCALL_E_AUTH, operation.unknown -> E_NOT_FOUND, deadline.exceeded -> E_TIMEOUT, server.busy -> E_BUSY: its
         * src/core/ffi.c) and still writes the object; a transport failure writes nothing. So the object, not the status, says which it was. */
        int replied = status == POLYCALL_OK || (len > 0 && envelope[prefix] == '{' && status != POLYCALL_E_TOO_LARGE);
        if (replied) {
            const char *head = status == POLYCALL_OK ? "{\"ok\":true,\"output\":" : "{\"ok\":false,\"error\":";
            size_t head_len = strlen(head);
            memmove(envelope + head_len, envelope + prefix, len);
            memcpy(envelope, head, head_len);
            envelope[head_len + len] = '}';
            result = string_of(env, envelope, head_len + len + 1);
        } else {
            char detail[512], escaped[1100];
            polycall_last_error(detail, sizeof detail);
            escape_into(escaped, sizeof escaped, detail[0] ? detail : polycall_strerror(status));
            int n = snprintf(envelope, cap, "{\"ok\":false,\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}", code_of(status), escaped);
            result = string_of(env, envelope, (size_t)n);
        }
    }
    free(svc);
    free(op);
    free(in);
    free(envelope);
    if (!result) throw_state(env, "out of memory for a Polycall call");
    return result;
}

JNIEXPORT void JNICALL Java_org_obinexus_anytune_polycall_PolycallBridge_nativeStop(JNIEnv *env, jclass cls) {
    (void)env;
    (void)cls;
    pthread_mutex_lock(&B.lock);
    int running = B.running;
    pthread_mutex_unlock(&B.lock);
    if (running) stop_locked_out();
}

JNIEXPORT jstring JNICALL Java_org_obinexus_anytune_polycall_PolycallBridge_nativeVersion(JNIEnv *env, jclass cls) {
    (void)cls;
    char version[64];
    polycall_ffi_version(version, sizeof version);
    char text[128];
    snprintf(text, sizeof text, "Polycall %s, Binding ABI %d, runtime ABI %d", version, polycall_ffi_abi_version(), POLYCALL_RUNTIME_ABI_VERSION);
    return (*env)->NewStringUTF(env, text);
}
