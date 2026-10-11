# Importing music

```
local file or a permitted URL ──yt-dlp──► media ──FFmpeg──► mono PCM ──Basic Pitch──► estimated notes ──► MIDI + reference ──review──► recording (through Polycall)
```

Each step is a different tool doing a different job, and none of them does another's:

| Step | Tool | Does | Does **not** |
|---|---|---|---|
| downloading | **yt-dlp** (2026.08.19 here; checked against the release's published SHA-256) | fetch permitted media from a URL | transcribe, convert to MIDI, or get around access controls or DRM |
| decoding | **FFmpeg** / **ffprobe** (8.1.1 here) | inspect a file, and decode its audio to mono 32-bit float at 22 050 Hz | transcribe: it gives samples, not notes |
| transcribing | **Basic Pitch** (`@spotify/basic-pitch` 1.0.1, Apache-2.0, on TensorFlow.js 3.21 CPU) | estimate notes (key, onset, duration, strength) from audio | know what instrument played, or guarantee anything: every note is an estimate |
| writing MIDI and the reference | AnyTune (`src/music/`, `src/import/`) | drop the engine's octave ghosts (a documented heuristic, every drop listed), write a Standard MIDI File, make an `anytune-reference/1` that marks every note as estimated, with its confidence | change the source |
| reviewing | the learner | accept the transcription as a teaching reference | — |
| recording | AnyTune's recorder, **through Polycall** | write the timed reference recording (`anytune-recording/1`, `docs/RECORDING.md`) | rename MIDI or JSON as anything else |

A **MIDI file** skips downloading, decoding, transcription and review. Its notes are stated, not estimated, so it goes straight to the recording.

## Where it runs

URL import and transcription run in the **companion worker** (`services/import-worker`) on a desktop host:

- **Transcription needs a desktop.** It takes about 1.2 s of CPU per second of audio on the development machine.
- **yt-dlp, FFmpeg and Windows executables cannot run inside an Android app.**

Practising an imported reference needs neither the worker nor a network: the reference, its MIDI and its recording are local files.

**Not yet built:** a way for the phone to send a URL or a file to the worker, and to fetch the result. Today the worker is driven from its command line, and its library is copied to the device.

## Using the worker

```bash
npm --prefix services/import-worker ci
node services/import-worker/src/cli.ts doctor
node services/import-worker/src/cli.ts import --file furelise.mp4
node services/import-worker/src/cli.ts review --job <id> --accept
node services/import-worker/src/cli.ts import --midi song.mid
node services/import-worker/src/cli.ts import --url "https://youtu.be/<id>" --permission "I recorded this myself"
node services/import-worker/src/cli.ts playlist --url "https://www.youtube.com/playlist?list=<id>" --permission "…"
```

Notes on each command:

- **`npm --prefix services/import-worker ci`** installs the worker's own pinned dependencies.
- **`doctor`** reports the tools it found and their versions. It finds:
  - yt-dlp from `ANYTUNE_YTDLP`, or on `PATH`;
  - FFmpeg and ffprobe from `ANYTUNE_FFMPEG` and `ANYTUNE_FFPROBE`, or on `PATH`.
- **`import --file`** stops at `reviewing`, because the transcription is an estimate.
- **`review --accept`** turns the transcription into a reference, recorded through Polycall.
- **`import --url`** imports exactly one video. Run with no other flag, nothing else is imported, even when the URL names a playlist.
- **`playlist`** is a separate, deliberate action. It creates one job per video, and at most 25.

The library is `<repo>/library`, or `--library DIR`, or `ANYTUNE_LIBRARY`, and git ignores it. Each job's directory keeps:

| File | What it is |
|---|---|
| `job.json` | the job's state, rewritten atomically after every stage |
| `source.<ext>` | the media or MIDI as it came, copied, its SHA-256 checked against the original |
| `source.info.json` | for a URL: what the provider said of it, including its stated licence |
| `transcription.mid` | the engine's notes as a Standard MIDI File |
| `transcription.json` | what the engine gave, the octave ghosts dropped, and the MIDI rounding |
| `reference.json` | the teaching reference, with its provenance: the source's and the MIDI's SHA-256, and the engine with its version and parameters |

Recordings go to `<library>/recordings/`.

## Job stages

`queued → downloading (a URL) → decoding → transcribing → reviewing → recording → ready`, or `failed` / `cancelled`.

- **Failures are explicit.** A failure names its stage, a code (`media.unreadable`, `tool.missing`, `url.private-network`, `download.timeout`, …), a message, and whether retrying can help.
- **Retries resume.** `retry --job <id>` starts again at the failed stage and keeps what the earlier stages made. A failure that retrying can't mend is refused.
- **Cancellation is clean.** Ctrl-C saves the job as cancelled.

## URL policy (`src/import/url-policy.ts`)

| Rule | What it means |
|---|---|
| **Scheme** | `https` only |
| **Hosts** | YouTube and YouTube Music only |
| **URL contents** | no credentials, no explicit port |
| **Canonical URL** | only the video's id is passed on; everything else in the pasted URL is said to be left out |
| **Private networks** | the host is resolved, and the import is refused if any of its addresses is loopback, private, link-local, shared (CGNAT), multicast, reserved, unique-local or v4-mapped private |
| **Subprocesses** | an argument array, never a shell |
| **yt-dlp** | runs with: |
| | • `--ignore-config` (no user configuration) |
| | • `--no-playlist` |
| | • the limits enforced by yt-dlp itself: at most 20 minutes, at most 200 MB, no live streams |
| | • a fixed output name inside the job's directory, and the printed path checked to be inside it |
| **Timeouts** | 15 minutes to download; decoding scales with duration |
| **Permission** | a URL is imported only with the learner's declaration that they may use the media, kept with the job |
| **Access controls** | no cookies or account options, and nothing that gets around a provider's access controls or DRM |

**Not exercised against a live provider in this session.** No video was downloaded while building this. The yt-dlp arguments are unit-tested, the yt-dlp binary is checksum-verified and runs (`--version`), and the rest of the pipeline is tested end to end on a local MP4.

## Accuracy: measured, on a declared fixture only

`docs/evaluation/transcription-synthetic.md` (from `node tools/analysis/evaluate-transcription.ts`) is the measurement. The fixture is the Für Elise score rendered by a plucked-string synthesiser and encoded to MP4. Onset-only note F1 within 50 ms, after removing octave ghosts:

| | Clean | 20 dB SNR |
|---|---:|---:|
| Melody | 94.6 % | 98.6 % |
| Both hands | 85.4 % | 92.9 % |

It is synthetic: **no accuracy is claimed for recordings of people, pianos or rooms.** That needs owned or permitted recordings with known scores, which haven't been gathered.

## Tests

- `tests/import/import-policy.test.ts`: the URL policy (with the owner's example URL), private addresses, yt-dlp's and FFmpeg's arguments, the job stages, the ghost filter and the score.
- `tests/import/import-worker.test.ts`: end to end, nothing mocked. An owned `furelise.mp4` made from the score goes through real FFmpeg, real Basic Pitch and real Polycall:
  - it stops at review, then is accepted and is ready;
  - the original stays byte for byte;
  - recall is ≥ 90 % and F1 ≥ 85 % against the score;
  - a MIDI import goes straight to ready;
  - a text file renamed `.mp4` fails at decoding, not retryable;
  - a missing FFmpeg is reported, retryable.

  It is skipped, with the reason given, without the worker's dependencies, FFmpeg or the staged Polycall.

## The Windows download script

`tools/windows/download-music.ps1` is a corrected version of the owner's `C:\Tools\download-music.ps1`, which is left unchanged. What changed:

- **The URL list is a parameter** (`-InputFile`), not a fixed `.\urls.txt`.
- **The tools are found explicitly:** yt-dlp, and FFmpeg *and* ffprobe, all reported with their versions.
- **It reports truthfully:** what completed, what was already downloaded, and what failed with yt-dlp's errors. It exits 1 when anything failed.
- **Re-runs fetch only what is missing,** thanks to a download archive.
- **User configuration is ignored** (`--ignore-config`).
- **`-CheckOnly`** finds the tools and reads the list without downloading.

It is a personal library tool, separate from AnyTune's real-time audio path.
