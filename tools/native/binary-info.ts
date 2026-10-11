/**
 * What a native artifact is, read from its own headers — never from its name: a Windows PE (machine, DLL or executable, the DLLs it imports, the names it
 * exports), an ELF shared object (machine, the libraries it needs, its SONAME, the alignment of its loadable segments — Android's 16 KB page devices need
 * every PT_LOAD aligned to at least 16 384 bytes), or a static archive. The staging of Polycall (tools/native/stage.ts) records this in native/manifest.json,
 * and tools/native/verify.ts checks it again, so that an x86-64 Windows DLL can never pass for an Android library, nor an arm64 library for an x86_64 one.
 */

export type BinaryInfo =
  | {
      readonly format: 'pe';
      /** `x86_64`, `i386`, `arm64`, or `unknown (0x…)` */
      readonly machine: string;
      readonly kind: 'executable' | 'dll';
      readonly subsystem: 'console' | 'gui' | 'other';
      /** the DLLs named in the import directory, as written */
      readonly imports: readonly string[];
      /** the exported names, sorted */
      readonly exports: readonly string[];
    }
  | {
      readonly format: 'elf';
      /** `aarch64`, `x86_64`, or `unknown (…)` */
      readonly machine: string;
      readonly kind: 'shared-object' | 'executable' | 'other';
      readonly needed: readonly string[];
      readonly soname: string | null;
      /** the smallest p_align of the PT_LOAD segments */
      readonly minLoadAlign: number;
    }
  | { readonly format: 'ar-archive' }
  | { readonly format: 'unknown' };

const PE_MACHINES: Readonly<Record<number, string>> = { 0x8664: 'x86_64', 0x14c: 'i386', 0xaa64: 'arm64' };
const ELF_MACHINES: Readonly<Record<number, string>> = { 183: 'aarch64', 62: 'x86_64', 40: 'arm', 3: 'i386' };

const cString = (bytes: Uint8Array, at: number): string => {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(at, end));
};

function peInfo(bytes: Uint8Array, view: DataView): BinaryInfo {
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550) return { format: 'unknown' };
  const machineCode = view.getUint16(pe + 4, true);
  const sections = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const characteristics = view.getUint16(pe + 22, true);
  const optional = pe + 24;
  const magic = view.getUint16(optional, true);
  const plus = magic === 0x20b;
  const subsystemCode = view.getUint16(optional + 68, true);
  const directories = optional + (plus ? 112 : 96);
  const directoryCount = view.getUint32(optional + (plus ? 108 : 92), true);
  const directory = (index: number): { rva: number; size: number } =>
    index < directoryCount ? { rva: view.getUint32(directories + index * 8, true), size: view.getUint32(directories + index * 8 + 4, true) } : { rva: 0, size: 0 };
  const table = optional + optionalSize;
  const sectionList = Array.from({ length: sections }, (_, i) => {
    const at = table + i * 40;
    return { va: view.getUint32(at + 12, true), virtualSize: view.getUint32(at + 8, true), rawSize: view.getUint32(at + 16, true), raw: view.getUint32(at + 20, true) };
  });
  const offsetOf = (rva: number): number | null => {
    for (const s of sectionList) if (rva >= s.va && rva < s.va + Math.max(s.virtualSize, s.rawSize)) return rva - s.va + s.raw;
    return null;
  };
  const imports: string[] = [];
  const importDir = directory(1);
  let at = importDir.rva === 0 ? null : offsetOf(importDir.rva);
  while (at !== null && at + 20 <= bytes.length) {
    const nameRva = view.getUint32(at + 12, true);
    const firstThunk = view.getUint32(at + 16, true);
    if (nameRva === 0 && firstThunk === 0) break;
    const nameAt = offsetOf(nameRva);
    if (nameAt !== null) imports.push(cString(bytes, nameAt));
    at += 20;
  }
  const exports: string[] = [];
  const exportDir = directory(0);
  const exportAt = exportDir.rva === 0 ? null : offsetOf(exportDir.rva);
  if (exportAt !== null) {
    const names = view.getUint32(exportAt + 24, true);
    const namesAt = offsetOf(view.getUint32(exportAt + 32, true));
    for (let i = 0; namesAt !== null && i < names; i++) {
      const nameAt = offsetOf(view.getUint32(namesAt + i * 4, true));
      if (nameAt !== null) exports.push(cString(bytes, nameAt));
    }
  }
  return {
    format: 'pe',
    machine: PE_MACHINES[machineCode] ?? `unknown (0x${machineCode.toString(16)})`,
    kind: characteristics & 0x2000 ? 'dll' : 'executable',
    subsystem: subsystemCode === 3 ? 'console' : subsystemCode === 2 ? 'gui' : 'other',
    imports,
    exports: exports.sort(),
  };
}

