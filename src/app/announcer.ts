/**
 * The announcement policy of AnyTune: what the live region tells assistive technology, and when. The visual meter may change at every render; announcements
 * change only when something a listener needs changes — the note, the tuning status, steadiness, the signal, the session — at most once per `minIntervalMs`,
 * and never the same thing twice in a row. A change inside the interval waits for it to end and is then announced as its latest state (or not at all, if it
 * came back to what was said). Framework-neutral; time is the injected scheduler's.
 */
import type { Scheduler } from '../domain/ports.ts';
import type { AnyTuneState } from './session.ts';

export interface AnnouncePolicy {
  readonly minIntervalMs: number;
}

export const DEFAULT_ANNOUNCE_POLICY: AnnouncePolicy = Object.freeze({ minIntervalMs: 1000 });

/** The words for a state — empty when the state is not announced here (an error is an alert of its own; starting says nothing yet). */
export function announcementOf(state: AnyTuneState): string {
  if (state.session === 'idle') return state.input.state === 'ended' ? 'Recording ended' : 'Stopped';
  if (state.session !== 'listening') return '';
  const r = state.reading;
  if (r === null) return 'Listening. Play a note.';
  if (r.status === 'uncertain') return 'Signal uncertain';
  const steady = state.stable ? ' and steady' : '';
  if (r.status === 'in-tune') return `${r.targetLabel}, in tune${steady}`;
  return `${r.targetLabel}, ${Math.round(Math.abs(r.cents))} cents ${r.status}${steady}`;
}

/** What makes an announcement new: the session, and the target, status and steadiness of the reading — not its cents. */
function keyOf(state: AnyTuneState): string {
  const r = state.reading;
  if (state.session === 'idle') return `idle|${state.input.state}`;
  if (state.session !== 'listening' || r === null) return state.session;
  if (r.status === 'uncertain') return 'uncertain';
  return `${r.targetLabel}|${r.status}|${state.stable}`;
}

export class Announcer {
  private readonly clock: Scheduler;
  private readonly policy: AnnouncePolicy;
  private readonly listeners = new Set<(text: string) => void>();
  private lastKey: string | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private text = '';
  private pending: { readonly key: string; readonly words: string } | null = null;
  private cancel: (() => void) | null = null;

  constructor(clock: Scheduler, policy: AnnouncePolicy = DEFAULT_ANNOUNCE_POLICY) {
    this.clock = clock;
    this.policy = policy;
  }

  /** Cancel what is waiting to be said: nothing is announced after this. */
  dispose(): void {
    this.cancel?.();
    this.cancel = null;
    this.pending = null;
    this.listeners.clear();
  }

  /** What was announced last. */
  current(): string {
    return this.text;
  }

  subscribe(listener: (text: string) => void): () => void {
    const own = (text: string): void => listener(text);
    this.listeners.add(own);
    return () => {
      this.listeners.delete(own);
    };
  }

  /** A new application state: announce it now, later, or not at all. */
  observe(state: AnyTuneState): void {
    const words = announcementOf(state);
    if (words === '') return;
    const key = keyOf(state);
    if (key === this.lastKey) {
      // back to what was said: whatever was waiting is no longer news
      this.pending = null;
      return;
    }
    const now = this.clock.now();
    if (this.pending === null && now - this.lastAt >= this.policy.minIntervalMs) return this.say(key, words);
    this.pending = { key, words };
    this.cancel ??= this.clock.setTimeout(() => this.flush(), this.lastAt + this.policy.minIntervalMs - now);
  }

  private flush(): void {
    this.cancel = null;
    const waiting = this.pending;
    this.pending = null;
    if (waiting !== null && waiting.key !== this.lastKey) this.say(waiting.key, waiting.words);
  }

  private say(key: string, words: string): void {
    this.lastKey = key;
    this.lastAt = this.clock.now();
    this.text = words;
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener(words);
  }
}
