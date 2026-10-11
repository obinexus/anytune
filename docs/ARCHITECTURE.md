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
| audio | `src/audio/` | pitch providers (simulated, recorded, microphone) and the pure pitch detector | touch the document or the network |
| fusion | `src/fusion/` | `PitchFusionPort` implementations: inverse-variance fusion, `SimulatedPitchFusion`, `RecordedPitchFusion` | touch the DOM |
| music | `src/music/` | MIDI files, the tempo-map timeline, the teaching reference | import anything but the domain; touch the DOM |
| adapters | `src/adapters/` | file formats kept compatible: the `.obr` journal reader and writer (`docs/OBR.md`) | be a component; touch the DOM |
| app | `src/app/` | the tuning session (state and intents), the view (all formatting), the announcement policy | name a provider, a format reader or Vue |
| components | `src/components/*.obix` | the Vue-flavoured OBIX UI: binds the view, emits intents | import anything but `"obix"` and the app's view types; touch `document`, `window`, `navigator`, audio or the network |
| native-harness | `src/harness/mount-native.ts` | Phase 6: mounts the same UI, lowered to canonical DOP IR, on OBIX's native runtime; may import `obix-runtime-browser` and never Vue | — |
| harness | `src/harness/` | composes the layers and the inputs (`compose.ts`); hands the browser's audio APIs over (`browser-audio.ts`); mounts the UI on the Vue runtime (`mount.ts`), the entry picking the mount as `#anytune-mount`; the demo input | — |

## The flow of a pitch

```
PitchProvider(s) ─observations─► PitchFusionPort ─fused pitch─► TuningSession ─state─► toView ─view─► .obix UI (Vue runtime, or OBIX's native runtime)
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
   official Vue runtime               canonical obix-dop-ir/3
               │                                │
          browser UI                  dist/obix-ir/<Name>.obix.json
```

- **Execution.** The `.obix` sources are compiled by the real OBIX Vue frontend stages and run on the **official Vue runtime** — the default: in the browser through the Vite plugin (`tools/obix/vite-plugin.ts`), and in the Node tests through module hooks (`tools/obix/register.ts`). `"obix"` resolves to an **allowlist** of Vue-compatible primitives (`tools/obix/allowlist.ts`). Any other name from `"obix"`, and any import of it outside a component, fails the build. No source is rewritten.
- **Native execution (Phase 6, awaiting review).** `Component.obix?ir` is the same file lowered to `obix-dop-ir/3` — the IR the trace records — with every component it invokes, by specifier (`tools/obix/ir-module.ts`, in the Vite plugin and the Node hooks alike). `src/harness/mount-native.ts` runs it with OBIX's own runtime, `obix-runtime-browser`: no Vue in the page (`npm run dev:native`; `tests/build/native-build.test.ts` audits the bundle's module graph). The runtime is chosen by the entry's `#anytune-mount` (the Vue harness by default; `--mode native` points it at the native one). Every UI suite runs on both runtimes, and `tests/native/vue-vs-native.test.ts` compares the two pages after every step. The hybrid runtime is not implemented.
- **Semantics.** The same files are lowered by the OBIX compiler to its canonical, framework-neutral IR, **`obix-dop-ir/3`** (`npm run trace`). What the IR can't express is recorded as a deferral with the compiler's own diagnostic, never hidden. Today all 9 components lower. **PitchMeter** was the last deferred (`OBIX_DOP_DEFERRED_EXPRESSION`): its `computed` calls `Math.round`, and the IR had no call expression. OBIX C3 added one generically, in the compiler and not here: the call of an intrinsic function from a closed vocabulary (`round` alone today), so PitchMeter's offset is `round(needlePercent − 50)` in the IR.
- **The two agree on their sources**: the production build writes `obix-runtime-manifest.json` (every component by the SHA-256 of its source), and a test checks it equals the trace's list (`tests/build/vite-build.test.ts`, `tests/obix/trace.test.ts`).

Component interaction (a selector telling the app which instrument was chosen) became IR in OBIX C2 (`obix-dop-ir/2`: outputs, output steps and interactions). It was proven equivalent between OBIX's Vue and React frontends before AnyTune relied on it.

## The inputs: the microphone, and the demo

The demo composes two inputs (`src/harness/compose.ts`). Each is a `PitchFusionPort` the session chooses between (`TuningSession.selectInput`, driven by an input selector in the `.obix` UI):

- **Microphone.** `MicrophonePitchProvider` (`src/audio/microphone-provider.ts`) sits behind the same `PitchProvider` contract as the simulated and recorded providers. It is fused by `InverseVarianceFusion`, with the microphone as its only source.
  - The pipeline: getUserMedia → Web Audio → an AnalyserNode → a frame every 50 ms → the pure YIN detector (`src/audio/pitch-detector.ts`) → a `PitchObservation`.
  - The browser's APIs are injected; `src/harness/browser-audio.ts` is the only code that names them, so the tests run the provider on a fake browser.
  - Its failures are states from the domain's one list (`SOURCE_FAILURES`), said in words.
  - Details: `docs/MICROPHONE.md`.
- **Demo (recorded / simulated)**, the default. `src/harness/demo-input.ts` plays, at each Start, the input made for the chosen instrument: a recording of the acceptance sequence for Standard Guitar, a recording of 440 Hz for Chromatic, and a simulation of its first string for any other. It needs no native library or microphone.

The page always says which input is supplying the measurements (*Input: Microphone — …*, *Input: Recorded — … (simulated data)*, *Input: Simulated — …*). The microphone's permission is asked for only when the user has chosen it and pressed Start.

Adding the microphone needed no change to the tuning domain's mathematics, the fusion's mathematics, or the logic of the `.obix` components. It added:

- in the domain's ports, the input's description (`InputSource`), and the failures a microphone can have (an insecure page, an unsupported browser, a microphone that can't be opened, audio that can't start);
- in the session, the choice of input;
- in the UI, an input selector and a privacy statement.

**Not done yet:** validation with a physical instrument (`docs/MICROPHONE.md`, *the manual acceptance test*). In production the microphone needs HTTPS, since `getUserMedia` requires a secure context; `localhost` counts as secure for development.

