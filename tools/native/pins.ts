/**
 * What AnyTune's native artifacts are built from, pinned. Polycall is AnyTune's only polyglot runtime (docs/ARCHITECTURE.md); it is built from this exact
 * commit and nothing else, and the staging refuses a source tree that is not it.
 *
 * Why `main` and not the repository's default branch (`polycall-cli-redesign`): at the time of pinning, `main` carries the fix of a network-reachable
 * stack buffer overflow in the runtime's input re-serialiser and `describe` builder (polycall 3ca3d66, "harden runtime") and the Binding ABI v1
 * (`polycall_call`, used by AnyTune's Android bridge), which the default branch lacks. See docs/integration-audit.md.
 */
export const POLYCALL = Object.freeze({
  repository: 'https://github.com/obinexus/polycall.git',
  branch: 'main',
  commit: '2dcab63ead950d5d061843c6394085eb3dba4c64',
  /** POLYCALL_ABI_VERSION_STRING of include/polycall_export.h at that commit */
  version: '1.1.0',
  /** the two licence texts the repository carries, both copied beside the binaries */
  licenseFiles: ['LICENSE', 'LICENSE.md'] as const,
  licenseNote:
    'The repository carries two different licence texts: LICENSE ("Use It, Respect It", an OBINexus contribution clause) and LICENSE.md ("OBINexus NT Open Access License": the MIT text with additional terms); its packaging names LicenseRef-OBINexus-NT-Open-Access. The owner must settle which applies before Polycall binaries are redistributed (in an APK, for instance).',
});

export const TOOLCHAINS = Object.freeze({
  /** MSYS2, for the Windows build: the UCRT64 environment's GCC, CMake and Ninja */
  msys2Root: 'C:/msys64',
  /** the Android NDK and the SDK's CMake, for the Android builds */
  ndkVersion: '27.1.12297006',
  androidCmakeVersion: '3.22.1',
  /** posix_spawn (Polycall's provider host) is in bionic from API 28 */
  androidApi: 28,
  androidAbis: ['arm64-v8a', 'x86_64'] as const,
  /** Android 15+ devices may use 16 KB pages: every loadable segment is aligned to them */
  androidPageSize: 16384,
});

export type AndroidAbi = (typeof TOOLCHAINS.androidAbis)[number];
export const ELF_MACHINE_OF_ABI: Readonly<Record<AndroidAbi, string>> = Object.freeze({ 'arm64-v8a': 'aarch64', x86_64: 'x86_64' });
