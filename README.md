# AnyTune

**Tune any instrument.** An OBINexus tuning application built with [OBIX](https://github.com/obinexus) and designed to fuse pitch the way [Obicall](https://github.com/obinexus) fuses sensor data.

Press **Start** once, then play. The note, its frequency, how many cents flat or sharp it is, and whether it is in tune update by themselves: no button to press between notes. Every state is in words, and screen-reader users hear what changed, but only what matters.

> **Status**
>
> | | |
> |---|---|
> | UI runtime | the official Vue runtime |
> | Authoring | Vue-flavoured `.obix` |
> | Semantic proof | the OBIX DOP IR (`obix-dop-ir/2`) |
> | OBIX native runtime | not implemented |
> | OBIX hybrid runtime | not implemented |

AnyTune is currently authored as Vue-flavoured OBIX. The Phase-5 demonstration executes the UI with the official Vue runtime through a development-time compatibility alias, while the same .obix components are independently lowered through the OBIX compiler to canonical obix-dop-ir/2. OBIX native and hybrid runtime backends are not implemented yet.

## How to run AnyTune

You need **Node ≥ 26**. Today you also need the **OBIX monorepo checked out beside AnyTune**, with its compiler built, because AnyTune links the OBIX compiler packages from `../obix-recovery` (see *Prerequisite* below).

```bash
git clone <eventual repo> anytune
cd anytune
npm ci
npm run dev
```

Open the address Vite prints (`http://localhost:5173/`) in Edge, Chrome or Firefox.

**To tune your guitar**, choose Instrument: **Standard Guitar** and Input: **Microphone**, then press **Start tuning** and allow the microphone. Pluck one open string at a time: the note, its frequency, the cents flat or sharp, and *Flat* / *In tune* / *Sharp* follow the peg as you turn it. **Details** shows the confidence. The full procedure is in `docs/MICROPHONE.md`.

> The microphone input is implemented and tested on generated signals through a fake browser. It has **not yet been checked with a physical guitar**: the procedure above is that check.

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

### Prerequisite: the OBIX compiler

AnyTune's `package.json` links `@obinexusltd/obix-compiler-*` as `file:../obix-recovery/compiler/…`. Check out the OBIX monorepo as `obix-recovery` next to `anytune`, on the branch `recovery/obix-api-preserving-rebuild` or later, and build it once:

```bash
cd ../obix-recovery
npm ci
npm run build
```

Until those packages are published under their scope, a clone of AnyTune alone can't install. The demo itself never needs Obicall, a DLL or a microphone.

## What is real, and what isn't yet

| | |
|---|---|
| Vue-flavoured OBIX UI (9 `.obix` components) | **implemented** |
| OBIX DOP IR trace (`npm run trace`) | **implemented**: 8 of the 9 components lower. `PitchMeter` is deferred (`OBIX_DOP_DEFERRED_EXPRESSION`: its `Math.round` is a call, and the IR has no call expression yet) |
| Vue compatibility runtime | **the demo's execution path**: an allowlisted `"obix"` → Vue alias at build time, with no source rewritten |
| Browser demo (`npm run dev`, `build`, `preview`) | **implemented** |
| Musical domain: equal temperament, cents, nearest note, strings, the tuning policy | **implemented and tested** (`docs/TUNING_MODEL.md`) |
| Simulated and recorded pitch input | **implemented**: AnyTune's own JSON recordings, origin *simulated* |
| Real Obicall `.obr` parsing | **conformance-tested** against Obicall's real `demo.obr` and the real `obicall replay` |
| Inverse-variance fusion | **tested against Obicall**: equal to the native `obicall_static_fuse_1d`, bit for bit, on 2 050 cases |
| Native Obicall pitch transport | **not implemented**: Obicall has no frequency unit (`docs/OBICALL.md`) |
| Microphone pitch detection | **implemented**: `MicrophonePitchProvider` with a YIN detector (`docs/MICROPHONE.md`), tested on generated signals through a fake browser. **Validation with a physical guitar: not performed yet** |
| OBIX native runtime | **not implemented** |
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

- **The physical-guitar check** of the microphone input (`docs/MICROPHONE.md`), and whatever it finds.
- **PitchMeter's IR**, once OBIX lowers call expressions: a compiler slice, not an AnyTune change.
- **Publishing** the OBIX compiler packages under their scope, so that AnyTune installs on its own.
- **Testing with a screen reader and real people**, beyond the automated checks.
- **Pitch through Obicall**, once Obicall has a frequency unit (`docs/OBICALL.md`).
- **Deployment** to anytune.obinexus.org (`docs/DEPLOYMENT.md`), with the owner's authorisation.

## Licence

MIT, © 2026 Nnamdi Michael Okpala / OBINexus Computing (`LICENSE`). Third-party works: `THIRD_PARTY_NOTICES.md`.
