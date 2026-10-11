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
| lesson | `src/lesson/` | assessment (pitch and timing judged apart; unassessed where the capture did not cover), feedback in words, the practice clock (count-in, tempo, loops, latency), step mode, the play clock and the beat grid | music, domain |
| synthesis | `src/synthesis/` | the plucked-string synthesiser, used for the reference's playback and the test signals | nothing |
| import | `src/import/` | the URL policy, the import job's stages, transcription to a reference | music, domain |
| polycall | `src/polycall/` | `polycall_rpc v1` framing and replies, with no I/O | nothing |
| polycall-node | `src/polycall/node/` | the TCP transport, for Node | polycall, `node:net` |
| recording | `src/recording/` | `anytune-recording/1` (`.atrec`) and `PolycallRecorder`, the recorder's client | polycall |
| adapters | `src/adapters/` | formats kept compatible: AnyTune's own `.obr` reader and writer (`docs/OBR.md`) | domain |
| app | `src/app/` | the application without a screen: the tuning session, the journey's shell (`shell.ts`), the arrangement (`arrangement.ts`), the practice and play sessions (`practice.ts`, `play.ts`), the capture's coverage and the input check (`capture.ts`, `input-check.ts`), the guitar view (`guitar-view.ts`), and every view (all formatting) | domain, instruments, music, lesson, analysis, adapters |
| components | `src/components/*.obix` | the UI: binds the views and emits intents | the app's view types, `"obix"` |
| native-harness | `src/harness/mount-native.ts` | mounts the same UI, lowered to IR, on OBIX's native runtime | `obix-runtime-browser`, never Vue |
| harness | `src/harness/` | the composition: the tuner, the shell (`shell-app.ts`), the microphone (`listener.ts`), practice audio (`practice-audio.ts`), the Android recorder bridge, the browser entry (which measures the content's width for the fretboard and the timeline); mounts on Vue (`mount.ts`) | the layers it composes, `vue` |

Apart from `polycall-node` (a loopback socket, for Node only), no layer below `harness` touches the DOM, the network or a file. Those are
given to it through ports, which is why the same code runs in the browser, in the Android WebView and in the Node tests.

## The microphone: checked before anything is judged

An assessed attempt never begins because Start was pressed. The listener (`src/harness/listener.ts`), shared by Practise and Play, goes
through these states:

```
idle → requesting (the browser asks) → checking (an input meter: "pluck any string") → ready (a note was heard) → Begin → count-in → playing → review
```

Instead of ready, it may stop in one of these, each said in its own words:

- **denied:** the permission was refused;
- **no-device:** no microphone was found;
- **unreadable:** the device could not be opened;
- **unsupported:** the browser has no microphone API;
- **muted:** digital silence, raw and then with the browser's processing on;
- **disconnected:** the device ended;
- **failed:** anything else.

A faint input is a hint while checking ("only faintly, loudest −52 dBFS"), not a failure. **Play along without assessment** opens no
microphone and gives no score of any kind.

While an attempt is assessed, the capture monitor (`src/app/capture.ts`) records which capture-clock time real sound covered. These are
**not** coverage:

- digital silence: every sample below −120 dBFS;
- gaps with no frames;
- the time after the device ended.

A target whose window was not covered is **unassessed**: whatever was or was not heard there, it gets no verdict. A stall or a
disconnection is said at once, and the review says how much was assessed and what the microphone delivered. Feedback
(`src/lesson/feedback.ts`) counts only what was assessed:

- With nothing assessed, the review says "This attempt could not be assessed — check your microphone."
- A bar is recommended only when enough was assessed and something was heard.
- An onset whose pitch could not be named is **unclear**, never a mistake and never a silence.

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
- **A stop just after a loop wraps** keeps the last full pass in the review, instead of replacing it with a one-note fragment.
- **Slower practice re-times.** A slower tempo re-times the notes; it doesn't time-stretch the sound.
- **Saving attempts.** Each assessed attempt is saved, apart from the reference, as an `anytune-recording/1` of what was heard and every
  judgement, in time order, through Polycall. In a browser there is no recorder, and the attempt is said to be unsaved.
- **Latency.** The correction applied is what the browser reports, named quantity by quantity: `AudioContext.baseLatency`,
  `AudioContext.outputLatency` and the microphone track's `latency` setting. These are estimates of parts of the path, not a measured
  speaker-to-microphone delay, and they appear only in the collapsed timing details. Nothing has been measured or calibrated.
- **Leaving.** When the page is hidden, the Android app leaves the foreground, or the learner leaves the screen, the run stops and the
  microphone is released.

## Play, on one clock

Play is instrument karaoke: the song runs from start to end, the prompts arrive in time, and the learner plays along. There are no loops
and no waiting.

```
PlayClock (src/lesson/play-clock.ts): segments of the audio clock — [audioFrom, audioTo) ↦ song time from refFrom at a tempo
   ├─► notes and clicks, scheduled 1 s ahead at audioTimeOf(song time)                       (what is heard)
   ├─► the timeline: each prompt at x = Now + (song time − position) × 200 px per real second (what is seen)
   └─◄ a captured note, placed on the song at refAt(capture time − latency)                  (what is judged)
```

- **Pause, resume, tempo, restart.** A pause cancels what was scheduled and holds the position. A resume (after a count-in), a tempo
  change and a restart each re-anchor the clock where the song is, and schedule again from there. So the playback and the prompts never
  drift apart: a test drives a run through all four and finds every note sounding once, at the audio time of its song time, with its
  prompt at "Now".
- **The display.** The display follows where the sound is heard: the prompts are placed at the clock's position less the reported output
  latency.
- **What is "now".** "Now" is the note at the playhead while it sounds. In a rest, the note coming is shown as next, and nothing is filled
  at "Now".
- **Feedback.** Feedback is optional. With it, the microphone is checked first, and notes heard in a count-in or a pause are no part of the
  song; a first note a little early is. Targets are judged as the song passes, against the arrangement's keys, and only where the capture
  covered them.
- **Lyrics.** None: no reference of AnyTune's carries timed lyrics, and none are invented.

## The formats

| Format | What it holds | Where |
|---|---|---|
| Standard MIDI File + `anytune-reference/1` | the musical reference: the notes as stated, the tempo map, and the provenance (the source's and the MIDI's SHA-256, the engine and its parameters, the review state) | `src/music/` |
| `anytune-recording/1` (`.atrec`) | a learner's attempt, or a timed reference recording: a header naming the reference, events in time order, an end record, each record CRC-checked | `docs/RECORDING.md` |
| `.obr` | sensor observations (Obicall's journal), read by AnyTune's own code for compatibility and **refused as a practice reference** | `docs/OBR.md` |

MIDI and JSON are never renamed to `.obr`, and music is never written into `.obr`.

## One source, two proof paths

There are 18 components, each one `.obix` file, and no `.vue` file anywhere.

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
- **Semantics.** All 18 components lower to `obix-dop-ir/3` with no deferral (`npm run trace`, `tests/obix/trace.test.ts`).
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
