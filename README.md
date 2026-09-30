# AnyTune

**Tune any instrument.** An OBINexus tuning application built with [OBIX](https://github.com/obinexus) and designed to fuse pitch the way [Obicall](https://github.com/obinexus) fuses sensor data.

Press **Start** once, then play. The note, its frequency, how many cents flat or sharp it is, and whether it is in tune update by themselves: no button to press between notes. Every state is in words, and screen-reader users hear what changed, but only what matters.

> **Status**
>
> | | |
> |---|---|
> | UI runtime | the official Vue runtime (the default); OBIX's experimental native runtime from the same files (`npm run dev:native`), under final validation |
> | Authoring | Vue-flavoured `.obix` |
> | Semantic proof | the OBIX DOP IR (`obix-dop-ir/3`) |
> | OBIX native runtime | experimental — implemented, not the default |
> | OBIX hybrid runtime | not implemented |

AnyTune is authored as Vue-flavoured OBIX. The OBIX canonical IR is **`obix-dop-ir/3`**: the same nine `.obix` components are lowered to it by the OBIX compiler.

OBIX now has an **experimental native browser runtime**, made of four packages:

- `obix-runtime-reactivity`
- `obix-runtime-dom`
- `obix-runtime-component`
- `obix-runtime-browser`

It runs the canonical IR directly (`npm run dev:native`). The native execution path does **not** depend on Vue runtime packages: no `vue`, `@vue/runtime-core` or `@vue/runtime-dom` is in the native bundle or resolvable from the native install.

**Vue remains AnyTune's default runtime** (`npm run dev`) while the native runtime is under final validation.

Two different dependencies on Vue are not to be confused: the OBIX **Vue syntax frontend** still uses Vue **compiler** packages (`@vue/compiler-sfc`, `-core`, `-dom`) at build and compile time, to read Vue-flavoured `.obix`; the native path has **no Vue runtime** dependency. The hybrid runtime is not implemented.

## How to run AnyTune

You need **Node ≥ 26**. The OBIX compiler and runtime packages come from npm (see *The OBIX packages* below), so a clone installs on its own.

```bash
git clone https://github.com/obinexus/anytune.git
cd anytune
npm ci
npm run dev
```

Open the address Vite prints (`http://localhost:5173/`) in Edge, Chrome or Firefox.

**The same UI on OBIX's native runtime** (no Vue in the page): `npm run dev:native` (build: `npm run build:native`, into `dist/app-native`; serve the build: `npm run preview:native`). `npm run dev:vue` is the default made explicit. The native runtime packages (`obix-runtime-*`) come from npm too.

**To tune your guitar**, choose Instrument: **Standard Guitar** and Input: **Microphone**, then press **Start tuning** and allow the microphone. Pluck one open string at a time: the note, its frequency, the cents flat or sharp, and *Flat* / *In tune* / *Sharp* follow the peg as you turn it. **Details** shows the confidence. The full procedure is in `docs/MICROPHONE.md`.

> The microphone input is tested on generated signals through a fake browser, and it has heard a **physical guitar**: in Microsoft Edge, on a laptop's AMD microphone array at 48 kHz, the D string was read at 145.1 Hz, 20 cents flat. In **Firefox** on that laptop the microphone delivered digital silence. AnyTune now detects that and says so; tune in Edge or Chrome there (`docs/MICROPHONE.md`).

**Without a microphone**, the default input is the demo. Press **Start tuning**:

- **Standard Guitar** plays the A string rising to pitch, 108 → 109 → 110 → 110 Hz: *Flat*, *Flat*, *In tune*, then *In tune*, *Holding steady*.
- **Chromatic** plays 440 Hz: **A4**, in tune.
- **Bass, violin, ukulele** play a simulation of their first string rising to pitch.

The page always says what it is hearing, for example *Input: Microphone — …* or *Input: Recorded — … (simulated data)*. With the microphone it also says: *Microphone audio is processed locally for pitch detection. AnyTune does not upload or persist raw microphone audio.*

The production build, and a local server for it:

```bash
npm run build      # the static site, in dist/app
npm run preview    # serves dist/app at http://localhost:4173/
```

The checks:

```bash
npm test           # all the tests: domain, app, fusion, the Obicall conformance, the UI on Vue, accessibility, the build
npm run typecheck
npm run trace      # the OBIX DOP IR of every component, into dist/obix-ir
```

### The OBIX packages

AnyTune depends on the published OBIX packages, pinned to exactly `0.5.0`: nine `obix-compiler-*` packages (used at build and compile time) and four `obix-runtime-*` packages (the native runtime). `npm ci` installs them from registry.npmjs.org; no OBIX checkout is needed. OBIX packages carry no npm scope since D-102 (previous names `@obinexusltd/obix-*`). The published 0.5.0 packages build AnyTune byte-for-byte the same as the OBIX monorepo they were packed from.

To try unreleased OBIX changes, point those dependencies at a local checkout of the OBIX monorepo (`file:../obix-recovery/compiler/…`, `file:../obix-recovery/runtime/…`), which is how AnyTune was developed before the packages were published. The demo itself never needs Obicall, a DLL or a microphone.

## What is real, and what isn't yet

| | |
|---|---|
| Vue-flavoured OBIX UI (9 `.obix` components) | **implemented** |
| OBIX DOP IR trace (`npm run trace`) | **implemented**: all 9 components lower. `PitchMeter`'s `Math.round` is the IR's call of its intrinsic `round` (OBIX C3, `obix-dop-ir/3`); until C3 it was deferred |
| Vue compatibility runtime | **the demo's execution path**: an allowlisted `"obix"` → Vue alias at build time, with no source rewritten |
| Browser demo (`npm run dev`, `build`, `preview`) | **implemented** — on the Vue runtime (the default, also `dev:vue`) and on OBIX's native runtime (`dev:native`, `build:native`, `preview:native`) |
| Musical domain: equal temperament, cents, nearest note, strings, the tuning policy | **implemented and tested** (`docs/TUNING_MODEL.md`) |
| Simulated and recorded pitch input | **implemented**: AnyTune's own JSON recordings, origin *simulated* |
| Real Obicall `.obr` parsing | **conformance-tested** against Obicall's real `demo.obr` and the real `obicall replay` |
| Inverse-variance fusion | **tested against Obicall**: equal to the native `obicall_static_fuse_1d`, bit for bit, on 2 050 cases |
| Native Obicall pitch transport | **not implemented**: Obicall has no frequency unit (`docs/OBICALL.md`) |
| Microphone pitch detection | **implemented**: `MicrophonePitchProvider` with a YIN detector (`docs/MICROPHONE.md`), tested on generated signals through a fake browser. **Physical guitar: performed in Edge** (AMD microphone array, 48 kHz; D string read 145.1 Hz, 20 cents flat). **Firefox on that machine: not validated**, since the microphone delivered digital silence, now detected and said |
| OBIX native runtime | **experimental — implemented (Phase 6, accepted by the owner); not the default, under final validation**: the same 9 `.obix` files, lowered to `obix-dop-ir/3` (`Component.obix?ir`), run by `obix-runtime-browser` with no Vue in the bundle (audited from the bundler's module graph). The hands-free, microphone (fake browser) and accessibility suites run on both runtimes, and the two pages are compared after every step (`tests/native/`). **Physical microphone on the native runtime: not performed** |
| OBIX hybrid runtime | **not implemented** |

## How it is built

```
PitchProvider(s) → PitchFusionPort → tuning domain → application state → view → .obix UI
```

- **`src/domain/`**: pitch and tuning, pure TypeScript with no DOM, Vue or Obicall.
- **`src/instruments/`**: the tuning catalog.
- **`src/audio/`**: pitch providers.
- **`src/fusion/`**: inverse-variance fusion.
- **`src/adapters/`**: the Obicall replay reader.
- **`src/app/`**: the session, the view and the announcement policy.
- **`src/components/`**: the `.obix` UI.
- **`src/harness/`**: the composition and the demo input.

`architecture.json` states the layers, and the tests enforce them. The details are in `docs/ARCHITECTURE.md`.

| Document | About |
|---|---|
| `docs/ARCHITECTURE.md` | the layers, the two proof paths, and the inputs: the microphone and the demo |
| `docs/MICROPHONE.md` | the microphone input: the pitch detector and its measured accuracy, the lifecycle, the failures, privacy, browsers, and the manual guitar test |
| `docs/TUNING_MODEL.md` | the mathematics and the policy |
| `docs/OBICALL.md` | what AnyTune does with Obicall now, what is simulated, and what Obicall must gain to carry pitch |
| `docs/ACCESSIBILITY.md` | semantics, the live region and its policy, and how it is tested |
| `docs/DEPLOYMENT.md` | the prepared (not done) deployment to anytune.obinexus.org |
| `CONTRIBUTING.md` | the rules, and how to regenerate the conformance fixtures |

## Remaining work

- **The full physical-guitar check**: every open string to *In tune* against another tuner. Also whether Firefox's processed-audio retry gives sound on the AMD array (`docs/MICROPHONE.md`).
- **PitchMeter's IR**, once OBIX lowers call expressions: a compiler slice, not an AnyTune change.
- **Publishing** the OBIX compiler packages under their scope, so that AnyTune installs on its own.
- **Testing with a screen reader and real people**, beyond the automated checks.
- **Pitch through Obicall**, once Obicall has a frequency unit (`docs/OBICALL.md`).
- **Deployment** to anytune.obinexus.org (`docs/DEPLOYMENT.md`), with the owner's authorisation.

## Licence

MIT, © 2026 Nnamdi Michael Okpala / OBINexus Computing (`LICENSE`). Third-party works: `THIRD_PARTY_NOTICES.md`.
