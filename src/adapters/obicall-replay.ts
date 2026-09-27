/**
 * ObicallReplayReader — a reader of Obicall's replay format (`.obr`, the journal of admitted observations), for CONFORMANCE: it reads a real Obicall recording
 * as Obicall reads it, and nothing more. It is not a pitch provider and never becomes one: Obicall's observations are positions, velocities and ranges in
 * metres, metres per second and radians — there is no unit a frequency could be carried in (docs/OBICALL.md, "Current integration boundary").
 *
 * The format, as Obicall ae5581a writes and reads it (include/obicall/journal.h, src/core/journal.c, src/core/wire.c): a stream of records with no file
 * header; each record a 40-byte little-endian header —
 *
 *   magic u32 = 0x4A4F5242 ("JORB")   record_len u32 = 40 + observation_len   observation_len u32 (≤ 4096)   crc32 u32 (CRC-32/ISO-HDLC of the observation)
 *   window_seq u64   admitted_at_ns i64   admission_reason u32   reserved u32
 *
 * — then the observation in Obicall's wire encoding. The reader stops at the first record that does not hold — it never skips past one — and leaves its offset
 * at the start of that record, as `obicall_journal_read_record` leaves the file position there so that a writer can truncate a torn tail. Every check is made
 * in Obicall's order, and a stop is named with the words Obicall's status strings use, so that the two can be compared (tests/adapters/obicall-replay.test.ts).
 */

export const JORB_MAGIC = 0x4a4f5242;
export const RECORD_HEADER_LEN = 40;
/** OBICALL_JOURNAL_MAX_RECORD_OBS_LEN */
export const MAX_OBSERVATION_LEN = 4096;
/** OBICALL_MAX_PAYLOAD_DOUBLES, OBICALL_MAX_COV_DOUBLES, OBICALL_SENSOR_ID_LEN */
export const MAX_PAYLOAD_DOUBLES = 6;
export const MAX_COVARIANCE_DOUBLES = 36;
export const SENSOR_ID_LEN = 32;

/** obicall_units_t — and nothing else: Obicall has no frequency unit. */
export const OBICALL_UNITS: Readonly<Record<number, string>> = Object.freeze({ 0: 'unspecified', 1: 'meters', 2: 'meters-per-second', 3: 'radians' });
/** obicall_payload_shape_t */
export const OBICALL_SHAPES: Readonly<Record<number, string>> = Object.freeze({ 0: 'unspecified', 1: 'position-1d', 2: 'position-2d', 3: 'position-2d-velocity', 4: 'range-1d' });

export interface ObicallRecordHeader {
  readonly magic: number;
  readonly recordLen: number;
  readonly observationLen: number;
  readonly crc32: number;
  readonly windowSeq: bigint;
  readonly admittedAtNs: bigint;
  /** obicall_admission_reason_t: 0 admitted; 1 validation, 2 duplicate, 3 late, 4 overflow, 5 sequence regression */
  readonly admissionReason: number;
  readonly reserved: number;
}

/** An observation as Obicall's wire format carries it — its fields, in its units; no field is given a meaning Obicall does not give it. */
export interface ObicallWireObservation {
  readonly structSize: number;
  readonly schemaVersion: number;
  /** the 32-byte sensor id, up to its first NUL */
  readonly sensorId: string;
  readonly sourceBootId: bigint;
  readonly sequence: bigint;
  readonly sampleTimeNs: bigint;
  readonly arrivalTimeNs: bigint;
  readonly clockDomain: number;
  readonly timeUncertaintyS: number;
  readonly coordinateFrame: number;
  /** a key of OBICALL_UNITS */
  readonly units: number;
  readonly calibrationVersion: number;
  /** a key of OBICALL_SHAPES */
  readonly payloadShape: number;
  readonly payload: readonly number[];
  readonly covariance: readonly number[];
}

export interface ObicallReplayRecord {
  /** where the record starts in the recording */
  readonly offset: number;
  readonly header: ObicallRecordHeader;
  readonly observation: ObicallWireObservation;
}

/** Why the reader stopped at a record, in the words of Obicall's status strings (obicall_status_string). */
export type ObicallStopStatus = 'malformed wire frame' | 'wire frame too large' | 'wire checksum mismatch';

export type ReplayStop =
  | { readonly kind: 'end'; readonly offset: number }
  | { readonly kind: 'stopped'; readonly offset: number; readonly obicallStatus: ObicallStopStatus; readonly reason: string };

