# Integration audit

What AnyTune is built from and against, each item pinned and checked, as of **2026-10-11** on the branch `anytune-mvp`. Where something was not checked,
this page says so.

## AnyTune

| | |
|---|---|
| Repository | https://github.com/obinexus/anytune |
| Base | `main` at `0226bac` ("Publish prep: the OBIX packages come from npm (0.5.0)"). `main` is untouched. |
| Work | the local branch `anytune-mvp`, one commit per verified step (`git log main..anytune-mvp`). Not pushed. |
| Node | ≥ 26 (developed on 26.7.0) |
| OBIX | the published `obix-compiler-*` and `obix-runtime-*` packages, exactly 0.5.0 (`package-lock.json`). What the IR cannot express yet, and how AnyTune is written around it: `docs/OBIX-GAPS.md` |

## Polycall: the only polyglot runtime

| | |
|---|---|
| Repository | https://github.com/obinexus/polycall |
| Pinned | `main` at `2dcab63ead950d5d061843c6394085eb3dba4c64`, version 1.1.0 (`POLYCALL_ABI_VERSION_STRING`); `tools/native/pins.ts` |
| Not the default branch | The repository's default branch is `polycall-cli-redesign` (at `6aedb14` when pinned). `main` carries `3ca3d66` ("Binding ABI v1, peer transport, daemon; harden runtime"), which fixes a network-reachable stack buffer overflow in the runtime's input re-serialiser and `describe` builder, and adds the Binding ABI v1 that the Android bridge uses. The default branch lacks both. |
| Staged | `npm run native:stage` builds it from that commit and refuses any other tree. The output goes into `native/windows-x86_64/` (`polycall.exe`, its DLL and static library, the licence texts) and `native/android/<abi>/libpolycall.so`. `native/manifest.json` records every file's SHA-256, machine, dependencies and alignment, and `npm run native:verify` checks them (17 files, 7 binaries, holding at this date). The binaries are not committed. |
| Toolchains | Windows: MSYS2 UCRT64, GCC 16.2.0, CMake 4.4.3, `-Wl,--no-insert-timestamp`. Android: NDK r27b (27.1.12297006), clang 18.0.2, API 28, 16 KB page alignment, stripped. Both rebuild byte for byte. |
| Polycall's own tests | ctest 16/16 on UCRT64, in the staging build of 2026-10-11 |

### What was checked in Polycall's source, and is used

