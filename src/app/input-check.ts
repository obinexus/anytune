/**
 * The input check: before an assessed attempt, the learner plucks a string and AnyTune shows that it heard it. Pressing Start opens the microphone; it is
 * the first clearly heard NOTE — a pitch named by the live analysis, the whole chain working — that makes the input ready, never the permission alone.
 *
 * While it waits it says what it hears, apart:
 *   silent    digital silence (the device sends zeros): the caller retries once with the browser's processing on, then says the microphone is muted
 *   quiet     sound, but faint: after a few seconds with nothing louder than −40 dBFS — move closer, or raise the input level
 *   unclear   something was struck but no pitch could be named: pluck one string and let it ring
 *   pluck     nothing yet: pluck any string
 */
import type { LiveEvent } from '../analysis/live.ts';
import { noteOf } from '../domain/pitch.ts';
import type { CaptureMonitor } from './capture.ts';

export type InputHint = 'pluck' | 'quiet' | 'unclear';
export type InputCheckVerdict =
  | { readonly kind: 'checking'; readonly hint: InputHint }
  | { readonly kind: 'ready'; readonly heard: string }
  | { readonly kind: 'silent' };

export interface InputCheckOptions {
  readonly silentAfterSeconds: number;
  readonly quietAfterSeconds: number;
  readonly quietDb: number;
  readonly minConfidence: number;
}

export const DEFAULT_INPUT_CHECK: InputCheckOptions = Object.freeze({ silentAfterSeconds: 1.5, quietAfterSeconds: 5, quietDb: -40, minConfidence: 0.6 });

export class InputCheck {
  readonly #started: number;
  readonly #o: InputCheckOptions;
  #unclear = false;
  #loudestDb = Number.NEGATIVE_INFINITY;

  constructor(started: number, options: Partial<InputCheckOptions> = {}) {
    this.#started = started;
    this.#o = { ...DEFAULT_INPUT_CHECK, ...options };
  }

  /** What the check says now, after `events` from the analysis, with the monitor's view of the capture, at capture-clock `now`. */
  update(monitor: CaptureMonitor, now: number, events: readonly LiveEvent[]): InputCheckVerdict {
    const note = events.find((e) => e.kind === 'note' && e.confidence >= this.#o.minConfidence);
    if (note !== undefined && note.kind === 'note') return { kind: 'ready', heard: noteOf(note.key).label };
    if (events.some((e) => e.kind === 'unclear')) this.#unclear = true;
    this.#loudestDb = Math.max(this.#loudestDb, monitor.levelDb());
    if (monitor.silentFor() >= this.#o.silentAfterSeconds) return { kind: 'silent' };
    if (this.#unclear) return { kind: 'checking', hint: 'unclear' };
    if (now - this.#started >= this.#o.quietAfterSeconds && this.#loudestDb < this.#o.quietDb) return { kind: 'checking', hint: 'quiet' };
    return { kind: 'checking', hint: 'pluck' };
  }
}