export type ReplayStep = ({ readonly kind: 'record' } & ObicallReplayRecord) | ReplayStop;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** obicall_crc32: CRC-32/ISO-HDLC (reflected, polynomial 0xEDB88320, initial and final 0xFFFFFFFF). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A cursor over little-endian fields that, like Obicall's rcursor_t, remembers that it ran out instead of throwing. */
class Cursor {
  readonly #view: DataView;
  #at = 0;
  ok = true;
  constructor(bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  #take(n: number): number | null {
    if (!this.ok || this.#at + n > this.#view.byteLength) {
      this.ok = false;
      return null;
    }
    const at = this.#at;
    this.#at += n;
    return at;
  }
  u32(): number {
    const at = this.#take(4);
    return at === null ? 0 : this.#view.getUint32(at, true);
  }
  u64(): bigint {
    const at = this.#take(8);
    return at === null ? 0n : this.#view.getBigUint64(at, true);
  }
  i64(): bigint {
    const at = this.#take(8);
    return at === null ? 0n : this.#view.getBigInt64(at, true);
  }
  f64(): number {
    const at = this.#take(8);
    return at === null ? 0 : this.#view.getFloat64(at, true);
  }
  bytes(n: number): Uint8Array {
    const at = this.#take(n);
    return at === null ? new Uint8Array(0) : new Uint8Array(this.#view.buffer, this.#view.byteOffset + at, n);
  }
}

function decodeHeader(bytes: Uint8Array): ObicallRecordHeader {
  const c = new Cursor(bytes);
  return { magic: c.u32(), recordLen: c.u32(), observationLen: c.u32(), crc32: c.u32(), windowSeq: c.u64(), admittedAtNs: c.i64(), admissionReason: c.u32(), reserved: c.u32() };
}

const sensorIdOf = (raw: Uint8Array): string => {
  const end = raw.indexOf(0);
  return new TextDecoder('utf-8').decode(end === -1 ? raw : raw.subarray(0, end));
};

/** obicall_wire_decode_observation: null where Obicall answers OBICALL_ERR_WIRE_MALFORMED. Bytes after the covariance are not looked at — nor does Obicall. */
export function decodeWireObservation(bytes: Uint8Array): ObicallWireObservation | null {
  const c = new Cursor(bytes);
  const structSize = c.u32();
  const schemaVersion = c.u32();
  const sensorId = sensorIdOf(c.bytes(SENSOR_ID_LEN));
  const sourceBootId = c.u64();
  const sequence = c.u64();
  const sampleTimeNs = c.i64();
  const arrivalTimeNs = c.i64();
  const clockDomain = c.u32();
  const timeUncertaintyS = c.f64();
  const coordinateFrame = c.u32();
  const units = c.u32();
  const calibrationVersion = c.u32();
  const payloadShape = c.u32();
  const payloadCount = c.u32();
  if (!c.ok || payloadCount > MAX_PAYLOAD_DOUBLES) return null;
  const payload = Array.from({ length: payloadCount }, () => c.f64());
  const covarianceCount = c.u32();
  if (!c.ok || covarianceCount > MAX_COVARIANCE_DOUBLES) return null;
  const covariance = Array.from({ length: covarianceCount }, () => c.f64());
  if (!c.ok) return null;
  return { structSize, schemaVersion, sensorId, sourceBootId, sequence, sampleTimeNs, arrivalTimeNs, clockDomain, timeUncertaintyS, coordinateFrame, units, calibrationVersion, payloadShape, payload, covariance };
}

export class ObicallReplayReader {
  readonly #bytes: Uint8Array;
  #offset = 0;
  #stopped: ReplayStop | null = null;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** Where the next record starts — or, once stopped, where the record the reader stopped at starts. */
  get offset(): number {
    return this.#offset;
  }

  /** The next record, the clean end, or the stop at a record that does not hold — in the order of obicall_journal_read_record's checks. */
  next(): ReplayStep {
    if (this.#stopped !== null) return this.#stopped;
    const start = this.#offset;
    const rest = this.#bytes.length - start;
    const stop = (obicallStatus: ObicallStopStatus, reason: string): ReplayStop => (this.#stopped = { kind: 'stopped', offset: start, obicallStatus, reason });
    if (rest === 0) return (this.#stopped = { kind: 'end', offset: start });
    if (rest < RECORD_HEADER_LEN) return stop('malformed wire frame', `a header of ${rest} bytes: a torn write`);
    const header = decodeHeader(this.#bytes.subarray(start, start + RECORD_HEADER_LEN));
    if (header.magic !== JORB_MAGIC) return stop('malformed wire frame', `the magic is 0x${header.magic.toString(16)}, not JORB`);
    if (header.observationLen > MAX_OBSERVATION_LEN || header.recordLen !== RECORD_HEADER_LEN + header.observationLen) {
      return stop('wire frame too large', `record_len ${header.recordLen} with observation_len ${header.observationLen}`);
    }
    const from = start + RECORD_HEADER_LEN;
    if (this.#bytes.length - from < header.observationLen) return stop('malformed wire frame', `the observation is cut short: ${this.#bytes.length - from} of ${header.observationLen} bytes`);
    const observationBytes = this.#bytes.subarray(from, from + header.observationLen);
    if (crc32(observationBytes) !== header.crc32) return stop('wire checksum mismatch', 'the CRC-32 of the observation does not hold');
    const observation = decodeWireObservation(observationBytes);
    if (observation === null) return stop('malformed wire frame', 'the observation does not decode');
    this.#offset = from + header.observationLen;
    return { kind: 'record', offset: start, header, observation };
  }

  /** Every record up to the end or the stop, and which of the two it was. */
  readAll(): { readonly records: readonly ObicallReplayRecord[]; readonly stop: ReplayStop } {
    const records: ObicallReplayRecord[] = [];
    for (;;) {
      const step = this.next();
      if (step.kind !== 'record') return { records, stop: step };
      const { kind: _record, ...record } = step;
      records.push(record);
    }
  }
}

/** A whole recording, read. */
export const readReplay = (bytes: Uint8Array): ReturnType<ObicallReplayReader['readAll']> => new ObicallReplayReader(bytes).readAll();