- **The runtime CLI.** `polycall start --endpoint 127.0.0.1:0 --endpoint-file <f> --auth-token <shutdown token> --load <plugin>`. The tests and the import worker start AnyTune's recorder this way.
- **The wire, `polycall_rpc v1`.** Polycall's `docs/RPC.md` and `src/runtime/rpc_wire.h`: a 16-byte header (`PCR1`, type, flags, a big-endian correlation id and a big-endian length of at most 1 MiB), then a JSON payload. AnyTune implements it in `src/polycall/wire.ts` and tests it field by field against the specification's table.
- **Plugins.** A shared library exporting `polycall_ops_register` (Polycall's `docs/PLUGINS.md`), loaded by `--load`. AnyTune's recorder module (`native/recorder`) is one, and is also linked into the Android bridge.
- **The in-process runtime.** `polycall_runtime_create`, `_register` and `_serve`, used by the Android bridge.
- **Binding ABI v1, `polycall_call`.** Its error mapping (`auth.denied` → `E_AUTH`, `operation.unknown` → `E_NOT_FOUND`, and so on) still writes the error object to the output. The bridge therefore takes any output that is a JSON object as the reply, which a test on the device checks.

### Limits found, and how AnyTune handles them

| Limit (at the pinned commit) | What AnyTune does |
|---|---|
| **Requests are not authenticated.** Only shutdown takes a token. | The recorder module requires a per-session token on every operation, generated with a CSPRNG, never stored, and never given to the WebView. The runtime listens only on `127.0.0.1`. |
| A handler's output is capped at 64 KiB (`RT_OUT_CAP`). | The recorder replays in pages that stay under the cap (`docs/RECORDING.md`). |
| One thread per connection. | Each runtime has one local client in practice (the app's bridge, or the import worker). Nothing enforces this, and load beyond it has not been tested. |
| **The licence is inconsistent.** `LICENSE` and `LICENSE.md` are different texts. | Both are copied beside the binaries. **The owner must settle which applies before an APK carrying `libpolycall.so` is distributed.** |

Polycall connects AnyTune's components across languages and nothing more. AnyTune's own code does the import, transcription, MIDI, analysis,
tuning, recording, playback and feedback. Polycall provides none of these musical features.

## Obicall: excluded

AnyTune has **no Obicall dependency**. It doesn't bundle, link, load or run `obicall.exe`, Obicall's libraries, its SDK or its recording and
replay runtime. The Obicall tooling and documents are gone (`9851595`). The production bundle is checked for Obicall
(`tests/build/vite-build.test.ts`).

- **`.obr` compatibility.** AnyTune keeps its own TypeScript reader and writer, written from the format's published sources (obicall
  `ae5581a`, unchanged at `v0.1.2`), which were only read (`docs/OBR.md`). An `.obr` is refused as a practice reference, because it holds
  sensor observations, not music.
- **The fixture.** `tests/fixtures/obr/demo.obr` is the format's demonstration journal, copied unchanged for conformance
  (`THIRD_PARTY_NOTICES.md`).
- **The local checkout.** The Obicall checkout beside AnyTune (`../obicall`, at `b5dd357`) is not used by any build, test or script.

## The import tools: on a desktop, never in the app

| Tool | Version | Checked | Role |
|---|---|---|---|
| yt-dlp | 2026.08.19 (`C:\Tools\yt-dlp.exe`, SHA-256 `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`) | identical to the official release, against its `SHA2-256SUMS`; `--version` runs | downloads permitted media, given by `ANYTUNE_YTDLP` or found on `PATH` (`node services/import-worker/src/cli.ts doctor` says which) |
| FFmpeg, ffprobe | 8.1.1, the gyan.dev essentials build (winget `Gyan.FFmpeg.Essentials`) | found and run by `doctor`; used by the end-to-end import tests | inspects and decodes media to mono PCM |
| Basic Pitch (`@spotify/basic-pitch`) | 1.0.1, Apache-2.0, with TensorFlow.js 3.21.0 on the CPU | the import worker's lockfile; end-to-end tests on a local MP4 | transcribes audio to estimated notes, which become MIDI |

The yt-dlp, FFmpeg and Windows executables are **not** in the APK, and Android could not run them there (`docs/IMPORT.md`). No video was
downloaded while building AnyTune. The yt-dlp invocation is unit-tested, and the pipeline is tested end to end on a generated local MP4.

## Android build

AGP 9.4.1 (Kotlin built in), Gradle 9.7.1 (wrapper), compileSdk 37, targetSdk 36, minSdk 28. AndroidX: core-ktx 1.19.1, activity-ktx 1.13.0,
lifecycle-runtime-ktx 2.11.0 and webkit 1.17.1. The Kotlin standard library is 2.2.10. Tested on the emulator `Smoke_SmallPhone` (API 37,
x86_64, 16 KB pages), with no physical device (`docs/ANDROID.md`).

## The files the owner supplied

| File | SHA-256 | What became of it |
|---|---|---|
| `yorbederycke-guitar-6755435.svg` | `8e2a36241e2eb838bb48a134798859b7217debf908dc132b58a2c18ad7e19df3` | Copied unchanged to `assets/instruments/guitar/`, with a byte-for-byte rule in `.gitattributes` and a test of its hash. Its licence (Pixabay Content License) was checked on its page. Its fretboard map is derived from its geometry (`tools/guitar/derive-fretboard-map.ts`). |
| `C:\Tools\download-music.ps1` | `0c7ff32ec8e6b8a345a37ea35b94c5208de31214fcc491d03eca4a037fd4eb92` | Left unchanged. The corrected version is `tools/windows/download-music.ps1`, and what changed is in `docs/IMPORT.md`. |
| `C:\Tools\urls.txt` | `60081e97416ba1527839a5ab6be726c718065cc02b40cef5a84e9d69aafbbdb5` (20 lines) | Not downloaded, as the scope said was unnecessary. Not copied into the repository. |
| `C:\Tools\yt-dlp.exe` | as above | Verified against its release, and not bundled. |
| `fzt.html` | `65ab02b3f72ab59ad0733eaf652d0617909ac5ebb9f78fd41df38d585d6260b1` | **Layout inspiration only.** It is an "F-Pattern Layout" demo whose script fetches `https://swapi.dev/api/people/` (the Star Wars API) and calls `getElementById('content')`, although the page has no element with that id, so its error path would throw. None of its code, content or API calls is used. Its idea of a header with the navigation across the top and the primary action first in reading order shaped the shell's header and Home screen. |

## Open items for the owner

- **Polycall's licence**, before any APK is distributed.
- **Release signing.** A release APK needs the owner's signing key, configured outside the repository.
- **Reporting the OBIX IR gaps upstream** (`docs/OBIX-GAPS.md`) is the owner's call.
- **Pushing `anytune-mvp`** and opening a pull request to `main`, when the owner decides.
