/**
 * The torn and malformed recordings the conformance of the replay reader is tested on — each DERIVED from the real demo.obr, deterministically, by one small
 * change: the tests read them through ObicallReplayReader, and record-oracle.ts gives the very same bytes to the real, staged `obicall replay`. What Obicall says
 * of each is the oracle (tests/fixtures/obicall/replay-oracle.json). The CRC used to re-seal a record is the reader's own: if it were wrong, Obicall would say
 * "wire checksum mismatch" where the oracle expects another status, and the test would fail.
 */
import { crc32 } from '../../src/adapters/obicall-replay.ts';

/** Every record of demo.obr is 196 bytes: a 40-byte header and a 156-byte observation (a 2-D position with a 2×2 covariance). */
export const DEMO_RECORD_LEN = 196;
const HEADER = 40;

const copy = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Re-seal a record whose observation was changed: its CRC-32 is written again over the new bytes. */
function reseal(bytes: Uint8Array, record: number): void {
  const start = record * DEMO_RECORD_LEN;
  const length = view(bytes).getUint32(start + 8, true);
  view(bytes).setUint32(start + 12, crc32(bytes.subarray(start + HEADER, start + HEADER + length)), true);
}

export interface TornVariant {
  readonly name: string;
  readonly what: string;
  readonly bytes: Uint8Array;
}

export function tornVariants(demo: Uint8Array): TornVariant[] {
  const at = (record: number, field: number): number => record * DEMO_RECORD_LEN + field;
  const variants: [string, string, (b: Uint8Array) => Uint8Array][] = [
    ['clean', 'the recording as Obicall wrote it', (b) => b],
    ['empty', 'no byte at all: a clean end at once', () => new Uint8Array(0)],
    ['cut-in-observation', 'the last record ends 10 bytes early: a torn write', (b) => b.subarray(0, b.length - 10)],
    ['cut-in-header', 'the last record is 20 bytes of its header: a torn write', (b) => b.subarray(0, 101 * DEMO_RECORD_LEN + 20)],
    ['observation-bit-flipped', 'one bit of record 50’s observation flipped: its CRC no longer holds', (b) => { const c = copy(b); c[at(49, HEADER + 20)] = (c[at(49, HEADER + 20)] as number) ^ 1; return c; }],
    ['crc-bit-flipped', 'one bit of record 30’s CRC flipped', (b) => { const c = copy(b); c[at(29, 12)] = (c[at(29, 12)] as number) ^ 0x80; return c; }],
    ['bad-magic', 'record 10 does not start with JORB', (b) => { const c = copy(b); c[at(9, 0)] = (c[at(9, 0)] as number) ^ 0xff; return c; }],
    ['record-len-mismatch', 'record 20 says it is 197 bytes long, not 40 + its observation', (b) => { const c = copy(b); view(c).setUint32(at(19, 4), 197, true); return c; }],
    ['observation-too-large', 'record 20 says its observation is 5000 bytes, over Obicall’s 4096', (b) => { const c = copy(b); view(c).setUint32(at(19, 4), 5040, true); view(c).setUint32(at(19, 8), 5000, true); return c; }],
    ['payload-count-over-limit', 'record 40 carries 7 payload doubles — over Obicall’s 6 — re-sealed so that only the decoding can see it', (b) => { const c = copy(b); view(c).setUint32(at(39, HEADER + 100), 7, true); reseal(c, 39); return c; }],
    ['observation-short-of-covariance', 'record 60 says 5 covariance doubles, but its observation holds 4 — re-sealed', (b) => { const c = copy(b); view(c).setUint32(at(59, HEADER + 120), 5, true); reseal(c, 59); return c; }],
  ];
  return variants.map(([name, what, make]) => ({ name, what, bytes: make(demo) }));
}
