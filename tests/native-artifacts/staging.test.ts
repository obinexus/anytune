/**
 * The staging of Polycall (tools/native/): what a binary is is read from its headers, and the checks refuse what could not run where it is staged — a Windows
 * DLL with an unstaged dependency, an Android library of the wrong machine, a SONAME the loader would not find, a segment below 16 KB pages. The ELF is built
 * here byte by byte from the ELF64 specification; the staged artifacts, when present (npm run native:stage), are checked against the committed manifest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { binaryInfo, isWindowsSystemDll } from '../../tools/native/binary-info.ts';
import { POLYCALL } from '../../tools/native/pins.ts';
import { ROOT, checkArtifacts, readManifest, type ManifestArtifact } from '../../tools/native/stage.ts';
import { verifyStaged } from '../../tools/native/verify.ts';

/** A minimal ELF64 little-endian shared object: two PT_LOAD and a PT_DYNAMIC naming its SONAME and the libraries it needs. */
function elf(machine: number, align: number, soname: string, needed: readonly string[]): Uint8Array {
  const strings = ['', soname, ...needed].join('\0') + '\0';
  const strtab = new TextEncoder().encode(strings);
  const phoff = 64;
  const phnum = 3;
  const dynOff = phoff + phnum * 56;
  const dynEntries = needed.length + 3; // needed…, SONAME, STRTAB, NULL
  const strOff = dynOff + dynEntries * 16;
  const size = strOff + strtab.length;
  const bytes = new Uint8Array(size);
  const v = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  v.setUint16(16, 3, true); // ET_DYN
  v.setUint16(18, machine, true);
  v.setBigUint64(32, BigInt(phoff), true);
  v.setUint16(54, 56, true);
  v.setUint16(56, phnum, true);
  const ph = (i: number, type: number, offset: number, filesz: number, a: number): void => {
    const at = phoff + i * 56;
    v.setUint32(at, type, true);
    v.setBigUint64(at + 8, BigInt(offset), true);
    v.setBigUint64(at + 16, BigInt(offset), true); // vaddr = offset
    v.setBigUint64(at + 32, BigInt(filesz), true);
    v.setBigUint64(at + 48, BigInt(a), true);
  };
  ph(0, 1, 0, size, align);
  ph(1, 1, 0, 0, align * 2);
  ph(2, 2, dynOff, dynEntries * 16, 8);
  let at = dynOff;
  const dyn = (tag: number, value: number): void => {
    v.setBigInt64(at, BigInt(tag), true);
    v.setBigUint64(at + 8, BigInt(value), true);
    at += 16;
  };
  let offset = 1 + soname.length + 1;
  for (const lib of needed) {
    dyn(1, offset);
    offset += lib.length + 1;
  }
  dyn(14, 1);
  dyn(5, strOff);
  dyn(0, 0);
  bytes.set(strtab, strOff);
  return bytes;
}

test('an ELF shared object is read from its headers: machine, SONAME, the libraries it needs, the smallest PT_LOAD alignment', () => {
  assert.deepEqual(binaryInfo(elf(183, 16384, 'libpolycall.so', ['libdl.so', 'libc.so'])), { format: 'elf', machine: 'aarch64', kind: 'shared-object', needed: ['libdl.so', 'libc.so'], soname: 'libpolycall.so', minLoadAlign: 16384 });
  assert.equal((binaryInfo(elf(62, 4096, 'x.so', [])) as { machine: string }).machine, 'x86_64');
  assert.deepEqual(binaryInfo(new TextEncoder().encode('!<arch>\nrest')), { format: 'ar-archive' });
  assert.deepEqual(binaryInfo(new Uint8Array(10)), { format: 'unknown' });
});

