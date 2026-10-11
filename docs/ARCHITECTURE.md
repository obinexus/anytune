# Architecture

AnyTune helps a learner play a song: choose it, tune, listen, practise it slowly and in loops, see what to repeat, and repeat. The code keeps
four things apart, so each can change without the others:

- **what is musically true**: pitch, tuning, MIDI, the reference, the guitar, assessment;
- **where sound comes from**: a microphone, a recording, a simulation;
- **how it is shown**: the `.obix` UI;
- **how the parts written in different languages reach each other**: Polycall, and nothing else.

## The processes

```
 Phone (the Android app)                                          Desktop (the import worker, services/import-worker)
 ┌──────────────────────────────────────────────────────┐         ┌──────────────────────────────────────────────────────────┐
 │ WebView: AnyTune's page (TypeScript + .obix)         │         │ Node: file or permitted URL ─yt-dlp─► media ─FFmpeg─►    │
 │   tuner · library · practice · live analysis         │         │   PCM ─Basic Pitch─► notes ─► MIDI + anytune-reference/1 │
 │   AudioWorklet capture, Web Audio playback           │         │                    │                                     │
 │        │ AnyTuneAndroid.recording(op, json)          │         │                    ▼ polycall_rpc v1 over 127.0.0.1      │
 │        ▼                                             │         │   polycall.exe start --load anytune_recorder.dll         │
 │ Kotlin (adds the session token) ─JNI─► C bridge      │         │     └─ recording.* (AnyTune's recorder module, C)        │
 │        ▼ polycall_call (Binding ABI v1)              │         └──────────────────────────────────────────────────────────┘
 │ libpolycall.so: in-process runtime on 127.0.0.1      │
 │   └─ recording.* (AnyTune's recorder module, C)      │          A MIDI file made on the desktop is opened in the app's
 │        ▼                                             │          Library. There is no phone-to-worker transport yet.
 │ app-private files: <id>.atrec (anytune-recording/1)  │
 └──────────────────────────────────────────────────────┘
```

**Polycall** carries calls between AnyTune's components in different languages:

- on the phone, TypeScript → Kotlin → C, through `polycall_call`;
- on the desktop, Node → C, over `polycall_rpc v1`.

It knows nothing about music. AnyTune's own code does everything musical: the import, transcription (Basic Pitch), MIDI, analysis,
tuning, recording, playback and feedback. Polycall is pinned and audited in `docs/integration-audit.md`, and Android is described in
`docs/ANDROID.md`. **Obicall is not used anywhere.**

## The layers

`architecture.json` states the layers and what each may import, and `tools/architecture/check.ts` enforces them on every import and every
global, as a test (`npm run test:architecture`, part of `npm test`).

| Layer | Directory | What it is | May import |
|---|---|---|---|
| domain | `src/domain/` | pitch, tuning, and the ports (`PitchProvider`, `PitchFusionPort`, `Scheduler`, `InputSource`) | nothing |
| music | `src/music/` | Standard MIDI Files, the tempo-map timeline, the teaching reference (`anytune-reference/1`), chords, the guitar (tuning, open voicings with suggested fingerings, melody positions), the fretboard map | domain |
| instruments | `src/instruments/` | the tuning catalog, as data | domain |
| audio | `src/audio/` | pitch providers (simulated, recorded, microphone) and the pure YIN detector | domain |
| fusion | `src/fusion/` | inverse-variance fusion, and the simulated and recorded fusions | domain, audio |
| analysis | `src/analysis/` | the live analysis of what a learner plays: spectrum, onsets and strums, chord candidates with an open-set refusal, notes (`LiveAnalyser`) | music, audio, domain |
| lesson | `src/lesson/` | assessment (pitch and timing judged apart), feedback in words, the practice clock (count-in, tempo, loops, latency), step mode | music, domain |
| synthesis | `src/synthesis/` | the plucked-string synthesiser, used for the reference's playback and the test signals | nothing |
| import | `src/import/` | the URL policy, the import job's stages, transcription to a reference | music, domain |
| polycall | `src/polycall/` | `polycall_rpc v1` framing and replies, with no I/O | nothing |
| polycall-node | `src/polycall/node/` | the TCP transport, for Node | polycall, `node:net` |
| recording | `src/recording/` | `anytune-recording/1` (`.atrec`) and `PolycallRecorder`, the recorder's client | polycall |
| adapters | `src/adapters/` | formats kept compatible: AnyTune's own `.obr` reader and writer (`docs/OBR.md`) | domain |
| app | `src/app/` | the application without a screen: the tuning session, the journey's shell (`shell.ts`), the practice session (`practice.ts`), and every view (all formatting) | domain, instruments, music, lesson, analysis, adapters |
| components | `src/components/*.obix` | the UI: binds the views and emits intents | the app's view types, `"obix"` |
| native-harness | `src/harness/mount-native.ts` | mounts the same UI, lowered to IR, on OBIX's native runtime | `obix-runtime-browser`, never Vue |
| harness | `src/harness/` | the composition: the tuner, the shell (`shell-app.ts`), practice audio (`practice-audio.ts`), the Android recorder bridge, the browser entry; mounts on Vue (`mount.ts`) | the layers it composes, `vue` |

Apart from `polycall-node` (a loopback socket, for Node only), no layer below `harness` touches the DOM, the network or a file. Those are
given to it through ports, which is why the same code runs in the browser, in the Android WebView and in the Node tests.

