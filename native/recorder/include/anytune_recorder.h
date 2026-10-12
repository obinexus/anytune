/*
 * AnyTune's recorder: recording and replay of timed events (a learner's attempt, or a timed reference) in AnyTune's own format, anytune-recording/1
 * (docs/RECORDING.md), offered to every language through Polycall's runtime as operations of the service "recording":
 *
 *   recording.create   {token, kind: "attempt"|"reference", meta: {...}}            -> {recordingId, kind, createdAt}
 *   recording.append   {token, recordingId, events: [{t, kind, ...}, ...]}          -> {appended, events}
 *   recording.finish   {token, recordingId}                                          -> {recordingId, events, finishedAt}
 *   recording.read     {token, recordingId, from?, max?}                             -> {recordingId, header, from, events, next, total, complete, intact, stop}
 *   recording.list     {token, referenceId?, max?}                                   -> {recordings: [...], truncated}
 *
 * Polycall's runtime does not authenticate a request (only its shutdown takes a token), and it listens on loopback, where other programs — on Android, other
 * apps — can connect. So every recorder operation requires the session token it was configured with, compared in constant time, and refuses everything
 * else with "auth.denied". Nothing musical is decided here: the recorder keeps the order and integrity of what it is given and gives it back.
 */
#ifndef ANYTUNE_RECORDER_H
#define ANYTUNE_RECORDER_H

#include "polycall_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ANYTUNE_RECORDER_MIN_TOKEN 32
#define ANYTUNE_RECORDER_MAX_TOKEN 128

/* Where recordings are kept (an existing directory, UTF-8) and the session token every operation must carry (32…128 printable ASCII characters).
 * 0, or -1 when either is not acceptable — the recorder then registers nothing. Recordings still open from an earlier configuration are closed (left
 * incomplete: they were not finished). */
int anytune_recorder_configure(const char *directory_utf8, const char *token);

/* Register the recording.* operations in a Polycall runtime. 0, or -1 when the recorder is not configured or a name is already taken. */
int anytune_recorder_register(polycall_runtime_t *rt);

/* Close every recording still open, without finishing it: each stays readable, reported incomplete. */
void anytune_recorder_close_all(void);

#ifdef __cplusplus
}
#endif

#endif