const artifact = (over: Partial<ManifestArtifact>): ManifestArtifact => ({
  path: 'native/android/arm64-v8a/libpolycall.so',
  component: 'polycall',
  role: 'test',
  platform: 'android',
  arch: 'arm64-v8a',
  kind: 'shared-library',
  linkage: null,
  sha256: '0',
  bytes: 0,
  binary: binaryInfo(elf(183, 16384, 'libpolycall.so', ['libc.so'])),
  source: { repository: POLYCALL.repository, commit: POLYCALL.commit, version: POLYCALL.version },
  toolchain: null,
  ...over,
});

test('an Android library is refused when it could not load where it is staged: the wrong machine, 4 KB pages, a versioned SONAME, an unstaged dependency', () => {
  assert.deepEqual(checkArtifacts([artifact({})]), []);
  assert.match(checkArtifacts([artifact({ binary: binaryInfo(elf(62, 16384, 'libpolycall.so', [])) })]).join(), /machine x86_64 in the arm64-v8a directory/);
  assert.match(checkArtifacts([artifact({ binary: binaryInfo(elf(183, 4096, 'libpolycall.so', [])) })]).join(), /aligned to 4096, below Android's 16 KB pages/);
  assert.match(checkArtifacts([artifact({ binary: binaryInfo(elf(183, 16384, 'libpolycall.so.1', [])) })]).join(), /SONAME libpolycall\.so\.1, not its file name/);
  assert.match(checkArtifacts([artifact({ binary: binaryInfo(elf(183, 16384, 'libpolycall.so', ['libssl.so'])) })]).join(), /needs libssl\.so, which is neither a platform library nor staged/);
});

test('a Windows DLL is refused when it imports a DLL that is neither Windows’ own nor staged beside it — the companion set must be complete', () => {
  const pe = (imports: string[]): ManifestArtifact =>
    artifact({ path: 'native/windows-x86_64/bin/polycall.exe', platform: 'windows', arch: 'x86_64', kind: 'executable', binary: { format: 'pe', machine: 'x86_64', kind: 'executable', subsystem: 'console', imports, exports: [] } });
  assert.deepEqual(checkArtifacts([pe(['KERNEL32.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'WS2_32.dll'])]), []);
  assert.match(checkArtifacts([pe(['KERNEL32.dll', 'libgcc_s_seh-1.dll'])]).join(), /imports libgcc_s_seh-1\.dll, which is neither a Windows system DLL nor staged/);
  assert.ok(isWindowsSystemDll('api-ms-win-crt-stdio-l1-1-0.dll') && !isWindowsSystemDll('libwinpthread-1.dll'));
});

test('the staged Polycall, when present, is what native/manifest.json records — hashes, machines, dependencies, alignment — and comes from the pinned commit', (t) => {
  const manifest = readManifest();
  assert.ok(manifest, 'native/manifest.json is committed');
  assert.equal(manifest.polycall.commit, POLYCALL.commit);
  const polycall = manifest.artifacts.filter((a) => a.component === 'polycall');
  assert.ok(polycall.every((a) => a.source.commit === POLYCALL.commit && a.source.version === POLYCALL.version));
  // the manifest names what must be staged: the CLI, the shared, import and static libraries, the headers, both licence texts, an Android library per ABI
  for (const name of ['native/windows-x86_64/bin/polycall.exe', 'native/windows-x86_64/bin/libpolycall.dll', 'native/windows-x86_64/lib/libpolycall.dll.a', 'native/windows-x86_64/lib/libpolycall.a', 'native/include/polycall/polycall_runtime.h', 'native/licenses/polycall/LICENSE', 'native/licenses/polycall/LICENSE.md', 'native/android/arm64-v8a/libpolycall.so', 'native/android/x86_64/libpolycall.so']) {
    assert.ok(polycall.some((a) => a.path === name), name);
  }
  assert.deepEqual(checkArtifacts(manifest.artifacts), []);
  if (!fs.existsSync(path.join(ROOT, 'native', 'windows-x86_64', 'bin', 'polycall.exe'))) {
    t.skip('Polycall is not staged in this checkout (npm run native:stage): the manifest’s own consistency is what was checked');
    return;
  }
  assert.deepEqual(verifyStaged(manifest.artifacts), []);
});
