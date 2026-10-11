/**
 * The `.obr` journal format, read and written by AnyTune's own code: no Obicall library, executable or runtime is loaded, linked or run. AnyTune keeps this
 * format only for COMPATIBILITY: to open an `.obr` someone has, say what it holds, and refuse it as a practice reference, because it holds none. Its
 * observations are positions, velocities and ranges in metres, metres per second and radians; there is no unit a frequency or a note could be carried in.
 * AnyTune's own recordings are `anytune-recording/1` (docs/RECORDING.md), never `.obr`.
 *
 * The specification implemented is the one the format's origin publishes (obinexus/obicall 0.1.x: include/obicall/journal.h, src/core/journal.c,
 * src/core/wire.c; read at ae5581a, unchanged at 3bc3879 / v0.1.2), restated here and in docs/OBR.md: a stream of records with no file header; each record a
 * 40-byte little-endian header —
 *
 *   magic u32 = 0x4A4F5242 ("JORB")   record_len u32 = 40 + observation_len   observation_len u32 (≤ 4096)   crc32 u32 (CRC-32/ISO-HDLC of the observation)
 *   window_seq u64   admitted_at_ns i64   admission_reason u32   reserved u32
 *
 * — then the observation, every field packed little-endian in a fixed order (encodeObservation). The reader stops at the first record that does not hold —
 * it never skips past one — and leaves its offset at the start of that record, so that a writer could truncate a torn tail. A stop is named with the status
 * words of the specification ('malformed wire frame', 'wire frame too large', 'wire checksum mismatch'). Conformance: tests/adapters/obr-journal.test.ts,
 * against the format's own demonstration journal and the answers recorded from its reference implementation (tests/fixtures/obr/).
 */

export const JORB_MAGIC = 0x4a4f5242;
export const RECORD_HEADER_LEN = 40;
/** the largest observation a record may hold */
export const MAX_OBSERVATION_LEN = 4096;
/** the specification's bounds: payload doubles, covariance doubles, the fixed sensor-id field */
export const MAX_PAYLOAD_DOUBLES = 6;
export const MAX_COVARIANCE_DOUBLES = 36;
export const SENSOR_ID_LEN = 32;

/** The units of the specification — and nothing else: there is no frequency unit. */
export const OBR_UNITS: Readonly<Record<number, string>> = Object.freeze({ 0: 'unspecified', 1: 'meters', 2: 'meters-per-second', 3: 'radians' });
/** The payload shapes of the specification */
export const OBR_SHAPES: Readonly<Record<number, string>> = Object.freeze({ 0: 'unspecified', 1: 'position-1d', 2: 'position-2d', 3: 'position-2d-velocity', 4: 'range-1d' });

export interface ObrRecordHeader {
  readonly magic: number;
  readonly recordLen: number;
  readonly observationLen: number;
  readonly crc32: number;
  readonly windowSeq: bigint;
  readonly admittedAtNs: bigint;
  /** 0 admitted; 1 validation, 2 duplicate, 3 late, 4 overflow, 5 sequence regression */
  readonly admissionReason: number;
  readonly reserved: number;
}

/** An observation as the format carries it — its fields, in its units; no field is given a meaning the specification does not give it. */
export interface ObrObservation {
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
  /** a key of OBR_UNITS */
  readonly units: number;
  readonly calibrationVersion: number;
  /** a key of OBR_SHAPES */
  readonly payloadShape: number;
  readonly payload: readonly number[];
  readonly covariance: readonly number[];
}

export interface ObrRecord {
  /** where the record starts in the recording */
  readonly offset: number;
  readonly header: ObrRecordHeader;
  readonly observation: ObrObservation;
}

/** Why the reader stopped at a record, in the status words of the specification. */
export type ObrStopStatus = 'malformed wire frame' | 'wire frame too large' | 'wire checksum mismatch';

