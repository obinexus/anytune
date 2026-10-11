/**
 * polycall_rpc v1 over TCP, for Node: AnyTune's tools and import worker reach a Polycall runtime (`polycall start`, loopback) through this. One connection
 * per call, exactly one round trip, never retried — Polycall's own call semantics (Polycall's docs/RPC.md at 2dcab63): a non-idempotent operation is never run twice by this side.
 * Failures are replies: an unreachable runtime is `transport.unreachable`, no reply in time `deadline.exceeded`, a broken frame `protocol.malformed`.
 */
import net from 'node:net';
import { FRAME, decodeFrame, encodeFrame, parseReply, requestPayload, type PolycallReply, type PolycallTransport } from '../wire.ts';

export interface TcpTransportOptions {
  /** the deadline given to the runtime when a call names none */
  readonly defaultDeadlineMs?: number;
  /** how much longer than the deadline this side waits for the reply */
  readonly graceMs?: number;
}

export class TcpPolycallTransport implements PolycallTransport {
  readonly #host: string;
  readonly #port: number;
  readonly #defaultDeadlineMs: number;
  readonly #graceMs: number;
  #corr = 0;

  /** `endpoint` is "host:port", as `polycall start` prints it and writes it to --endpoint-file. */
  constructor(endpoint: string, options: TcpTransportOptions = {}) {
    const at = endpoint.lastIndexOf(':');
    const port = Number(endpoint.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new RangeError(`an endpoint is host:port, not ${endpoint}`);
    this.#host = endpoint.slice(0, at);
    this.#port = port;
    this.#defaultDeadlineMs = options.defaultDeadlineMs ?? 5000;
    this.#graceMs = options.graceMs ?? 1500;
  }

  call(service: string, operation: string, input: unknown, deadlineMs: number = this.#defaultDeadlineMs): Promise<PolycallReply> {
    return this.#roundTrip(FRAME.request, FRAME.response, requestPayload(service, operation, input, deadlineMs), deadlineMs, 'output');
  }

  /** A CONTROL action — `ping`, `describe`, or `shutdown` (which needs the runtime's --auth-token). Its result is the reply's `data`. */
  control(action: 'ping' | 'describe' | 'shutdown', authToken?: string, deadlineMs: number = this.#defaultDeadlineMs): Promise<PolycallReply> {
    return this.#roundTrip(FRAME.control, FRAME.controlReply, JSON.stringify(authToken === undefined ? { action } : { action, auth_token: authToken }), deadlineMs, 'data');
  }

  #roundTrip(type: number, replyType: number, payload: string, deadlineMs: number, resultKey: 'output' | 'data'): Promise<PolycallReply> {
    const corr = (this.#corr = (this.#corr + 1) >>> 0);
    const frame = encodeFrame(type, corr, payload);
    return new Promise((resolve) => {
      let received = new Uint8Array(0);
      let settled = false;
      const socket = net.connect({ host: this.#host, port: this.#port });
      const settle = (reply: PolycallReply): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(reply);
      };
      const timer = setTimeout(() => settle({ ok: false, error: { code: 'deadline.exceeded', message: `no reply within ${deadlineMs + this.#graceMs} ms` } }), deadlineMs + this.#graceMs);
      socket.on('connect', () => socket.write(frame));
      socket.on('data', (chunk: Uint8Array) => {
        const joined = new Uint8Array(received.length + chunk.length);
        joined.set(received, 0);
        joined.set(chunk, received.length);
        received = joined;
        const read = decodeFrame(received);
        if (read.kind === 'need-more') return;
        if (read.kind === 'invalid') return settle({ ok: false, error: { code: 'protocol.malformed', message: read.reason } });
        if (read.type !== replyType || read.corr !== corr) return settle({ ok: false, error: { code: 'protocol.malformed', message: `a reply of type ${read.type}, correlation ${read.corr}; expected ${replyType}, ${corr}` } });
        settle(parseReply(read.payload, resultKey));
      });
      socket.on('error', (error: Error) => settle({ ok: false, error: { code: 'transport.unreachable', message: error.message } }));
      socket.on('close', () => settle({ ok: false, error: { code: 'transport.closed', message: 'the runtime closed the connection before replying' } }));
    });
  }
}
