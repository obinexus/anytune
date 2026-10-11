# Third-party notices

AnyTune is MIT-licensed (`LICENSE`, `SPDX-License-Identifier: MIT`). It uses the works below under their own licences. The versions are the exact pins of `package.json` and `package-lock.json`.

## Shipped in the browser build (`dist/app`)

| Work | Version | Licence | Copyright |
|---|---|---|---|
| Vue: `vue`, `@vue/runtime-dom`, `@vue/runtime-core`, `@vue/reactivity`, `@vue/shared` | 3.5.43 | MIT | © 2018-present, Yuxi (Evan) You and Vue contributors |
| Vite's module-preload helper, inlined by the build | 8.3.1 | MIT | © 2019-present, VoidZero Inc. and Vite contributors |

The build ships no fonts (the stylesheet uses the system font). The page's icon is an inline SVG written for AnyTune.

## Artwork

| Work | Licence | Where |
|---|---|---|
| "Guitar, Music, Musical Instrument" by yorbederycke (https://pixabay.com/vectors/guitar-6755435/) | Pixabay Content License | `assets/instruments/guitar/yorbederycke-guitar-6755435.svg`, unchanged; its fretboard map is derived from it (`assets/instruments/guitar/README.md`) |

## Used to build, never shipped

| Work | Version | Licence | Role |
|---|---|---|---|
| Vite | 8.3.1 | MIT | development server and production build |
| OBIX compiler packages (`obix-compiler-*`; previous names `@obinexusltd/obix-compiler-*`) | 0.5.0 | MIT, © OBINexus Computing | compile the `.obix` components for the Vue runtime, and lower them to the OBIX DOP IR trace |
| TypeScript | 6.0.3 | Apache-2.0 | typecheck |

## The import worker (services/import-worker): a desktop companion, never shipped in the app

| Work | Version | Licence | Role |
|---|---|---|---|
| Basic Pitch (`@spotify/basic-pitch`), with its bundled model | 1.0.1 | Apache-2.0, © Spotify AB | the transcription engine: audio to estimated notes (docs/IMPORT.md) |
| TensorFlow.js (`@tensorflow/tfjs` and its packages) | 3.21.0 | Apache-2.0, © Google LLC | runs Basic Pitch's model, on the CPU |
| yt-dlp | 2026.08.19 (checked against its release's SHA-256) | The Unlicense | an external tool the worker runs to download permitted media; not distributed with AnyTune |
| FFmpeg, ffprobe | 8.1.1 (gyan.dev essentials build) | LGPL-2.1+/GPL-2.0+ (the build's configuration decides) | external tools the worker runs to inspect and decode media; not distributed with AnyTune |

## Used by the tests only, never shipped

| Work | Version | Licence | Role |
|---|---|---|---|
| jsdom | 30.1.1 | MIT | a DOM for the UI tests |
| midi-file | 1.2.4 | MIT, © Carter Thaxton | an independent Standard MIDI File parser and writer: the oracle of `tests/music/midi-conformance.test.ts`, and the writer of the fixture `tests/fixtures/midi/fur-elise-opening.mid` (`tools/fixtures/fur-elise.ts`) |
| axe-core | 4.13.0 | MPL-2.0 | automated accessibility checks. Used unmodified, as a development dependency; nothing of it is distributed. |
| The `.obr` demonstration journal (`tests/fixtures/obr/demo.obr`) | published with obicall `ae5581a`, 0.1.1 | MIT, © 2026 Nnamdi Michael Okpala / OBINexus Computing | the format's demonstration journal, copied unchanged (SHA-256 `3838115346787cfacb55674dd738b5437ec01858a6fd28651ccad417786c79b4`), for the conformance of AnyTune's own `.obr` reader and writer. It is 2-D position data, not pitch. No Obicall code is used: AnyTune has no Obicall dependency (`docs/OBR.md`). |

The full MIT licence text is in `LICENSE`. The same text applies to every MIT work above, with that work's copyright line. The Apache-2.0 and MPL-2.0 texts come with their packages in `node_modules/typescript/LICENSE.txt` and `node_modules/axe-core/LICENSE`.
