/**
 * anytune-recording/1 (docs/RECORDING.md), read and written in TypeScript: an implementation INDEPENDENT of the recorder module's C (native/recorder), so that
 * each checks the other — what the C writes through Polycall, this reads; what this writes, the C reads (tests/recording/). The application never writes a
 * recording itself: it goes through the recorder module, reached through Polycall (src/recording/recorder.ts).
 *
 *   file header  89 41 54 52 0D 0A 1A 0A   major u16 LE = 1   minor u16 LE = 0   reserved u32 = 0
 *   record       type u8 (1 HEADER, 2 EVENTS, 3 END)   reserved u8[3] = 0   payload_len u32 LE (≤ 1 MiB)   crc32 u32 LE   payload (UTF-8 JSON)
 *
 * The CRC-32/ISO-HDLC covers the record's first 8 bytes and its payload. One HEADER, first; EVENTS records (each a JSON array of events, every event with a
 * number `t` ≥ 0 — never decreasing — and a string `kind`); an END closes a finished recording and nothing follows it. Reading stops at the first record that
 * does not hold, keeps what came before, and says where and why, in the words the C recorder uses.
 */

export const SIGNATURE: readonly number[] = Object.freeze([0x89, 0x41, 0x54, 0x52, 0x0d, 0x0a, 0x1a, 0x0a]);
export const VERSION = Object.freeze({ major: 1, minor: 0 });
export const FILE_HEADER_LEN = 16;
export const RECORD_HEADER_LEN = 12;
export const MAX_PAYLOAD = 1 << 20;
export const RECORD = Object.freeze({ header: 1, events: 2, end: 3 });

export type RecordingKind = 'attempt' | 'reference';

/** One timed event. `t` is seconds on the recording's own clock (meta.clock says which); `kind` says what it is. Everything else is the event's own. */
export interface RecordedEvent {
  readonly t: number;
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface RecordingHeader {
  readonly format: 'anytune-recording';
  readonly version: string;
  readonly recordingId: string;
  readonly kind: RecordingKind;
  readonly createdAt: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface RecordingEnd {
  readonly events: number;
  readonly lastT: number | null;
  readonly finishedAt: string;
}

/** The reasons a reader stops, in the words of the C recorder (atrec_status_text). */
export type StopReason = 'a record cut short' | 'a record whose CRC does not hold' | 'a malformed record' | 'a record too large';

export type RecordingRead =
  | {
      readonly ok: true;
      readonly version: { readonly major: number; readonly minor: number };
      readonly header: RecordingHeader;
      readonly events: readonly RecordedEvent[];
      readonly end: RecordingEnd | null;
      /** an END record was read */
      readonly complete: boolean;
      /** read to its last byte with no record that did not hold */
      readonly intact: boolean;
      readonly stop: { readonly offset: number; readonly reason: StopReason } | null;
    }
  | { readonly ok: false; readonly reason: string };

/** CRC-32/ISO-HDLC, continued from `crc` (0 to start). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const validEvents = (value: unknown, after: number | null): value is RecordedEvent[] => {
  if (!Array.isArray(value)) return false;
  let last = after;
  for (const event of value) {
    if (!isRecord(event) || typeof event['t'] !== 'number' || !Number.isFinite(event['t']) || event['t'] < 0 || typeof event['kind'] !== 'string' || event['kind'].length === 0) return false;
    if (last !== null && event['t'] < last) return false;
    last = event['t'];
  }
  return true;
};

export function readRecording(bytes: Uint8Array): RecordingRead {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return { ok: false, reason: 'not an anytune-recording file' };
  if (bytes.length < FILE_HEADER_LEN) return { ok: false, reason: 'a record cut short' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = { major: view.getUint16(8, true), minor: view.getUint16(10, true) };
  if (version.major !== VERSION.major) return { ok: false, reason: `anytune-recording ${version.major}.${version.minor}: this reader reads 1.x` };
  if (view.getUint32(12, true) !== 0) return { ok: false, reason: 'a malformed record' };

  let at = FILE_HEADER_LEN;
  let header: RecordingHeader | null = null;
  let end: RecordingEnd | null = null;
  const events: RecordedEvent[] = [];
  let stop: { offset: number; reason: StopReason } | null = null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (at < bytes.length) {
    const start = at;
    const halt = (reason: StopReason): void => {
      stop = { offset: start, reason };
    };
    if (bytes.length - at < RECORD_HEADER_LEN) {
      halt('a record cut short');
      break;
    }
    const type = bytes[at] as number;
    const length = view.getUint32(at + 4, true);
    if (bytes[at + 1] !== 0 || bytes[at + 2] !== 0 || bytes[at + 3] !== 0 || type < RECORD.header || type > RECORD.end) {
      halt('a malformed record');
      break;
    }
    if (length > MAX_PAYLOAD) {
      halt('a record too large');
      break;
    }
    if (bytes.length - at - RECORD_HEADER_LEN < length) {
      halt('a record cut short');
      break;
    }
    const payloadBytes = bytes.subarray(at + RECORD_HEADER_LEN, at + RECORD_HEADER_LEN + length);
    if (crc32(payloadBytes, crc32(bytes.subarray(at, at + 8))) !== view.getUint32(at + 8, true)) {
      halt('a record whose CRC does not hold');
      break;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(decoder.decode(payloadBytes));
    } catch {
      halt('a malformed record');
      break;
    }
    const lastT = events.length === 0 ? null : (events[events.length - 1] as RecordedEvent).t;
    const inPlace = (type === RECORD.header) === (header === null) && end === null;
    const wellFormed = type === RECORD.events ? validEvents(payload, lastT) : isRecord(payload);
    if (!inPlace || !wellFormed) {
      halt('a malformed record');
      break;
    }
    if (type === RECORD.header) header = payload as unknown as RecordingHeader;
    else if (type === RECORD.events) events.push(...(payload as RecordedEvent[]));
    else end = payload as unknown as RecordingEnd;
    at += RECORD_HEADER_LEN + length;
  }
  if (header === null) return { ok: false, reason: 'the recording has no readable header record' };
  return { ok: true, version, header, events, end, complete: end !== null, intact: stop === null, stop };
}

function record(type: number, payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  if (body.length > MAX_PAYLOAD) throw new RangeError(`a record holds at most ${MAX_PAYLOAD} bytes`);
  const out = new Uint8Array(RECORD_HEADER_LEN + body.length);
  const view = new DataView(out.buffer);
  out[0] = type;
  view.setUint32(4, body.length, true);
  view.setUint32(8, crc32(body, crc32(out.subarray(0, 8))), true);
  out.set(body, RECORD_HEADER_LEN);
  return out;
}

/** The bytes of a recording: the header, each batch of events as an EVENTS record, and an END when one is given. */
export function writeRecording(header: RecordingHeader, batches: readonly (readonly RecordedEvent[])[], end: RecordingEnd | null): Uint8Array {
  let last: number | null = null;
  for (const batch of batches) {
    if (!validEvents(batch, last)) throw new RangeError('events need a number t ≥ 0 that never decreases, and a kind');
    if (batch.length > 0) last = (batch[batch.length - 1] as RecordedEvent).t;
  }
  const head = new Uint8Array(FILE_HEADER_LEN);
  head.set(SIGNATURE, 0);
  new DataView(head.buffer).setUint16(8, VERSION.major, true);
  new DataView(head.buffer).setUint16(10, VERSION.minor, true);
  const parts = [head, record(RECORD.header, header), ...batches.filter((b) => b.length > 0).map((b) => record(RECORD.events, b)), ...(end === null ? [] : [record(RECORD.end, end)])];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