## Practice, on one clock

```
microphone ─► AudioWorklet (audio thread) ─frames of 1024, each stamped with its AudioContext frame─► LiveAnalyser ─notes─► PracticeSession
                                                                                                                              │
reference notes + click ◄── Web Audio, scheduled at AudioContext times ◄── LessonClock (count-in, tempo, loop) ◄──────────────┘
```

- **One clock.** What was played and what was heard are compared on one clock: the AudioContext's. Capture is stamped with the context
  frame of each buffer's first sample, and the reference and the click are scheduled at context times. No timer stamps anything.
- **Judging from capture times.** Notes are judged from the times they were captured at, never their arrival time. A pass is judged once
  its last note can have been reported, a quarter of a second after the pass ends, because the analysis reports a note when its pitch
  settles, 140–160 ms after the onset.
- **Slower practice re-times.** A slower tempo re-times the notes; it doesn't time-stretch the sound.
- **Saving attempts.** Each attempt is saved, apart from the reference, as an `anytune-recording/1` of what was heard and every judgement,
  in time order, through Polycall. In a browser there is no recorder, and the attempt is said to be unsaved.
- **Latency.** The speaker-to-microphone delay used is the browser's own estimate, said to be one. It has not been measured on a device.
- **Leaving the page.** When the page is hidden, or the Android app leaves the foreground, practice stops and the microphone is released.

## The formats

| Format | What it holds | Where |
|---|---|---|
| Standard MIDI File + `anytune-reference/1` | the musical reference: the notes as stated, the tempo map, and the provenance (the source's and the MIDI's SHA-256, the engine and its parameters, the review state) | `src/music/` |
| `anytune-recording/1` (`.atrec`) | a learner's attempt, or a timed reference recording: a header naming the reference, events in time order, an end record, each record CRC-checked | `docs/RECORDING.md` |
| `.obr` | sensor observations (Obicall's journal), read by AnyTune's own code for compatibility and **refused as a practice reference** | `docs/OBR.md` |

MIDI and JSON are never renamed to `.obr`, and music is never written into `.obr`.

## One source, two proof paths

There are 16 components, each one `.obix` file, and no `.vue` file anywhere.

```
                          AnyTune .obix
                               │
               ┌───────────────┴────────────────┐
               ▼                                ▼
      execution path                     OBIX semantic path
   OBIX Vue frontend stages          OBIX Vue frontend → lowerVueToDop
   (tools/obix/compile.ts)           (tools/obix/trace.ts)
               │                                │
   official Vue runtime (default),    canonical obix-dop-ir/3
   or the IR on OBIX's native runtime           │
               │                                │
          browser UI                  dist/obix-ir/<Name>.obix.json
```

- **Execution.** The sources are compiled by the real OBIX Vue frontend stages and run on the **official Vue runtime**, which is the
  default:
  - in the browser through the Vite plugin (`tools/obix/vite-plugin.ts`), and in the Node tests through module hooks
    (`tools/obix/register.ts`);
  - `"obix"` resolves to an **allowlist** of Vue-compatible primitives (`tools/obix/allowlist.ts`);
  - no source is rewritten.
- **Native execution (experimental, not the default).** `Component.obix?ir` is the same file lowered to `obix-dop-ir/3`.
  - `src/harness/mount-native.ts` runs it on `obix-runtime-browser`, with no Vue in the page (`npm run dev:native`;
    `tests/build/native-build.test.ts` audits the bundle's module graph).
  - Every UI suite runs on both runtimes, the shell's included (`tests/components/shell.test.ts`).
- **Semantics.** All 16 components lower to `obix-dop-ir/3` with no deferral (`npm run trace`, `tests/obix/trace.test.ts`).
  - The journey's screens were written within what the IR expresses today: prop types written inline, `data-*` attributes rather than a
    bound class, and one event per control.
  - Each limit worked around is reproduced in `docs/OBIX-GAPS.md`.
- **The two paths agree on their sources.** The production build's `obix-runtime-manifest.json` lists every component by the SHA-256 of
  its source, and a test checks that it equals the trace's list.

## The tuner's inputs: the microphone, and the demo

The tuner composes two inputs (`src/harness/compose.ts`), each a `PitchFusionPort` that the session chooses between:

- **Microphone.** `MicrophonePitchProvider` reads getUserMedia, then Web Audio, then an AnalyserNode, taking a frame every 50 ms for the
  YIN detector, which produces a `PitchObservation`. It is fused by `InverseVarianceFusion`.
  - The browser's APIs are injected: `src/harness/browser-audio.ts` alone names them.
  - Its failures are states, said in words (`docs/MICROPHONE.md`).
- **Demo (recorded / simulated)**, the default. It plays a recording of the acceptance sequence for Standard Guitar, a recording of 440 Hz
  for Chromatic, and a simulation for the others. It needs no microphone.

The page always says which input is supplying the measurements. The microphone is asked for only when the learner presses Start. Only one
thing listens at a time: starting practice stops the tuner.

Failures (permission denied, no device, a disconnection) are **states**, never exceptions thrown at the UI. In production the microphone
needs HTTPS, because `getUserMedia` requires a secure context. The Android app serves its page from
`https://appassets.androidplatform.net`, which is one.
