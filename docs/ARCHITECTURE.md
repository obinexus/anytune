# Architecture

AnyTune separates *what a tuner knows* (pitch, tuning, fusion) from *where pitch comes from* (a simulation, a recording, later a microphone) and from *how it is shown* (the `.obix` UI). Each can be replaced without touching the others.

## The layers

`architecture.json` states the layers and what each may depend on. `tools/architecture/check.ts` enforces them on every import and every global, as a test (`npm run test:architecture`, part of `npm test`).

```
                    components (.obix UI) ──► app ──► domain ◄── fusion ──► audio ──► domain
                                                        ▲
                                          instruments ──┘          adapters ──► domain
   harness  ──► everything (the one composition point; the only TypeScript that imports Vue)
```

| Layer | Directory | What it is | May not |
|---|---|---|---|
| domain | `src/domain/` | pitch, tuning, the ports (`PitchProvider`, `PitchFusionPort`, `Scheduler`, `InputSource`) | import anything; touch the DOM |
| instruments | `src/instruments/` | the tuning catalog, as data | touch the DOM |
| audio | `src/audio/` | pitch providers: simulated, recorded (and later a microphone) | touch the document or the network |
| fusion | `src/fusion/` | `PitchFusionPort` implementations: inverse-variance fusion, `SimulatedPitchFusion`, `RecordedPitchFusion` | touch the DOM |
| adapters | `src/adapters/` | readers of foreign formats: `ObicallReplayReader` | be a component; touch the DOM |
| app | `src/app/` | the tuning session (state and intents), the view (all formatting), the announcement policy | name a provider, Obicall or Vue |
| components | `src/components/*.obix` | the Vue-flavoured OBIX UI: binds the view, emits intents | import anything but `"obix"` and the app's view types; touch `document`, `window`, `navigator`, audio or the network |
| harness | `src/harness/` | composes the layers; mounts the UI on the Vue runtime; the demo input | — |

## The flow of a pitch

```
PitchProvider(s) ─observations─► PitchFusionPort ─fused pitch─► TuningSession ─state─► toView ─view─► .obix UI (Vue runtime)
                                                                     ▲                                      │
                                                                     └──────────── intents: select instrument, start, stop ─┘
```

Failures (permission denied, no device, disconnected, no source) are **states**, carried as events, never exceptions thrown at the UI. The visual refresh is not the fusion's rate: fifty pitches in one tick render once (`tests/integration/hands-free.test.ts`).

## One source, two proof paths

Every component is one `.obix` file, and there is no `.vue` file anywhere.

```
                          AnyTune .obix
                               │
               ┌───────────────┴────────────────┐
               ▼                                ▼
      Vue demo path                     OBIX semantic path
   OBIX Vue frontend stages          OBIX Vue frontend → lowerVueToDop
   (tools/obix/compile.ts)           (tools/obix/trace.ts)
               │                                │
   official Vue runtime               canonical obix-dop-ir/2
               │                                │
          browser UI                  dist/obix-ir/<Name>.obix.json
```

- **Execution.** The `.obix` sources are compiled by the real OBIX Vue frontend stages and run on the **official Vue runtime**: in the browser through the Vite plugin (`tools/obix/vite-plugin.ts`), and in the Node tests through module hooks (`tools/obix/register.ts`). `"obix"` resolves to an **allowlist** of Vue-compatible primitives (`tools/obix/allowlist.ts`). Any other name from `"obix"`, and any import of it outside a component, fails the build. No source is rewritten. This is a compatibility alias for the demo, not an OBIX runtime: **OBIX has no native or hybrid runtime yet**.
- **Semantics.** The same files are lowered by the OBIX compiler to its canonical, framework-neutral IR, **`obix-dop-ir/2`** (`npm run trace`). What the IR can't express yet is recorded as a deferral with the compiler's own diagnostic, never hidden. Today 7 of 8 components lower. **PitchMeter** is deferred (`OBIX_DOP_DEFERRED_EXPRESSION`): its `computed` calls `Math.round`, and the IR has no call expression yet. That is a compiler limitation, left to a later compiler slice and not special-cased here.
- **The two agree on their sources**: the production build writes `obix-runtime-manifest.json` (every component by the SHA-256 of its source), and a test checks it equals the trace's list (`tests/build/vite-build.test.ts`, `tests/obix/trace.test.ts`).

Component interaction (a selector telling the app which instrument was chosen) became IR in OBIX C2 (`obix-dop-ir/2`: outputs, output steps and interactions). It was proven equivalent between OBIX's Vue and React frontends before AnyTune relied on it.

## The browser demo's input

`src/harness/demo-input.ts` is a `PitchFusionPort` that plays, at each Start, the input made for the chosen instrument:

- Standard Guitar: a recording of the acceptance sequence.
- Chromatic: a recording of 440 Hz.
- Every other instrument: a simulation of its first string rising to pitch.

The page states which (*Input: Recorded — … (simulated data)*). It needs no Obicall, DLL or microphone.

## The next adapter: `MicrophonePitchProvider`

Listening to a real instrument is **one new provider** behind the existing `PitchProvider` contract, and one change of composition in the harness. The tuning domain, the fusion, the application, and the `.obix` UI don't change.

```
navigator.mediaDevices.getUserMedia({ audio: … })        (src/audio/microphone-provider.ts, the audio layer)
        ↓
Web Audio API: an AudioContext, an AnalyserNode or an AudioWorklet
        ↓
a pitch detector (e.g. YIN or McLeod), frame by frame
        ↓
PitchObservation { sourceId, frequencyHz, varianceHz2, confidence, timestampMs }
        ↓
the existing PitchFusionPort (InverseVarianceFusion over the microphone provider)
        ↓
the existing tuning domain → TuningSession → toView → the existing .obix UI
```

The contract it must keep (`src/domain/ports.ts`):

| Method or event | What the microphone provider must do |
|---|---|
| `start()` | ask for the microphone, and resolve **whatever happens** |
| a denied permission | the state `permission-denied`, never a thrown exception |
| no device | the state `no-device` |
| an unplugged device | the state `disconnected` |
| no pitch (silence, noise) | a `silence` event |
| a pitch | an `observation`, its variance in Hz² and its confidence 0…1 from the detector |
| `stop()` | release the stream |

The harness composes `InverseVarianceFusion([new MicrophonePitchProvider(…)], clock)`, and the page says *Input: Microphone — …*.

What is **not** done: there is no microphone provider yet, and no fake one. It is the next milestone. It needs HTTPS in production, since `getUserMedia` requires a secure context, and `localhost` counts as secure for development.
