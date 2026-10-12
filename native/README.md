# Native artifacts

[Polycall](https://github.com/obinexus/polycall) is AnyTune's only polyglot runtime. This directory holds:

- Polycall, built from one pinned commit and staged inside the workspace.
- AnyTune's own native code that Polycall hosts.

Polycall connects AnyTune's components across languages; it doesn't do anything musical. Import, transcription, MIDI, analysis, tuning, recording, playback and feedback are all AnyTune's own.

| Path | What | Committed |
|---|---|---|
| `manifest.json` | Every staged file: SHA-256, size, platform, architecture, kind, linkage, what its headers say (machine, imported DLLs or needed libraries, SONAME, 16 KB alignment), source commit, toolchain, licence | yes |
| `windows-x86_64/bin/` | `polycall.exe` (the CLI and runtime host), `libpolycall.dll` | no (staged) |
| `windows-x86_64/lib/` | `libpolycall.dll.a` (import library), `libpolycall.a` (static library) | no (staged) |
| `include/polycall/` | Polycall's installed public headers | no (staged) |
| `android/arm64-v8a/`, `android/x86_64/` | `libpolycall.so`, built with the Android NDK, stripped and 16 KB-aligned | no (staged) |
| `licenses/polycall/` | `LICENSE` and `LICENSE.md`, Polycall's two licence texts | no (staged) |
| `.cache/` | Sources and build trees | no |

## Staging

```bash
npm run native:stage -- --polycall-src C:/Users/Nnamdi/Projects/polycall
npm run native:verify
```

- **`--polycall-src`** reads a local clone with `git archive` and never modifies it. Without it, the pinned commit is fetched from GitHub.
- **`--test`** also builds and runs Polycall's own test suite. It needs Node, Python, Go and Java on `PATH`.
- **`native:verify`** re-hashes every file and re-reads every header. With `-- --apk <apk>` it also checks that the APK carries the staged Android libraries, byte for byte.

The pins are in `tools/native/pins.ts`:

- **Polycall:** `main` at `2dcab63ead950d5d061843c6394085eb3dba4c64` (version 1.1.0).
- **Windows build:** MSYS2 UCRT64 (GCC, CMake, Ninja), linked with `--no-insert-timestamp`.
- **Android build:** NDK r27b (27.1.12297006) and the SDK's CMake 3.22.1, API 28, 16 KB pages.

With those toolchains, a rebuild from an empty build directory gives the same bytes as `manifest.json` records. That was checked on the machine that wrote it: two builds, identical hashes.

### Why these choices

- **Not the default branch.** The pin is Polycall's `main`, not its default branch `polycall-cli-redesign`. `main` carries the fix for a network-reachable stack buffer overflow in the runtime (polycall `3ca3d66`) and the Binding ABI v1 (`polycall_call`) that the Android bridge uses.
- **The complete dependency set.** `polycall.exe` and `libpolycall.dll` import only Windows system DLLs: `KERNEL32`, `WS2_32`, `SHELL32` and the UCRT `api-ms-win-crt-*`. So nothing else is staged beside them, and the verifier refuses any import that is neither a system DLL nor staged. `libpolycall.so` needs only `libc`, `libm` and `libdl`.
- **Windows binaries are not Android binaries.** The Android libraries are built from the same commit with the NDK. The verifier checks that each library's ELF machine matches its ABI directory, that its SONAME is its file name, and that every loadable segment is aligned to 16 KB.

## Licence: an owner decision is open

Polycall's repository carries two different licence texts:

- **`LICENSE`:** "Use It, Respect It", an OBINexus contribution clause.
- **`LICENSE.md`:** "OBINexus NT Open Access License", the MIT text with additional terms.

Its packaging names `LicenseRef-OBINexus-NT-Open-Access`. Both texts are staged beside the binaries. The binaries are not committed here, and **Polycall's owner must settle which licence applies before Polycall is redistributed**, for example inside a released APK.
