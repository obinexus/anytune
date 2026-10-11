/**
 * Stages Polycall — AnyTune's only polyglot runtime — inside this workspace, built from its pinned commit (tools/native/pins.ts):
 *
 *   native/windows-x86_64/bin/   polycall.exe (CLI and runtime host), libpolycall.dll (the shared library, for consumers that link it)
 *   native/windows-x86_64/lib/   libpolycall.dll.a (import library), libpolycall.a (static; AnyTune's recorder plugin links it, as Polycall's plugins do)
 *   native/include/polycall/     the installed public headers
 *   native/android/<abi>/        libpolycall.so for arm64-v8a and x86_64: built with the NDK, stripped, 16 KB-aligned — packaged by Gradle as is
 *   native/licenses/polycall/    LICENSE and LICENSE.md, beside the binaries
 *   native/manifest.json         every staged file: SHA-256, size, platform, architecture, kind, linkage, imports/needs, source commit, toolchain, licence
 *
 * The Windows build is MSYS2 UCRT64 (GCC, CMake, Ninja), linked with --no-insert-timestamp so that the same toolchain gives the same bytes; the Android build
 * is the NDK's toolchain with the SDK's CMake. Every tool is run with an argument array, never through a shell. The source is the pinned commit, taken from
 * a local checkout (read with `git archive`, never modified) or fetched from the repository; a tree whose version is not the pinned one is refused.
 *
 *   node tools/native/stage.ts [--polycall-src PATH] [--test] [--no-windows] [--no-android]
 *
 *   --polycall-src PATH  a local clone of github.com/obinexus/polycall that has the pinned commit (else it is fetched)
 *   --test               also build Polycall's own test suite on Windows and run it (ctest); it needs Node, Python, Go and Java on PATH
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binaryInfo, isWindowsSystemDll, ANDROID_SYSTEM_LIBS, type BinaryInfo } from './binary-info.ts';
import { ELF_MACHINE_OF_ABI, POLYCALL, TOOLCHAINS, type AndroidAbi } from './pins.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const NATIVE = path.join(ROOT, 'native');
const CACHE = path.join(NATIVE, '.cache');
const posix = (p: string): string => path.relative(ROOT, p).split(path.sep).join('/');

function run(command: string, args: readonly string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${path.basename(command)} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(' ')} exited ${result.status}\n${String(result.stderr ?? '').slice(-4000)}${String(result.stdout ?? '').slice(-4000)}`);
  return String(result.stdout ?? '');
}

const step = (what: string): void => console.log(`\n== ${what}`);

/** The pinned Polycall source, extracted under native/.cache/src — from a local checkout (read-only) or fetched. */
export function ensureSource(localCheckout: string | null): string {
  const dir = path.join(CACHE, 'src', `polycall-${POLYCALL.commit.slice(0, 12)}`);
  const marker = path.join(dir, '.anytune-source.json');
  if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).commit === POLYCALL.commit) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let gitDir: string;
  let from: string;
  if (localCheckout !== null) {
    gitDir = localCheckout;
    from = `local checkout ${localCheckout}`;
  } else {
    gitDir = path.join(CACHE, 'polycall.git');
    if (!fs.existsSync(gitDir)) run('git', ['clone', '--bare', '--filter=blob:none', POLYCALL.repository, gitDir]);
    run('git', ['-C', gitDir, 'fetch', 'origin', POLYCALL.commit]);
    from = POLYCALL.repository;
  }
  const type = run('git', ['-C', gitDir, 'cat-file', '-t', POLYCALL.commit]).trim();
  if (type !== 'commit') throw new Error(`${from} does not have commit ${POLYCALL.commit}`);
  // the archive goes to tar through stdin, extracted in its working directory: GNU tar misreads Windows paths ("C:" as a remote host)
  const archive = spawnSync('git', ['-C', gitDir, 'archive', '--format=tar', POLYCALL.commit], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr)}`);
  const untar = spawnSync('tar', ['-x', '-f', '-'], { input: archive.stdout, cwd: dir });
  if (untar.status !== 0) throw new Error(`tar failed: ${String(untar.stderr)}`);
  const exportHeader = fs.readFileSync(path.join(dir, 'include', 'polycall_export.h'), 'utf8');
  const version = /POLYCALL_ABI_VERSION_STRING\s+"([^"]+)"/.exec(exportHeader)?.[1];
  if (version !== POLYCALL.version) throw new Error(`the source at ${POLYCALL.commit} says version ${version}, not the pinned ${POLYCALL.version}`);
  fs.writeFileSync(marker, JSON.stringify({ commit: POLYCALL.commit, from }, null, 2));
  return dir;
}

function msysEnv(extraPath: readonly string[] = []): NodeJS.ProcessEnv {
  const ucrt = path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin');
  const usr = path.join(TOOLCHAINS.msys2Root, 'usr', 'bin');
  if (!fs.existsSync(path.join(ucrt, 'gcc.exe'))) throw new Error(`MSYS2 UCRT64 GCC is not at ${ucrt}: install MSYS2 and mingw-w64-ucrt-x86_64-{gcc,cmake,ninja}`);
  // the UCRT64 compiler's back end needs its own DLLs on PATH: they are put first. PROCESSOR_ARCHITECTURE is pinned: CMake reads it as the host processor,
  // and Polycall's executable reports it ("AMD64-Windows") — left to the caller's environment, the same source would build to different bytes
  return { ...process.env, MSYSTEM: 'UCRT64', PROCESSOR_ARCHITECTURE: 'AMD64', PATH: [ucrt, usr, ...extraPath, process.env.PATH ?? ''].join(path.delimiter) };
}

export interface WindowsBuild {
  readonly prefix: string;
  readonly toolchain: string;
}

/** Polycall for Windows x86-64 (MSYS2 UCRT64), installed under native/.cache/install/windows-x86_64. */
export function buildWindows(src: string, withTests: boolean): WindowsBuild {
  const env = msysEnv();
  const cmake = path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin', 'cmake.exe');
  const build = path.join(CACHE, 'build', 'polycall-windows-x86_64');
  const prefix = path.join(CACHE, 'install', 'windows-x86_64');
  const deterministic = '-Wl,--no-insert-timestamp';
  fs.rmSync(prefix, { recursive: true, force: true });
  run(cmake, ['-S', src, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=OFF', `-DCMAKE_EXE_LINKER_FLAGS=${deterministic}`, `-DCMAKE_SHARED_LINKER_FLAGS=${deterministic}`, `-DCMAKE_MODULE_LINKER_FLAGS=${deterministic}`], { env });
  run(cmake, ['--build', build], { env });
  run(cmake, ['--install', build, '--prefix', prefix], { env });
  if (withTests) {
    step('Polycall’s own tests (Windows, UCRT64)');
    const tested = path.join(CACHE, 'build', 'polycall-windows-x86_64-tests');
    const extra = [path.dirname(process.execPath), 'C:/Program Files/Go/bin', 'C:/Program Files/Common Files/Oracle/Java/javapath'];
    const testEnv = { ...msysEnv(extra), GOCACHE: path.join(CACHE, 'gocache') };
    run(cmake, ['-S', src, '-B', tested, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=ON'], { env: testEnv });
    run(cmake, ['--build', tested], { env: testEnv });
    const ctest = path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin', 'ctest.exe');
    console.log(run(ctest, ['--test-dir', tested, '-C', 'Release', '--output-on-failure'], { env: testEnv }).split('\n').filter((l) => /tests passed|Test +#/.test(l)).join('\n'));
  }
  const gcc = run(path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin', 'gcc.exe'), ['--version'], { env }).split('\n')[0]?.trim() ?? '';
  const cmakeVersion = run(cmake, ['--version'], { env }).split('\n')[0]?.trim() ?? '';
  return { prefix, toolchain: `MSYS2 UCRT64: ${gcc}; ${cmakeVersion}; -Wl,--no-insert-timestamp` };
}

export interface AndroidBuild {
  readonly library: string;
  readonly toolchain: string;
}

function androidSdk(): string {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  if (!fs.existsSync(sdk)) throw new Error(`no Android SDK at ${sdk}: set ANDROID_HOME`);
  return sdk;
}

/** Polycall's shared library for one Android ABI: the NDK's clang, API 28, 16 KB pages, stripped of what the loader does not need. */
export function buildAndroid(src: string, abi: AndroidAbi): AndroidBuild {
  const sdk = androidSdk();
  const ndk = path.join(sdk, 'ndk', TOOLCHAINS.ndkVersion);
  const cmakeBin = path.join(sdk, 'cmake', TOOLCHAINS.androidCmakeVersion, 'bin');
  if (!fs.existsSync(ndk)) throw new Error(`NDK ${TOOLCHAINS.ndkVersion} is not at ${ndk}: install it with the SDK manager`);
  const build = path.join(CACHE, 'build', `polycall-android-${abi}`);
  run(path.join(cmakeBin, 'cmake.exe'), [
    '-S', src, '-B', build, '-G', 'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${path.join(cmakeBin, 'ninja.exe')}`,
    `-DCMAKE_TOOLCHAIN_FILE=${path.join(ndk, 'build', 'cmake', 'android.toolchain.cmake')}`,
    `-DANDROID_ABI=${abi}`, `-DANDROID_PLATFORM=android-${TOOLCHAINS.androidApi}`,
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=OFF', '-DPOLYCALL_BUILD_CLI=OFF', '-DPOLYCALL_BUILD_STATIC=OFF', '-DPOLYCALL_INSTALL=OFF',
    `-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=${TOOLCHAINS.androidPageSize}`,
  ]);
  run(path.join(cmakeBin, 'cmake.exe'), ['--build', build]);
  const llvm = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
  const library = path.join(build, 'stripped', 'libpolycall.so');
  fs.mkdirSync(path.dirname(library), { recursive: true });
  run(path.join(llvm, 'llvm-strip.exe'), ['--strip-unneeded', '-o', library, path.join(build, 'lib', 'libpolycall.so')]);
  const clang = run(path.join(llvm, 'clang.exe'), ['--version']).split('\n')[0]?.trim() ?? '';
  return { library, toolchain: `Android NDK r27b (${TOOLCHAINS.ndkVersion}): ${clang}; API ${TOOLCHAINS.androidApi}; max-page-size ${TOOLCHAINS.androidPageSize}; llvm-strip --strip-unneeded` };
}

