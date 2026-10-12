# The `.obr` journal format: compatibility only

AnyTune has **no Obicall dependency**. It doesn't bundle, link, load or run `obicall.exe`, Obicall libraries, its SDK or its recording and replay runtime. Polycall is AnyTune's only polyglot runtime (`docs/ARCHITECTURE.md`).

AnyTune can still **open** an `.obr` file. It reads the file with its own TypeScript code, says what the file holds, and refuses it as a practice reference: an `.obr` holds sensor observations, not music. AnyTune never writes music into `.obr`, and never renames MIDI or JSON to `.obr`.

## Why `.obr` can't be a practice reference

An `.obr` is a journal of sensor observations. Every observation has:

- **Units:** `unspecified`, `metres`, `metres per second` or `radians`.
- **Payload shapes:** a 1-D position, a 2-D position, a 2-D position with velocity, or a 1-D range.
- **Size limit:** at most 6 doubles of payload.

So there is no unit for a frequency, no shape for a note, and no event or attachment record. Writing notes into it would mean mislabelling them, for example as metres.

AnyTune's music lives in its own formats instead:

- **The musical reference** is a Standard MIDI File plus an `anytune-reference/1` document (`src/music/reference.ts`).
- **Recordings** (practice attempts and timed reference recordings) are `anytune-recording/1` (`docs/RECORDING.md`), written and replayed by AnyTune's recorder module, which clients reach through Polycall.

## The specification implemented

The format is the one its origin publishes: obinexus/obicall 0.1.x, `include/obicall/journal.h`, `src/core/journal.c` and `src/core/wire.c`. It was read at `ae5581a` and is unchanged at `3bc3879` (tag v0.1.2). Those sources were only read to write this description; nothing of them is in AnyTune.

A journal is a stream of records with no file header. Each record is a 40-byte little-endian header followed by the observation:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | magic | u32 | `0x4A4F5242` ("JORB"; the bytes on disk are `42 52 4F 4A`) |
| 4 | record_len | u32 | 40 + observation_len |
| 8 | observation_len | u32 | at most 4096 |
| 12 | crc32 | u32 | CRC-32/ISO-HDLC of the observation bytes |
| 16 | window_seq | u64 | |
| 24 | admitted_at_ns | i64 | |
| 32 | admission_reason | u32 | 0 admitted; 1 validation, 2 duplicate, 3 late, 4 overflow, 5 sequence regression |
| 36 | reserved | u32 | 0 |

The observation's fields come in this order, all little-endian:

1. `struct_size`, `schema_version` (u32 each).
2. `sensor_id`: 32 bytes, NUL-padded.
3. `source_boot_id`, `sequence` (u64 each).
4. `sample_time_ns`, `arrival_time_ns` (i64 each).
5. `clock_domain` (u32), `time_uncertainty_s` (f64).
6. `coordinate_frame`, `units`, `calibration_version`, `payload_shape` (u32 each).
7. `payload_count` (u32, at most 6), then that many f64.
8. `covariance_count` (u32, at most 36), then that many f64.

A reader stops at the first record that doesn't hold, and never skips past it. It leaves its offset at the start of that record, and names the stop as the specification does:

- **`malformed wire frame`:** a short header, a bad magic, a cut observation or an undecodable observation.
- **`wire frame too large`:** the lengths disagree, or the observation is over 4096 bytes.
- **`wire checksum mismatch`:** the CRC doesn't match the observation.

## What is tested

`tests/adapters/obr-journal.test.ts` checks the reader and writer against the format's own demonstration journal, `tests/fixtures/obr/demo.obr` (SHA-256 pinned):

- **The demonstration journal reads correctly:** 102 records, two sensors each restarted once, and 2-D positions in metres.
- **Torn and malformed variants:** eleven deterministic variants (`tools/obr/torn-variants.ts`) stop exactly where, and with the status, that the reference implementation recorded. Those answers are frozen in `tests/fixtures/obr/replay-oracle.json`, recorded before Obicall was removed, and never edited.
- **AnyTune's writer** reproduces `demo.obr` byte for byte. A one-bit change is caught by the CRC.
- **Refusal:** an `.obr` given as a practice reference is refused in words, and the bytes are left untouched.