export type ReplayStop =
  | { readonly kind: 'end'; readonly offset: number }
  | { readonly kind: 'stopped'; readonly offset: number; readonly status: ObrStopStatus; readonly reason: string };

export type ReplayStep = ({ readonly kind: 'record' } & ObrRecord) | ReplayStop;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32/ISO-HDLC (reflected, polynomial 0xEDB88320, initial and final 0xFFFFFFFF), as the specification uses. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A cursor over little-endian fields that remembers that it ran out instead of throwing. */
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

function decodeHeader(bytes: Uint8Array): ObrRecordHeader {
  const c = new Cursor(bytes);
  return { magic: c.u32(), recordLen: c.u32(), observationLen: c.u32(), crc32: c.u32(), windowSeq: c.u64(), admittedAtNs: c.i64(), admissionReason: c.u32(), reserved: c.u32() };
}

const sensorIdOf = (raw: Uint8Array): string => {
  const end = raw.indexOf(0);
  return new TextDecoder('utf-8').decode(end === -1 ? raw : raw.subarray(0, end));
};

/** An observation decoded, or null where the specification calls the bytes malformed. Bytes after the covariance are not looked at, as in the specification. */
export function decodeObservation(bytes: Uint8Array): ObrObservation | null {
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

export class ObrJournalReader {
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

  /** The next record, the clean end, or the stop at a record that does not hold — in the order of the specification's checks. */
  next(): ReplayStep {
    if (this.#stopped !== null) return this.#stopped;
    const start = this.#offset;
    const rest = this.#bytes.length - start;
    const stop = (status: ObrStopStatus, reason: string): ReplayStop => (this.#stopped = { kind: 'stopped', offset: start, status, reason });
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
    const observation = decodeObservation(observationBytes);
    if (observation === null) return stop('malformed wire frame', 'the observation does not decode');
    this.#offset = from + header.observationLen;
    return { kind: 'record', offset: start, header, observation };
  }

  /** Every record up to the end or the stop, and which of the two it was. */
  readAll(): { readonly records: readonly ObrRecord[]; readonly stop: ReplayStop } {
    const records: ObrRecord[] = [];
    for (;;) {
      const step = this.next();
      if (step.kind !== 'record') return { records, stop: step };
      const { kind: _record, ...record } = step;
      records.push(record);
    }
  }
}

/** A whole recording, read. */
export const readObrJournal = (bytes: Uint8Array): ReturnType<ObrJournalReader['readAll']> => new ObrJournalReader(bytes).readAll();

// ---------------------------------------------------------------------------------------------------------------------------------------- writing

/** A cursor that writes little-endian fields into a growing array, in the specification's order. */
class Writer {
  readonly #bytes: number[] = [];
  readonly #scratch = new DataView(new ArrayBuffer(8));
  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`a u32 field holds 0…4294967295, not ${value}`);
    this.#scratch.setUint32(0, value, true);
    this.#push(4);
  }
  u64(value: bigint): void {
    this.#scratch.setBigUint64(0, BigInt.asUintN(64, value), true);
    this.#push(8);
  }
  i64(value: bigint): void {
    this.#scratch.setBigInt64(0, BigInt.asIntN(64, value), true);
    this.#push(8);
  }
  f64(value: number): void {
    this.#scratch.setFloat64(0, value, true);
    this.#push(8);
  }
  fixed(text: string, length: number): void {
    const encoded = new TextEncoder().encode(text);
    if (encoded.length >= length) throw new RangeError(`a sensor id is at most ${length - 1} bytes of UTF-8, not ${encoded.length}`);
    for (let i = 0; i < length; i++) this.#bytes.push(encoded[i] ?? 0);
  }
  #push(n: number): void {
    for (let i = 0; i < n; i++) this.#bytes.push(this.#scratch.getUint8(i));
  }
  done(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** An observation in the format's encoding: every field, little-endian, in the specification's order; the sensor id NUL-padded to its 32 bytes. */
export function encodeObservation(observation: ObrObservation): Uint8Array {
  if (observation.payload.length > MAX_PAYLOAD_DOUBLES) throw new RangeError(`a payload holds at most ${MAX_PAYLOAD_DOUBLES} doubles`);
  if (observation.covariance.length > MAX_COVARIANCE_DOUBLES) throw new RangeError(`a covariance holds at most ${MAX_COVARIANCE_DOUBLES} doubles`);
  const w = new Writer();
  w.u32(observation.structSize);
  w.u32(observation.schemaVersion);
  w.fixed(observation.sensorId, SENSOR_ID_LEN);
  w.u64(observation.sourceBootId);
  w.u64(observation.sequence);
  w.i64(observation.sampleTimeNs);
  w.i64(observation.arrivalTimeNs);
  w.u32(observation.clockDomain);
  w.f64(observation.timeUncertaintyS);
  w.u32(observation.coordinateFrame);
  w.u32(observation.units);
  w.u32(observation.calibrationVersion);
  w.u32(observation.payloadShape);
  w.u32(observation.payload.length);
  for (const value of observation.payload) w.f64(value);
  w.u32(observation.covariance.length);
  for (const value of observation.covariance) w.f64(value);
  return w.done();
}

/** What a record says of an observation besides the observation: its window, when and why it was admitted. */
export interface ObrRecordFields {
  readonly windowSeq: bigint;
  readonly admittedAtNs: bigint;
  readonly admissionReason: number;
}

/** One record: the 40-byte header (magic, lengths, the CRC-32 of the observation, the fields, reserved 0), then the encoded observation. */
export function encodeRecord(fields: ObrRecordFields, observation: ObrObservation): Uint8Array {
  const body = encodeObservation(observation);
  if (body.length > MAX_OBSERVATION_LEN) throw new RangeError(`an observation is at most ${MAX_OBSERVATION_LEN} bytes`);
  const w = new Writer();
  w.u32(JORB_MAGIC);
  w.u32(RECORD_HEADER_LEN + body.length);
  w.u32(body.length);
  w.u32(crc32(body));
  w.u64(fields.windowSeq);
  w.i64(fields.admittedAtNs);
  w.u32(fields.admissionReason);
  w.u32(0);
  const head = w.done();
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** A journal: its records one after another, with no file header, as the specification has it. */
export function writeObrJournal(records: readonly { readonly header: ObrRecordFields; readonly observation: ObrObservation }[]): Uint8Array {
  const parts = records.map((r) => encodeRecord(r.header, r.observation));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface ObrPracticeVerdict {
  /** always false: an .obr holds sensor observations, never notes */
  readonly practicable: false;
  readonly records: number;
  readonly sensors: readonly string[];
  readonly units: readonly string[];
  /** read to its end without a torn or malformed record */
  readonly intact: boolean;
  /** what to tell the user, in words */
  readonly reason: string;
}

/** What an `.obr` is to AnyTune: never a practice reference. It holds sensor observations in metres, metres per second or radians, not notes. */
export function describeForPractice(bytes: Uint8Array): ObrPracticeVerdict {
  const { records, stop } = readObrJournal(bytes);
  const sensors = [...new Set(records.map((r) => r.observation.sensorId))].sort();
  const units = [...new Set(records.map((r) => OBR_UNITS[r.observation.units] ?? `unknown (${r.observation.units})`))].sort();
  const intact = stop.kind === 'end';
  const plural = records.length === 1 ? '' : 's';
  const reason =
    records.length === 0 && stop.kind === 'stopped'
      ? `This is not a readable .obr journal (${stop.reason}). Nothing was changed.`
      : `This .obr journal holds ${records.length} sensor observation${plural} (${units.join(', ') || 'no units'}): positions and ranges, not notes, so there is nothing in it to practise. Import a MIDI file or a recording instead.`;
  return { practicable: false, records: records.length, sensors, units, intact, reason };
}
