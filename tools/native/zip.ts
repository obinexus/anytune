/**
 * The entries of a ZIP archive (an APK is one), read from its central directory: name, whether it is compressed, and the SHA-256 of its uncompressed bytes.
 * Enough to check what an APK packages; not a general ZIP library (no ZIP64, no encryption — an APK has neither).
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly compressed: boolean;
  readonly size: number;
  /** of the uncompressed bytes */
  readonly sha256: string;
  /** where the entry's data starts in the archive — an uncompressed native library must start on a page boundary to be loaded in place */
  readonly dataOffset: number;
}

export function zipEntries(zip: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a ZIP archive: no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`a broken central directory at ${at}`);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder('utf-8').decode(zip.subarray(at + 46, at + 46 + nameLength));
    const dataOffset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 0 ? raw : method === 8 ? new Uint8Array(zlib.inflateRawSync(raw)) : null;
    if (data === null) throw new Error(`${name}: compression method ${method} is not read here`);
    entries.set(name, { name, compressed: method !== 0, size, sha256: crypto.createHash('sha256').update(data).digest('hex'), dataOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
