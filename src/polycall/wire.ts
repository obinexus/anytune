/**
 * polycall_rpc v1 — Polycall's wire, as its specification states it (polycall docs/RPC.md, src/runtime/rpc_wire.h at 2dcab63): every message is a 16-byte
 * header and a UTF-8 JSON payload.
 *
 *   0  magic "PCR1"   4  type u8 (1 REQUEST, 2 RESPONSE, 3 CONTROL, 4 CONTROL_REPLY)   5  flags u8 = 0   6  reserved u16 = 0
 *   8  corr u32 big-endian (chosen by the caller, echoed in the reply)   12  length u32 big-endian (≤ 1 MiB)   16  payload
 *
 * A REQUEST is {"service","operation","deadline_ms","input"}; a RESPONSE {"ok":true,"output":…} or {"ok":false,"error":{"code","message"}}. A CONTROL is
 * {"action":"ping|describe|shutdown","auth_token"?}. This module is pure — framing and payloads only; a transport (src/polycall/node/, or the Android
 * bridge) moves the bytes. Polycall connects AnyTune's components across languages and decides nothing musical: the operations it carries are AnyTune's.
 */

export const MAGIC = 'PCR1';
export const HEADER_LEN = 16;
export const MAX_PAYLOAD = 1 << 20;
export const FRAME = Object.freeze({ request: 1, response: 2, control: 3, controlReply: 4 });

export type PolycallError = { readonly code: string; readonly message: string };
export type PolycallReply = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: PolycallError };

/** What moves a call to a Polycall runtime and brings its reply back. Failures — the runtime's, the transport's — are replies, never exceptions. */
export interface PolycallTransport {
  call(service: string, operation: string, input: unknown, deadlineMs?: number): Promise<PolycallReply>;
}

export function encodeFrame(type: number, corr: number, payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  if (body.length > MAX_PAYLOAD) throw new RangeError(`a polycall_rpc payload is at most ${MAX_PAYLOAD} bytes, not ${body.length}`);
  const frame = new Uint8Array(HEADER_LEN + body.length);
  const view = new DataView(frame.buffer);
  frame.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint8(4, type);
  view.setUint32(8, corr >>> 0, false);
  view.setUint32(12, body.length, false);
  frame.set(body, HEADER_LEN);
  return frame;
}

export type FrameRead =
  | { readonly kind: 'frame'; readonly type: number; readonly corr: number; readonly payload: string; readonly consumed: number }
  | { readonly kind: 'need-more' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** The first frame in the bytes received so far: a whole frame, more bytes needed, or a protocol violation. */
export function decodeFrame(bytes: Uint8Array): FrameRead {
  if (bytes.length < HEADER_LEN) return { kind: 'need-more' };
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) return { kind: 'invalid', reason: 'the reply does not begin with PCR1' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, false);
  if (length > MAX_PAYLOAD) return { kind: 'invalid', reason: `a payload of ${length} bytes, over the 1 MiB limit` };
  if (bytes.length < HEADER_LEN + length) return { kind: 'need-more' };
  let payload: string;
  try {
    payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_LEN, HEADER_LEN + length));
  } catch {
    return { kind: 'invalid', reason: 'the payload is not UTF-8' };
  }
  return { kind: 'frame', type: view.getUint8(4), corr: view.getUint32(8, false), payload, consumed: HEADER_LEN + length };
}

export function requestPayload(service: string, operation: string, input: unknown, deadlineMs: number): string {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 600000) throw new RangeError(`deadline_ms is an integer in 0…600000, not ${deadlineMs}`);
  return JSON.stringify({ service, operation, deadline_ms: deadlineMs, input: input === undefined ? null : input });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A RESPONSE (or CONTROL_REPLY, whose result is `data`) payload as a reply; one that does not hold is a protocol error, said as one. */
export function parseReply(payload: string, resultKey: 'output' | 'data' = 'output'): PolycallReply {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { ok: false, error: { code: 'protocol.malformed', message: 'the reply is not JSON' } };
  }
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return { ok: false, error: { code: 'protocol.malformed', message: 'the reply has no boolean "ok"' } };
  if (value['ok']) return { ok: true, output: value[resultKey] ?? null };
  const error = value['error'];
  if (isRecord(error) && typeof error['code'] === 'string') return { ok: false, error: { code: error['code'], message: typeof error['message'] === 'string' ? error['message'] : '' } };
  return { ok: false, error: { code: 'protocol.malformed', message: 'a failed reply with no error code' } };
}
