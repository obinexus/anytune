/*
 * The recorder as a Polycall operation plugin, for a desktop host:
 *
 *   ANYTUNE_RECORDINGS_DIR=<dir> ANYTUNE_RECORDER_TOKEN=<32-128 chars> polycall start --endpoint 127.0.0.1:0 --load anytune_recorder.dll
 *
 * It fails closed: without an existing directory and a session token of at least 32 characters it registers nothing, and `polycall start` refuses to run
 * (exit 4) rather than serve recordings to anyone who connects. The Android app does not load this plugin: its JNI bridge configures and registers the same
 * operations in an in-process runtime (apps/android).
 */
#include <stdio.h>
#include <stdlib.h>

#include "anytune_recorder.h"

#if defined(_WIN32)
#define ANYTUNE_PLUGIN_EXPORT __declspec(dllexport)
#else
#define ANYTUNE_PLUGIN_EXPORT __attribute__((visibility("default")))
#endif

ANYTUNE_PLUGIN_EXPORT int POLYCALL_CALL polycall_ops_register(polycall_runtime_t *rt, uint32_t abi_major) {
    if (abi_major != POLYCALL_RUNTIME_ABI_VERSION) return POLYCALL_PLUGIN_ABI_MISMATCH;
    const char *dir = getenv("ANYTUNE_RECORDINGS_DIR");
    const char *token = getenv("ANYTUNE_RECORDER_TOKEN");
    if (anytune_recorder_configure(dir, token) != 0) {
        fprintf(stderr, "anytune_recorder: ANYTUNE_RECORDINGS_DIR must name an existing directory and ANYTUNE_RECORDER_TOKEN must be 32-128 printable characters\n");
        return POLYCALL_PLUGIN_ERROR;
    }
    return anytune_recorder_register(rt) == 0 ? POLYCALL_PLUGIN_OK : POLYCALL_PLUGIN_ERROR;
}