function elfInfo(bytes: Uint8Array, view: DataView): BinaryInfo {
  if (bytes[4] !== 2 || bytes[5] !== 1) return { format: 'unknown' }; // 64-bit little-endian only: what Android arm64-v8a and x86_64 are
  const type = view.getUint16(16, true);
  const machineCode = view.getUint16(18, true);
  const phoff = Number(view.getBigUint64(32, true));
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  const segments = Array.from({ length: phnum }, (_, i) => {
    const at = phoff + i * phentsize;
    return {
      type: view.getUint32(at, true),
      offset: Number(view.getBigUint64(at + 8, true)),
      vaddr: Number(view.getBigUint64(at + 16, true)),
      filesz: Number(view.getBigUint64(at + 32, true)),
      align: Number(view.getBigUint64(at + 48, true)),
    };
  });
  const loads = segments.filter((s) => s.type === 1);
  const offsetOf = (vaddr: number): number | null => {
    for (const s of loads) if (vaddr >= s.vaddr && vaddr < s.vaddr + s.filesz) return vaddr - s.vaddr + s.offset;
    return null;
  };
  const needed: number[] = [];
  let soname: number | null = null;
  let strtab: number | null = null;
  const dynamic = segments.find((s) => s.type === 2);
  for (let at = dynamic?.offset ?? 0; dynamic !== undefined && at + 16 <= dynamic.offset + dynamic.filesz; at += 16) {
    const tag = Number(view.getBigInt64(at, true));
    const value = Number(view.getBigUint64(at + 8, true));
    if (tag === 0) break;
    if (tag === 1) needed.push(value);
    else if (tag === 14) soname = value;
    else if (tag === 5) strtab = value;
  }
  const strtabAt = strtab === null ? null : offsetOf(strtab);
  const str = (offset: number): string => (strtabAt === null ? `?${offset}` : cString(bytes, strtabAt + offset));
  return {
    format: 'elf',
    machine: ELF_MACHINES[machineCode] ?? `unknown (${machineCode})`,
    kind: type === 3 ? 'shared-object' : type === 2 ? 'executable' : 'other',
    needed: needed.map(str),
    soname: soname === null ? null : str(soname),
    minLoadAlign: loads.length === 0 ? 0 : Math.min(...loads.map((s) => s.align)),
  };
}

/** What the bytes are, from their headers. */
export function binaryInfo(bytes: Uint8Array): BinaryInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) return peInfo(bytes, view);
  if (bytes.length >= 64 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return elfInfo(bytes, view);
  if (bytes.length >= 8 && new TextDecoder('latin1').decode(bytes.subarray(0, 8)) === '!<arch>\n') return { format: 'ar-archive' };
  return { format: 'unknown' };
}

/** The Windows DLLs every supported Windows 10/11 has: an artifact importing only these needs nothing staged beside it. */
export const WINDOWS_SYSTEM_DLLS: readonly string[] = ['kernel32.dll', 'ws2_32.dll', 'shell32.dll', 'advapi32.dll', 'bcrypt.dll', 'user32.dll', 'ole32.dll', 'ntdll.dll'];
export const isWindowsSystemDll = (name: string): boolean => {
  const lower = name.toLowerCase();
  return WINDOWS_SYSTEM_DLLS.includes(lower) || lower.startsWith('api-ms-win-crt-') || lower.startsWith('api-ms-win-core-');
};

/** The libraries an Android app may link from the platform (the NDK's stable APIs) without packaging them. */
export const ANDROID_SYSTEM_LIBS: readonly string[] = ['libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so', 'libaaudio.so', 'libOpenSLES.so'];
