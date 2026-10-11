# Recording and replay: `anytune-recording/1`

AnyTune records two kinds of timed event streams:

- **Attempts:** what was heard while a learner practised, together with the feedback given. An attempt is always linked to the reference it was played against.
- **Timed references:** a reference's notes laid out on a timeline.

The **musical reference itself stays a Standard MIDI File** plus its `anytune-reference/1` document. A recording never replaces it, and an attempt never changes it.

Recording and replay belong to **AnyTune's recorder module** (`native/recorder`, C11). Polycall makes that module reachable from every language AnyTune uses:

- **Desktop:** `polycall.exe` loads it as an operation plugin (`anytune_recorder.dll`). Node reaches it over `polycall_rpc v1` (`src/polycall/node/tcp-transport.ts`).
- **Android:** the JNI bridge registers the same operations in an in-process Polycall runtime (`apps/android`). Kotlin and the WebView reach it through `polycall_call`.

AnyTune clients use `PolycallRecorder` (`src/recording/recorder.ts`). Polycall carries the calls; the recorder decides nothing musical either. It keeps order and integrity, and gives back what it was given.

## The format

The format's identity is the file signature plus a version, `anytune-recording` 1.0. Files are named `<recordingId>.atrec`. It is not `.obr` and is never called `.obr` (`docs/OBR.md`).

### File header (16 bytes)

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 8 | signature | `89 41 54 52 0D 0A 1A 0A` (`\x89ATR\r\n\x1a\n`): a text-mode or line-ending conversion breaks it visibly |
| 8 | 2 | major version | 1, u16 little-endian. A reader refuses any other major version. |
| 10 | 2 | minor version | 0, u16 little-endian. A later minor version may add fields to the JSON payloads, but not new record types. |
| 12 | 4 | reserved | 0 |

### Records

Every record has this layout:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | type: 1 HEADER, 2 EVENTS, 3 END |
| 1 | 3 | reserved, 0 |
| 4 | 4 | payload length, u32 little-endian, at most 1 MiB |
| 8 | 4 | CRC-32/ISO-HDLC of bytes 0–7 **and** the payload, u32 little-endian |
| 12 | n | payload: UTF-8 JSON |

The record types follow strict rules:

- **HEADER:** comes first, exactly once.
- **EVENTS:** any number may follow. Each holds a JSON array of events.
- **END:** closes a finished recording. Nothing may follow it.

The JSON payloads:

- **HEADER:** `{"format":"anytune-recording","version":"1.0","recordingId","kind":"attempt"|"reference","createdAt","meta":{…}}`. `createdAt` is wall-clock UTC and is metadata only; no timing is ever derived from it. An attempt's `meta.referenceId` is required.
- **EVENTS:** `[{"t":<seconds>,"kind":<string>, …}, …]`:
  - `t` is a number ≥ 0 on the recording's own clock, and never decreases across the whole recording.
  - `kind` is 1–32 bytes.
  - All other fields belong to the event.
- **END:** `{"events":<count>,"lastT":<seconds>|null,"finishedAt"}`.

### Integrity

A reader stops at the first record that doesn't hold. It keeps everything before that record, and reports where it stopped and why:

| Reason | Meaning |
|---|---|
| `a record cut short` | a header or payload is incomplete: a write that didn't finish |
| `a record whose CRC does not hold` | a flipped bit in the type, the length or the payload |
| `a malformed record` | reserved bytes set; an unknown type; a record out of place; a payload that isn't the JSON its type requires; time going backwards |
| `a record too large` | a payload over 1 MiB |

Some consequences:

- **A crash or power loss** leaves a recording readable up to the last record written. It is reported `complete: false` and `intact: false`. It is never repaired, guessed at or silently truncated.
- **Durability:** `create` and `finish` call `fsync`. Each `append` is flushed to the operating system, and the CRC framing catches a write cut short.

## The operations (service `recording`)

| Operation | Input | Output | Idempotent |
|---|---|---|---|
| `create` | `{token, kind, meta}` | `{recordingId, kind, createdAt}` | no |
| `append` | `{token, recordingId, events}` (≤ 4096 events, in time order) | `{appended, events}` | no |
| `finish` | `{token, recordingId}` | `{recordingId, events, finishedAt}` | no |
| `read` | `{token, recordingId, from?, max?}` | `{recordingId, header, from, events, next, total, complete, intact, stop}` | yes |
| `list` | `{token, referenceId?, max?}` | `{recordings: [{recordingId, kind, createdAt, referenceId, complete, events}], truncated}` | yes |

`read` is paged:

- Polycall caps a reply at 64 KiB, so a page holds at most `max` events (default 500) and stops early rather than outgrow a reply.
- `next` is the index of the first event not returned, or `null` on the last page.
- `PolycallRecorder.replay` joins the pages into the whole recording, in order.

Failures come back as Polycall errors with these codes: `auth.denied`, `input.invalid`, `recording.order`, `recording.not_open`, `recording.unknown`, `recording.unreadable`, `recording.unsupported`, `recorder.busy`, `recording.io`.

## Security

Polycall's runtime authenticates no request; only its `shutdown` control takes a token. It listens on loopback, which other programs on the machine can reach. On Android, that includes other apps. So the recorder protects itself:

- **A session token on every operation.** The token is 32–128 printable characters, compared in constant time. It is given to the module at start-up:
  - Desktop: the plugin reads `ANYTUNE_RECORDER_TOKEN`.
  - Android: the bridge generates a fresh random token per session.
- **It fails closed.** Without a storage directory and a token, the plugin registers nothing, and `polycall start` exits 4.
- **Recording IDs are never paths.** An ID is 32 lowercase hex digits from the operating system's CSPRNG (`BCryptGenRandom`, `arc4random_buf`). Anything else is refused before any file is touched.
- **Untrusted input is bounded.** The recorder's JSON reader (`native/recorder/src/json_reader.c`) is strict RFC 8259 with a depth limit and UTF-8 validation. Every read stays within the span it was given.
- **No silent uploads.** Recordings stay in the directory the host gives the module.

## Tests

| Where | What |
|---|---|
| `native/recorder/tests/recorder_test.c` (ctest, run by `npm run native:recorder`) | the JSON reader on hostile input; the format's round trip and every damage; registration in a real Polycall runtime, including the duplicate refusal |
| `tests/recording/format.test.ts` | the TypeScript codec on its own: the layout byte by byte, the round trip, every stop |
| `tests/polycall/wire.test.ts` | the `polycall_rpc v1` framing |
| `tests/recording/recorder-polycall.test.ts` | **end to end through the real `polycall.exe`**: create, append, finish and replay; the token; time order; path refusal; paging under 64 KiB; and the C module and the TypeScript codec agreeing in both directions, including where and why each stops on a torn or corrupted file. Skipped, with the reason given, when the native artifacts aren't staged. |
