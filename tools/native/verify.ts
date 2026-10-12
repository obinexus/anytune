/**
 * Checks the staged native artifacts against native/manifest.json: each file is there, has the recorded SHA-256 and size, and still is what its headers said
 * (machine, kind, imports or needed libraries, 16 KB alignment on Android) — and every Windows executable or DLL imports only Windows system DLLs or files
 * staged beside it. With --apk, it also checks that the Android libraries inside a built APK are byte for byte the staged ones.
 *
 *   node tools/native/verify.ts [--apk path/to/app.apk]        (npm run native:verify)
 *
 * Exit status 0 when everything holds; 1, with every problem listed, when anything does not. A hash that differs on another machine usually means another
 * toolchain: the manifest records the one each artifact was built with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { binaryInfo } from './binary-info.ts';
import { ROOT, checkArtifacts, readManifest, recorderTreeSha256, sha256Of, type ManifestArtifact } from './stage.ts';
import { zipEntries } from './zip.ts';

export function verifyStaged(artifacts: readonly ManifestArtifact[]): string[] {
  const problems: string[] = [];
  for (const a of artifacts) {
    const file = path.join(ROOT, a.path);
    if (!fs.existsSync(file)) {
      problems.push(`${a.path}: missing — run npm run native:stage`);
      continue;
    }
    const size = fs.statSync(file).size;
    if (size !== a.bytes) problems.push(`${a.path}: ${size} bytes, the manifest says ${a.bytes}`);
    const sha = sha256Of(file);
    if (sha !== a.sha256) problems.push(`${a.path}: SHA-256 ${sha}, the manifest says ${a.sha256} (built by: ${a.toolchain ?? 'n/a'})`);
    if (a.binary !== null) {
      const now = binaryInfo(new Uint8Array(fs.readFileSync(file)));
      if (JSON.stringify(now) !== JSON.stringify(a.binary)) problems.push(`${a.path}: its headers no longer say what the manifest recorded`);
    }
  }
  const recorder = artifacts.filter((a) => a.component === 'anytune-recorder');
  if (recorder.length > 0) {
    const tree = `tree-sha256:${recorderTreeSha256()}`;
    for (const a of recorder) if (a.source.commit !== tree) problems.push(`${a.path}: built from other recorder sources than native/recorder's (${a.source.commit.slice(0, 24)}…, now ${tree.slice(0, 24)}…) — run npm run native:recorder`);
  }
  return [...problems, ...checkArtifacts(artifacts)];
}

/** The staged Android libraries against those inside an APK: lib/<abi>/<name> in the APK must be the staged native/android/<abi>/<name>, byte for byte. */
export function verifyApk(apk: string, artifacts: readonly ManifestArtifact[]): string[] {
  const problems: string[] = [];
  const entries = zipEntries(new Uint8Array(fs.readFileSync(apk)));
  for (const a of artifacts.filter((x) => x.platform === 'android' && x.kind === 'shared-library')) {
    const name = `lib/${a.arch}/${path.posix.basename(a.path)}`;
    const entry = entries.get(name);
    if (entry === undefined) problems.push(`${apk}: has no ${name}`);
    else if (entry.sha256 !== a.sha256) problems.push(`${apk}: ${name} is not the staged ${a.path} (SHA-256 ${entry.sha256}, staged ${a.sha256})`);
    else if (entry.compressed) problems.push(`${apk}: ${name} is compressed: an Android library must be stored uncompressed (and page-aligned) to load from the APK`);
  }
  return problems;
}

function main(argv: readonly string[]): void {
  const manifest = readManifest();
  if (manifest === null) throw new Error('native/manifest.json is missing: run npm run native:stage');
  const problems = verifyStaged(manifest.artifacts);
  const at = argv.indexOf('--apk');
  if (at !== -1) {
    const apk = argv[at + 1];
    if (apk === undefined) throw new Error('--apk needs a path');
    problems.push(...verifyApk(apk, manifest.artifacts));
  }
  if (problems.length > 0) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  const binaries = manifest.artifacts.filter((a) => a.binary !== null);
  console.log(`✓ ${manifest.artifacts.length} staged files hold (${binaries.length} binaries: hashes, machines, dependencies, alignment)${at === -1 ? '' : '; the APK carries the staged Android libraries'}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