export type ArtifactKind = 'executable' | 'shared-library' | 'import-library' | 'static-library' | 'header' | 'license';

export interface ManifestArtifact {
  readonly path: string;
  readonly component: 'polycall' | 'anytune-recorder';
  readonly role: string;
  readonly platform: 'windows' | 'android' | 'any';
  readonly arch: 'x86_64' | AndroidAbi | 'any';
  readonly kind: ArtifactKind;
  readonly linkage: string | null;
  readonly sha256: string;
  readonly bytes: number;
  readonly binary: BinaryInfo | null;
  readonly source: { readonly repository: string; readonly commit: string; readonly version: string };
  readonly toolchain: string | null;
}

export const sha256Of = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function describe(file: string, fields: Omit<ManifestArtifact, 'path' | 'sha256' | 'bytes' | 'binary'>): ManifestArtifact {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const binary = fields.kind === 'header' || fields.kind === 'license' ? null : binaryInfo(bytes);
  return { path: posix(file), ...fields, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, binary };
}

const copy = (from: string, to: string): string => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return to;
};

export const MANIFEST = path.join(NATIVE, 'manifest.json');

export interface Manifest {
  readonly about: string;
  readonly polycall: typeof POLYCALL;
  readonly toolchains: Readonly<Record<string, string>>;
  readonly artifacts: readonly ManifestArtifact[];
}

