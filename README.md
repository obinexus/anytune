# AnyTune

**Groove to any tune.** An OBINexus music-learning app. Choose a song, tune your guitar, listen to it, play along slowly, and see which
bars to repeat. AnyTune helps you learn from your mistakes until the song flows.

It is built with [OBIX](https://github.com/obinexus) (the UI, in `.obix` components) and uses
[Polycall](https://github.com/obinexus/polycall) as its only polyglot runtime. **AnyTune has no Obicall dependency.**

> **This is the MVP, on the `anytune-mvp` branch.** Each step there was verified before it was committed. The status table below says
> what is verified, what is partial, and what is not built. Nothing here claims more than it.

## What it does today

- **Home → Library → Tune → Practise → Progress.** One journey, on a phone or in a browser.
- **Tune.** The tuner, with the microphone or a demo input: the note, how many cents flat or sharp, and *Flat*, *In tune* or *Sharp* in
  words. It has heard a physical guitar (`docs/MICROPHONE.md`).
- **Library.** The app comes with Beethoven's *Für Elise* (the opening; the score is public domain, encoded for AnyTune).
  - **Open a MIDI file** and its melody becomes a song.
  - **Open an `.obr` file** and it is read and refused, because it holds sensor data, not music.
  - **A recording or a link** is turned into MIDI by the desktop import worker (see below).
- **Practise.** The melody, arranged for guitar in first position.
  - **Where to play.** Each note's suggested string and fret is shown on an enlarged fretboard and on the supplied guitar artwork.
  - **Listen first.** Hear the passage before playing it.
  - **Play along.** A count-in on the click, then the metronome and the reference, at 50 %, 75 % or 100 % of the tempo, looping any bars.
  - **Step by step.** The music waits for each note.
  - **Live feedback.** What you play is heard on the device and compared on one audio clock, with pitch and timing judged apart.
  - **Review.** How each bar went, and which bar to practise slowly next.
- **Progress.** Every attempt, listed. In the Android app each attempt is also **saved separately** from the song, through Polycall.
- **Privacy.** Microphone audio never leaves the device.

## Running it

You need **Node ≥ 26**.

```bash
git clone https://github.com/obinexus/anytune.git
cd anytune
npm ci
npm run dev
```

Open the address Vite prints (`http://localhost:5173/`) in Edge or Chrome, and press **Practise Für Elise (opening)**. In a browser,
attempts are listed but not saved: the recorder runs in the Android app and the desktop worker.

| | |
|---|---|
| **The Android app** | `npm run native:stage`, then `npm run build:android`, then `./gradlew assembleDebug` in `apps/android` (`docs/ANDROID.md`) |
| **The import worker** (desktop) | `node services/import-worker/src/cli.ts doctor`, then `node services/import-worker/src/cli.ts import --file your-recording.mp4`; open the `transcription.mid` it writes in the Library (`docs/IMPORT.md`). Import only what you may use. |
| **The checks** | `npm test` (including the UI on both runtimes, the build, and the recorder end to end through the real `polycall.exe`), `npm run typecheck`, `npm run native:verify` |
| **The UI on OBIX's native runtime** | `npm run dev:native`: the same `.obix` files, lowered to OBIX's IR, with no Vue in the page |

## Status

**Verified**

| | |
|---|---|
| The journey's UI | 16 `.obix` components, rendered and tested on the Vue runtime and on OBIX's native runtime; axe-core finds no violation on any screen (automated only) |
| Music core | Standard MIDI Files, the tempo-map timeline, and the teaching reference (`anytune-reference/1`), tested against an independent MIDI implementation |
| Guitar model | open voicings with suggested fingerings for C D E G A Am Em Dm, melody positions, and a fretboard map derived from the supplied artwork |
| Practice | count-in, metronome, tempo, bar loops, step mode, review per bar, and attempts saved in order. A practice is tested end to end as captured audio, through the real analysis and session, on both runtimes. |
| Recording | `anytune-recording/1`, written and replayed by AnyTune's recorder module (C) through Polycall: on Windows through `polycall.exe`, and on Android in-process (`docs/RECORDING.md`) |
| Polycall | built from its pinned commit and staged with SHA-256s; reproducible builds; its own ctest suite passes 16/16 (`docs/integration-audit.md`) |
| Android | the APK builds with Polycall's NDK library, 16 KB-aligned; on the emulator (API 37, x86_64), 6/6 instrumented tests pass: the recorder through Polycall, the page, the microphone grant, the camera refused |
| Import | local media → FFmpeg → Basic Pitch → MIDI + reference → review → a recording through Polycall: 4/4 end to end on a generated MP4 |
| `.obr` | AnyTune's own reader and writer, for compatibility only (`docs/OBR.md`) |
| `download-music.ps1` | corrected (`tools/windows/download-music.ps1`; the original is unchanged) |

**Partial: it works, but has not been measured on real instruments or devices**

| | |
|---|---|
| Accuracy | Note, strum and chord analysis is measured **only on synthetic plucked strings** (`docs/evaluation/`), not on a real guitar, room or phone microphone. The same holds for transcription (Basic Pitch on a synthesised MP4 of the score). No accuracy is claimed beyond those measurements. |
| Android on a device | Tested on the emulator only. The microphone permission path is verified, but **no audio has been captured on Android**: the emulator had no input device, and no phone was attached. |
| Latency | The speaker-to-microphone delay is the browser's own estimate, said to be one. Nothing has been measured or calibrated. |
| Transcriptions | The worker marks them unreviewed. But the app opens the worker's `transcription.mid` as a plain MIDI file, so that mark is **not carried into the app** (it does not read the worker's `reference.json` yet). There is no correction UI. |
| URL import | The URL policy and yt-dlp's arguments are tested, and yt-dlp is checksum-verified. No video was downloaded. |

**Not built yet**

- **Chord practice in the UI.** The chord analysis exists; practice offers melodies only.
- **Piano and electric guitar.** There are no practice profiles or MIDI-keyboard input; only the reference format names these instruments.
- **Phone to worker.** Nothing transfers files between the phone and the worker: a MIDI file is moved by hand.
- **Latency calibration.**

**Blocked on the owner**

- **Polycall's licence.** It must be settled before an APK is distributed: the repository carries two different texts.
- **Release signing.** A release needs the owner's key, which is kept out of the repository.
- **A physical Android device**, to test on.
- **Pushing `anytune-mvp`** and opening a pull request.

## How it is built

The `architecture.json` layers are enforced by a test. The details are in `docs/ARCHITECTURE.md`.

- **`src/domain`, `src/music`, `src/lesson`, `src/analysis`.** What is musically true, as pure TypeScript.
- **`src/app`.** The app without a screen: the sessions and every view.
- **`src/components`.** The `.obix` UI. It only binds views and emits intents.
- **`src/harness`.** The composition: practice audio on one AudioContext clock, and the recorder bridge.
- **`native/recorder`.** The recorder module, in C, reached through Polycall.
- **`apps/android`.** The Gradle app: a WebView, Kotlin, and a JNI bridge.
- **`services/import-worker`.** The desktop import.

| Document | About |
|---|---|
| `docs/ARCHITECTURE.md` | the processes, the layers, Polycall's place, practice on one clock, the formats, and the two OBIX proof paths |
| `docs/integration-audit.md` | every pin: Polycall, OBIX, the tools, the Android build, the supplied files, and the Obicall exclusion |
| `docs/ANDROID.md` | the app: build, security, the microphone, tests and results |
| `docs/IMPORT.md` | the import worker, its policy, and the corrected download script |
| `docs/RECORDING.md` | `anytune-recording/1` and the recorder module |
| `docs/OBR.md` | `.obr` compatibility, and why it is never a practice reference |
| `docs/OBIX-GAPS.md` | what the OBIX IR does not express yet, and how the screens are written around it |
| `docs/MICROPHONE.md`, `docs/TUNING_MODEL.md`, `docs/ACCESSIBILITY.md` | the tuner's microphone, its mathematics, and accessibility |
| `docs/evaluation/` | the synthetic measurements, generated by `tools/analysis/` |
| `docs/DEPLOYMENT.md` | the prepared (not done) web deployment |

### OBIX

AnyTune depends on the published OBIX packages, pinned to exactly 0.5.0: nine `obix-compiler-*` packages, used at build time, and four
`obix-runtime-*` packages, for the native runtime.

- **Vue is the default runtime.** OBIX's native runtime is experimental: implemented and tested on every UI suite, but not the default. The
  hybrid runtime is not implemented.
- **Vue at build time.** The Vue syntax frontend uses Vue's compiler packages at build time. The native page has no Vue runtime.

## Licence

MIT, © 2026 Nnamdi Michael Okpala / OBINexus Computing (`LICENSE`). For third-party works (Polycall, Basic Pitch, AndroidX, the guitar
artwork and others), see `THIRD_PARTY_NOTICES.md`.
