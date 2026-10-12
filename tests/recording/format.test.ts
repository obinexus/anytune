/**
 * anytune-recording/1 in TypeScript (src/recording/format.ts) on its own: the layout byte by byte, the round trip, and every damage the reader must stop at.
 * The C recorder module is checked against it through Polycall in recorder-polycall.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_HEADER_LEN, RECORD_HEADER_LEN, crc32, readRecording, writeRecording, type RecordedEvent, type RecordingHeader } from '../../src/recording/format.ts';

const HEADER: RecordingHeader = { format: 'anytune-recording', version: '1.0', recordingId: '0'.repeat(32), kind: 'attempt', createdAt: '2026-10-11T00:00:00Z', meta: { referenceId: 'ref-x' } };
const BATCHES: RecordedEvent[][] = [[{ t: 0, kind: 'onset' }, { t: 0.5, kind: 'pitch', hz: 82.4 }], [{ t: 0.5, kind: 'onset' }]];
const END = { events: 3, lastT: 0.5, finishedAt: '2026-10-11T00:00:02Z' };

test('the layout: the signature 89 41 54 52 0D 0A 1A 0A, version 1.0, then records — type, three zero bytes, the length, the CRC of the first 8 bytes and the payload', () => {
  const bytes = writeRecording(HEADER, BATCHES, END);
  assert.deepEqual([...bytes.subarray(0, FILE_HEADER_LEN)], [0x89, 0x41, 0x54, 0x52, 0x0d, 0x0a, 0x1a, 0x0a, 1, 0, 0, 0, 0, 0, 0, 0]);
  const view = new DataView(bytes.buffer);
  const payload = new TextEncoder().encode(JSON.stringify(HEADER));
  assert.deepEqual([...bytes.subarray(16, 20)], [1, 0, 0, 0]);
  assert.equal(view.getUint32(20, true), payload.length);
  assert.equal(view.getUint32(24, true), crc32(payload, crc32(bytes.subarray(16, 24))));
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('written and read back: the header, every event in order, the end — complete and intact', () => {
  const read = readRecording(writeRecording(HEADER, BATCHES, END));
  assert.ok(read.ok);
  assert.deepEqual([read.header, read.events, read.end, read.complete, read.intact, read.stop], [HEADER, BATCHES.flat(), END, true, true, null]);
  const unfinished = readRecording(writeRecording(HEADER, BATCHES, null));
  assert.ok(unfinished.ok);
  assert.deepEqual([unfinished.complete, unfinished.intact], [false, true]);
});

test('every damage stops the reader at the damaged record, keeping what came before — cut short, CRC, reserved bytes, unknown type, time going back, a record after the end', () => {
  const whole = writeRecording(HEADER, BATCHES, END);
  const view = new DataView(whole.buffer);
  const second = FILE_HEADER_LEN + RECORD_HEADER_LEN + view.getUint32(FILE_HEADER_LEN + 4, true); // the first EVENTS record
  const stopAt = (bytes: Uint8Array): { events: number; stop: unknown } => {
    const r = readRecording(bytes);
    assert.ok(r.ok);
    return { events: r.events.length, stop: r.stop };
  };
  assert.deepEqual(stopAt(whole.subarray(0, second + 5)), { events: 0, stop: { offset: second, reason: 'a record cut short' } });
  const flip = (at: number, bits: number): Uint8Array => {
    const copy = new Uint8Array(whole);
    copy[at] = (copy[at] as number) ^ bits;
    return copy;
  };
  assert.deepEqual(stopAt(flip(second + RECORD_HEADER_LEN + 2, 1)), { events: 0, stop: { offset: second, reason: 'a record whose CRC does not hold' } });
  assert.deepEqual(stopAt(flip(second + 1, 1)), { events: 0, stop: { offset: second, reason: 'a malformed record' } });
  assert.deepEqual(stopAt(flip(second, 0x04)), { events: 0, stop: { offset: second, reason: 'a malformed record' } }); // type 6
  const backwards = writeRecording(HEADER, [[{ t: 1, kind: 'onset' }]], null);
  const tail = writeRecording(HEADER, [[{ t: 0.5, kind: 'onset' }]], null).subarray(FILE_HEADER_LEN + RECORD_HEADER_LEN + new DataView(backwards.buffer).getUint32(FILE_HEADER_LEN + 4, true));
  const joined = new Uint8Array(backwards.length + tail.length);
  joined.set(backwards, 0);
  joined.set(tail, backwards.length);
  assert.deepEqual(stopAt(joined), { events: 1, stop: { offset: backwards.length, reason: 'a malformed record' } });
  const afterEnd = new Uint8Array(whole.length + tail.length);
  afterEnd.set(whole, 0);
  afterEnd.set(tail, whole.length);
  assert.deepEqual(stopAt(afterEnd), { events: 3, stop: { offset: whole.length, reason: 'a malformed record' } });
});

test('what is not this format, or a later major version, is refused in words — never read as something else', () => {
  assert.deepEqual(readRecording(Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6])), { ok: false, reason: 'not an anytune-recording file' });
  const future = writeRecording(HEADER, [], null);
  new DataView(future.buffer).setUint16(8, 2, true);
  assert.deepEqual(readRecording(future), { ok: false, reason: 'anytune-recording 2.0: this reader reads 1.x' });
  assert.throws(() => writeRecording(HEADER, [[{ t: 1, kind: 'a' }, { t: 0, kind: 'b' }]], null), /never decreases/);
});
