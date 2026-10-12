/**
 * The recorder, as the rest of AnyTune sees it: create a recording (a learner's attempt, linked to the reference it was played against, or a timed
 * reference), append its events in time order, finish it, replay it, list the recordings of a reference. Every call goes through Polycall to AnyTune's recorder
 * module (native/recorder) — over TCP from Node, over the JNI bridge on Android — carrying the session token the module was configured with. Failures are
 * results, never exceptions: the module's own codes ("auth.denied", "recording.order", …) and the transport's ("transport.unreachable", …).
 */
import type { PolycallError, PolycallTransport } from '../polycall/wire.ts';
import type { RecordedEvent, RecordingHeader, RecordingKind } from './format.ts';

export type RecorderResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PolycallError };

export interface RecordingPage {
  readonly recordingId: string;
  readonly header: RecordingHeader;
  readonly from: number;
  readonly events: readonly RecordedEvent[];
  /** the index of the first event not returned, or null when this page reaches the last */
  readonly next: number | null;
  readonly total: number;
  readonly complete: boolean;
  readonly intact: boolean;
  readonly stop: { readonly offset: number; readonly reason: string } | null;
}

export interface Replay {
  readonly header: RecordingHeader;
  readonly events: readonly RecordedEvent[];
  readonly complete: boolean;
  readonly intact: boolean;
  readonly stop: { readonly offset: number; readonly reason: string } | null;
}

export interface RecordingSummary {
  readonly recordingId: string;
  readonly kind: RecordingKind;
  readonly createdAt: string;
  readonly referenceId: string | null;
  readonly complete: boolean;
  /** null for an unfinished recording */
  readonly events: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const malformed = (what: string): { ok: false; error: PolycallError } => ({ ok: false, error: { code: 'protocol.malformed', message: `the recorder's reply has no ${what}` } });

export class PolycallRecorder {
  readonly #transport: PolycallTransport;
  readonly #token: string;

  constructor(transport: PolycallTransport, token: string) {
    this.#transport = transport;
    this.#token = token;
  }

  async #call(operation: string, input: Record<string, unknown>): Promise<RecorderResult<Record<string, unknown>>> {
    const reply = await this.#transport.call('recording', operation, { token: this.#token, ...input });
    if (!reply.ok) return reply;
    return isRecord(reply.output) ? { ok: true, value: reply.output } : malformed('object');
  }

  async create(kind: RecordingKind, meta: Readonly<Record<string, unknown>>): Promise<RecorderResult<{ readonly recordingId: string; readonly createdAt: string }>> {
    const r = await this.#call('create', { kind, meta });
    if (!r.ok) return r;
    const { recordingId, createdAt } = r.value;
    return typeof recordingId === 'string' && typeof createdAt === 'string' ? { ok: true, value: { recordingId, createdAt } } : malformed('recordingId');
  }

  async append(recordingId: string, events: readonly RecordedEvent[]): Promise<RecorderResult<{ readonly appended: number; readonly events: number }>> {
    const r = await this.#call('append', { recordingId, events });
    if (!r.ok) return r;
    const { appended, events: total } = r.value;
    return typeof appended === 'number' && typeof total === 'number' ? { ok: true, value: { appended, events: total } } : malformed('count');
  }

  async finish(recordingId: string): Promise<RecorderResult<{ readonly events: number; readonly finishedAt: string }>> {
    const r = await this.#call('finish', { recordingId });
    if (!r.ok) return r;
    const { events, finishedAt } = r.value;
    return typeof events === 'number' && typeof finishedAt === 'string' ? { ok: true, value: { events, finishedAt } } : malformed('count');
  }

  async read(recordingId: string, from = 0, max?: number): Promise<RecorderResult<RecordingPage>> {
    const r = await this.#call('read', max === undefined ? { recordingId, from } : { recordingId, from, max });
    if (!r.ok) return r;
    const v = r.value;
    if (!isRecord(v['header']) || !Array.isArray(v['events']) || typeof v['total'] !== 'number') return malformed('page');
    return { ok: true, value: v as unknown as RecordingPage };
  }

  /** Every event of a recording, page after page — in the order recorded — with what the module said of its integrity. */
  async replay(recordingId: string): Promise<RecorderResult<Replay>> {
    const events: RecordedEvent[] = [];
    let from = 0;
    for (;;) {
      const page = await this.read(recordingId, from);
      if (!page.ok) return page;
      events.push(...page.value.events);
      if (page.value.next === null) return { ok: true, value: { header: page.value.header, events, complete: page.value.complete, intact: page.value.intact, stop: page.value.stop } };
      if (page.value.next <= from) return malformed('progress between pages');
      from = page.value.next;
    }
  }

  async list(referenceId?: string): Promise<RecorderResult<{ readonly recordings: readonly RecordingSummary[]; readonly truncated: boolean }>> {
    const r = await this.#call('list', referenceId === undefined ? {} : { referenceId });
    if (!r.ok) return r;
    return Array.isArray(r.value['recordings']) ? { ok: true, value: r.value as unknown as { recordings: RecordingSummary[]; truncated: boolean } } : malformed('recordings');
  }
}
