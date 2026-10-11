# Contributing to AnyTune

Thank you for helping. AnyTune is small on purpose. Its value is that each part can be trusted and replaced, so contributions keep these rules.

## Setting up

You need Node ≥ 26 and, for now, the OBIX monorepo checked out beside AnyTune with its compiler built (see the README, *Prerequisite*).

```bash
npm ci
npm test            # every test: domain, app, fusion, adapters, the UI on Vue in jsdom, accessibility, the build
npm run typecheck   # tsc, strict
npm run trace       # the OBIX DOP IR trace of the components, into dist/obix-ir
npm run dev         # the browser demo
```

## The rules

1. **Test first.** Write the failing test (RED), make it pass with the least code (GREEN), then tidy (REFACTOR). A bug gets a test that reproduces it before it is fixed.
2. **Keep the layers.** `architecture.json` says what each layer may import and which globals it may not name, and `npm test` enforces it. The domain and the music model are pure: no DOM, Vue, native code or microphone. Components only bind the view and emit intents; all formatting is in `src/app/view.ts`.
3. **One source per component.** A component is one `.obix` file, and there is never a `.vue` copy. Components import only `"obix"` (the allowlisted primitives in `tools/obix/allowlist.ts`) and the app's view types.
4. **Don't work around the compiler.** If the OBIX compiler can't express something a component needs, don't bend the component or special-case the compiler here. Write the smallest framework-neutral reproduction and report it to OBIX. Until OBIX fixes it generically, the trace records the deferral honestly: that is why PitchMeter is deferred today.
5. **Say what is real.**
   - Pitch recordings in `tests/fixtures/pitch/` are AnyTune's JSON (`anytune-pitch-recording/1`, origin `simulated`), never `.obr`.
   - The UI always states what supplies the measurements.
   - AnyTune has no Obicall dependency: nothing bundles, links, loads or runs it. An `.obr` is read and written by AnyTune's own code, and never holds music (`docs/OBR.md`).
   - A MIDI fixture is a score, encoded for AnyTune or permitted for use; no fixture comes from a download.
6. **Accessibility is a feature.** Every state in words, one polite live region governed by the announcement policy, native labelled controls, and no violation from axe (`docs/ACCESSIBILITY.md`).
7. **No markup by hand.** No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` anywhere in `src/`. A test checks this.

## The microphone, without a microphone

No test needs a microphone, and none may: the tests must run anywhere.
- **The pitch detector** is pure, and is tested on signals generated from their mathematics. The expected frequency is the one the signal was made with, never one the detector computed.
- **`MicrophonePitchProvider`** is given the browser's APIs, and is tested on a fake browser (`tests/support/fake-audio.ts`). The fake grants, refuses or waits, unplugs tracks, and counts every track, context, node and timer, so that a leak fails a test.
- **A physical instrument** is tested by hand, following `docs/MICROPHONE.md`. Say whether it was done; never assume it.

## The fixtures

- `tests/fixtures/obr/`: the `.obr` format's demonstration journal and the answers its reference implementation once gave. They are frozen, never edited and never regenerated (`tests/fixtures/obr/README.md`).
- `tests/fixtures/midi/`: scores encoded for AnyTune. Regenerate them with `node tools/fixtures/fur-elise.ts`.

## Commits

Use one step per commit, with a message that says what changed and what proves it (the tests, the typecheck, the trace). Keep compiler changes in the OBIX repository and AnyTune changes here, never mixed.