export function readManifest(): Manifest | null {
  return fs.existsSync(MANIFEST) ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest) : null;
}

/** Replace the artifacts of some components in native/manifest.json, keeping the others, in a stable order. */
export function writeManifest(artifacts: readonly ManifestArtifact[], toolchains: Readonly<Record<string, string>>): void {
  const previous = readManifest();
  const components = new Set(artifacts.map((a) => a.component));
  const kept = (previous?.artifacts ?? []).filter((a) => !components.has(a.component) && fs.existsSync(path.join(ROOT, a.path)));
  const all = [...kept, ...artifacts].sort((a, b) => a.path.localeCompare(b.path));
  const manifest: Manifest = {
    about:
      'The native artifacts staged in this workspace, written by tools/native/stage.ts and checked by tools/native/verify.ts (npm run native:verify). The files themselves are not committed: they are rebuilt from the pinned sources, and with the same toolchains they hash to what is recorded here.',
    polycall: POLYCALL,
    toolchains: { ...(previous?.toolchains ?? {}), ...toolchains },
    artifacts: all,
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function stagePolycall(src: string, windows: WindowsBuild | null, android: ReadonlyMap<AndroidAbi, AndroidBuild>): ManifestArtifact[] {
  const source = { repository: POLYCALL.repository, commit: POLYCALL.commit, version: POLYCALL.version };
  const out: ManifestArtifact[] = [];
  const any = { component: 'polycall' as const, platform: 'any' as const, arch: 'any' as const, linkage: null, source, toolchain: null };
  for (const name of POLYCALL.licenseFiles) {
    out.push(describe(copy(path.join(src, name), path.join(NATIVE, 'licenses', 'polycall', name)), { ...any, role: `licence text (${POLYCALL.licenseNote})`, kind: 'license' }));
  }
  if (windows !== null) {
    const win = { component: 'polycall' as const, platform: 'windows' as const, arch: 'x86_64' as const, source, toolchain: windows.toolchain };
    const bin = path.join(NATIVE, 'windows-x86_64', 'bin');
    const lib = path.join(NATIVE, 'windows-x86_64', 'lib');
    out.push(describe(copy(path.join(windows.prefix, 'bin', 'polycall.exe'), path.join(bin, 'polycall.exe')), { ...win, role: 'the Polycall CLI and runtime host: `polycall start --load <plugin>` serves polycall_rpc v1 on loopback', kind: 'executable', linkage: 'links libpolycall statically; imports Windows system DLLs only' }));
    out.push(describe(copy(path.join(windows.prefix, 'bin', 'libpolycall.dll'), path.join(bin, 'libpolycall.dll')), { ...win, role: 'the Polycall shared library (Binding ABI v1, runtime, config): for consumers that link it dynamically', kind: 'shared-library', linkage: 'dynamic; imports Windows system DLLs only' }));
    out.push(describe(copy(path.join(windows.prefix, 'lib', 'libpolycall.dll.a'), path.join(lib, 'libpolycall.dll.a')), { ...win, role: 'import library of libpolycall.dll (MinGW)', kind: 'import-library', linkage: 'import library for libpolycall.dll' }));
    out.push(describe(copy(path.join(windows.prefix, 'lib', 'libpolycall.a'), path.join(lib, 'libpolycall.a')), { ...win, role: 'the Polycall static library: operation plugins link it, as Polycall’s own plugins do (docs/PLUGINS.md)', kind: 'static-library', linkage: 'static' }));
    for (const header of fs.readdirSync(path.join(windows.prefix, 'include', 'polycall')).sort()) {
      out.push(describe(copy(path.join(windows.prefix, 'include', 'polycall', header), path.join(NATIVE, 'include', 'polycall', header)), { ...any, role: 'public header', kind: 'header' }));
    }
  }
  for (const [abi, build] of android) {
    out.push(describe(copy(build.library, path.join(NATIVE, 'android', abi, 'libpolycall.so')), { component: 'polycall', platform: 'android', arch: abi, source, toolchain: build.toolchain, role: 'the Polycall shared library for Android, packaged in the APK by Gradle and loaded by AnyTune’s JNI bridge', kind: 'shared-library', linkage: 'dynamic; needs libc, libm, libdl only' }));
  }
  return out;
}

/** Problems of the staged artifacts against what they must be: their machine, their dependencies, their alignment. Empty when all hold. */
export function checkArtifacts(artifacts: readonly ManifestArtifact[]): string[] {
  const problems: string[] = [];
  const staged = new Set(artifacts.map((a) => path.posix.basename(a.path).toLowerCase()));
  for (const a of artifacts) {
    const b = a.binary;
    if (b === null) continue;
    if (a.platform === 'windows' && (a.kind === 'executable' || a.kind === 'shared-library')) {
      if (b.format !== 'pe') problems.push(`${a.path}: a Windows ${a.kind} that is not a PE file`);
      else {
        if (b.machine !== 'x86_64') problems.push(`${a.path}: machine ${b.machine}, not x86_64`);
        if (b.kind !== (a.kind === 'executable' ? 'executable' : 'dll')) problems.push(`${a.path}: a PE ${b.kind}, recorded as ${a.kind}`);
        for (const dll of b.imports) if (!isWindowsSystemDll(dll) && !staged.has(dll.toLowerCase())) problems.push(`${a.path}: imports ${dll}, which is neither a Windows system DLL nor staged beside it`);
      }
    }
    if (a.platform === 'android' && a.kind === 'shared-library') {
      if (b.format !== 'elf') problems.push(`${a.path}: an Android library that is not ELF`);
      else {
        if (b.machine !== ELF_MACHINE_OF_ABI[a.arch as AndroidAbi]) problems.push(`${a.path}: machine ${b.machine} in the ${a.arch} directory`);
        if (b.kind !== 'shared-object') problems.push(`${a.path}: ELF ${b.kind}, not a shared object`);
        if (b.minLoadAlign < TOOLCHAINS.androidPageSize) problems.push(`${a.path}: a loadable segment aligned to ${b.minLoadAlign}, below Android's 16 KB pages`);
        if (b.soname !== path.posix.basename(a.path)) problems.push(`${a.path}: SONAME ${b.soname}, not its file name — the Android loader would not find it`);
        for (const lib of b.needed) if (!ANDROID_SYSTEM_LIBS.includes(lib) && !staged.has(lib.toLowerCase())) problems.push(`${a.path}: needs ${lib}, which is neither a platform library nor staged`);
      }
    }
    if ((a.kind === 'static-library' || a.kind === 'import-library') && b.format !== 'ar-archive') problems.push(`${a.path}: a ${a.kind} that is not an ar archive`);
  }
  return problems;
}

function main(argv: readonly string[]): void {
  const at = argv.indexOf('--polycall-src');
  const local = at === -1 ? null : (argv[at + 1] ?? null);
  const withTests = argv.includes('--test');
  step(`Polycall ${POLYCALL.version} at ${POLYCALL.commit} (${POLYCALL.branch})`);
  const src = ensureSource(local);
  console.log(`source: ${posix(src)}`);
  const toolchains: Record<string, string> = {};
  let windows: WindowsBuild | null = null;
  if (!argv.includes('--no-windows')) {
    step('Windows x86-64 (MSYS2 UCRT64)');
    windows = buildWindows(src, withTests);
    toolchains['windows-x86_64'] = windows.toolchain;
  }
  const android = new Map<AndroidAbi, AndroidBuild>();
  if (!argv.includes('--no-android')) {
    for (const abi of TOOLCHAINS.androidAbis) {
      step(`Android ${abi} (NDK)`);
      const build = buildAndroid(src, abi);
      android.set(abi, build);
      toolchains[`android-${abi}`] = build.toolchain;
    }
  }
  step('staging into native/');
  const artifacts = stagePolycall(src, windows, android);
  const problems = checkArtifacts(artifacts);
  if (problems.length > 0) throw new Error(`the staged artifacts do not hold:\n${problems.join('\n')}`);
  writeManifest(artifacts, toolchains);
  for (const a of artifacts.filter((x) => x.kind !== 'header')) console.log(`${a.sha256.slice(0, 16)}  ${String(a.bytes).padStart(8)}  ${a.path}`);
  console.log(`\n${artifacts.length} files staged; native/manifest.json written. Check with: npm run native:verify`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nstaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
