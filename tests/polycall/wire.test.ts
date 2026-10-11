/**
 * polycall_rpc v1 framing (src/polycall/wire.ts), against the specification's table (polycall docs/RPC.md): the bytes are built here field by field. The
 * framing is checked live against the real runtime by tests/recording/recorder-polycall.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME, MAX_PAYLOAD, decodeFrame, encodeFrame, parseReply, requestPayload } from '../../src/polycall/wire.ts';

test('a REQUEST frame: "PCR1", type 1, flags and reserved 0, the correlation id and length big-endian, then the UTF-8 JSON payload', () => {
  const payload = requestPayload('recording', 'list', { token: 'é' }, 2000);
  assert.equal(payload, '{"service":"recording","operation":"list","deadline_ms":2000,"input":{"token":"é"}}');
  const frame = encodeFrame(FRAME.request, 0x01020304, payload);
  const body = new TextEncoder().encode(payload);
  assert.deepEqual([...frame.subarray(0, 16)], [0x50, 0x43, 0x52, 0x31, 1, 0, 0, 0, 1, 2, 3, 4, 0, 0, body.length >> 8, body.length & 0xff]);
  assert.deepEqual(frame.subarray(16), body);
});

test('decoding: a whole frame, a frame still arriving, and what violates the protocol — a bad magic, an oversized length, a payload that is not UTF-8', () => {
  const frame = encodeFrame(FRAME.response, 7, '{"ok":true,"output":{"n":1}}');
  const read = decodeFrame(frame);
  assert.deepEqual(read, { kind: 'frame', type: 2, corr: 7, payload: '{"ok":true,"output":{"n":1}}', consumed: frame.length });
  assert.deepEqual(decodeFrame(frame.subarray(0, 10)), { kind: 'need-more' });
  assert.deepEqual(decodeFrame(frame.subarray(0, frame.length - 1)), { kind: 'need-more' });
  const bad = new Uint8Array(frame);
  bad[0] = 0x58;
  assert.equal(decodeFrame(bad).kind, 'invalid');
  const huge = new Uint8Array(frame);
  new DataView(huge.buffer).setUint32(12, MAX_PAYLOAD + 1, false);
  assert.match((decodeFrame(huge) as { reason: string }).reason, /over the 1 MiB limit/);
  const notUtf8 = encodeFrame(FRAME.response, 1, 'ab');
  notUtf8[16] = 0xff;
  assert.match((decodeFrame(notUtf8) as { reason: string }).reason, /not UTF-8/);
  assert.throws(() => encodeFrame(FRAME.request, 1, 'x'.repeat(MAX_PAYLOAD + 1)), /at most/);
  assert.throws(() => requestPayload('s', 'o', null, 600001), /deadline_ms/);
});

test('replies: success with its output (or a CONTROL_REPLY’s data), failure with its code and message, and anything else a protocol error — never an exception', () => {
  assert.deepEqual(parseReply('{"ok":true,"output":{"a":1}}'), { ok: true, output: { a: 1 } });
  assert.deepEqual(parseReply('{"ok":true,"data":{"ops":[]}}', 'data'), { ok: true, output: { ops: [] } });
  assert.deepEqual(parseReply('{"ok":false,"error":{"code":"auth.denied","message":"no"}}'), { ok: false, error: { code: 'auth.denied', message: 'no' } });
  assert.equal((parseReply('nope') as { error: { code: string } }).error.code, 'protocol.malformed');
  assert.equal((parseReply('{"ok":"yes"}') as { error: { code: string } }).error.code, 'protocol.malformed');
  assert.equal((parseReply('{"ok":false}') as { error: { code: string } }).error.code, 'protocol.malformed');
});
