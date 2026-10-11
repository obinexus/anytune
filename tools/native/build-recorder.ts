/**
 * Builds AnyTune's recorder module (native/recorder) for Windows x86-64 against the staged Polycall (npm run native:stage first), runs its C tests, and stages
 * the Polycall operation plugin as native/windows-x86_64/lib/anytune_recorder.dll, recorded in native/manifest.json (component "anytune-recorder"). Its source
 * is named by the SHA-256 of the recorder's source tree (recorderTreeSha256) — a commit cannot name itself in a file it contains — and npm run native:verify
 * recomputes it, so a plugin built from older sources is caught.
 *
 *   node tools/native/build-recorder.ts        (npm run native:recorder)
 *
 * On Android the same sources are compiled into the JNI bridge by Gradle (apps/android); this script is the desktop host's build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { POLYCALL, TOOLCHAINS } from './pins.ts';
import { NATIVE, checkArtifacts, copy, describe, msysEnv, recorderTreeSha256, run, writeManifest } from './stage.ts';

function main(): void {
  const include = path.join(NATIVE, 'include', 'polycall');
  const staticLibrary = path.join(NATIVE, 'windows-x86_64', 'lib', 'libpolycall.a');
  if (!fs.existsSync(path.join(include, 'polycall_runtime.h')) || !fs.existsSync(staticLibrary)) throw new Error('Polycall is not staged: run npm run native:stage first');
  const env = msysEnv();
  const cmake = path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin', 'cmake.exe');
  const ctest = path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin', 'ctest.exe');
  const build = path.join(NATIVE, '.cache', 'build', 'recorder-windows-x86_64');
  const deterministic = '-Wl,--no-insert-timestamp';
  run(cmake, ['-S', path.join(NATIVE, 'recorder'), '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', `-DPOLYCALL_INCLUDE_DIR=${include}`, `-DPOLYCALL_STATIC_LIBRARY=${staticLibrary}`, `-DCMAKE_MODULE_LINKER_FLAGS=${deterministic}`, `-DCMAKE_EXE_LINKER_FLAGS=${deterministic}`], { env });
  run(cmake, ['--build', build], { env });
  console.log(run(ctest, ['--test-dir', build, '--output-on-failure'], { env }).split('\n').filter((l) => /tests passed|Test +#/.test(l)).join('\n'));

  const tree = recorderTreeSha256();
  const gcc = run(path.join(TOOLCHAINS.msys2Root, 'ucrt64', 'bin', 'gcc.exe'), ['--version'], { env }).split('\n')[0]?.trim() ?? '';
  const artifact = describe(copy(path.join(build, 'anytune_recorder.dll'), path.join(NATIVE, 'windows-x86_64', 'lib', 'anytune_recorder.dll')), {
    component: 'anytune-recorder',
    role: 'AnyTune’s recorder module as a Polycall operation plugin: `polycall start --load anytune_recorder.dll` serves recording.create/append/finish/read/list (docs/RECORDING.md)',
    platform: 'windows',
    arch: 'x86_64',
    kind: 'shared-library',
    linkage: `a Polycall plugin (exports polycall_ops_register); links libpolycall.a ${POLYCALL.version} statically; imports Windows system DLLs only`,
    source: { repository: 'https://github.com/obinexus/anytune', commit: `tree-sha256:${tree}`, version: '1.0.0' },
    toolchain: `MSYS2 UCRT64: ${gcc}; ${deterministic}`,
  });
  const problems = checkArtifacts([artifact]);
  if (artifact.binary?.format !== 'pe' || artifact.binary.exports.join() !== 'polycall_ops_register') problems.push('the plugin must export exactly polycall_ops_register');
  if (problems.length > 0) throw new Error(problems.join('\n'));
  writeManifest([artifact], {});
  console.log(`${artifact.sha256.slice(0, 16)}  ${artifact.bytes}  ${artifact.path}  (sources: tree-sha256 ${tree.slice(0, 16)})`);
}

try {
  main();
} catch (error) {
  console.error(`recorder build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
