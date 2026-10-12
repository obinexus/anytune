/**
 * Play's clock: where in the song the learner is, on the audio clock — through pauses, tempo changes and restarts — and the beat grid that the click and
 * the beat position follow.
 *
 * The clock is a list of SEGMENTS: from audio time `audioFrom`, the song advances from reference time `refFrom` at `tempo` (1 as written). A pause ends the
 * open segment and freezes the position; a resume opens a new one where the song stopped; a tempo change ends the segment and opens one at the same
 * position with the new tempo. So every audio time of the run maps to at most one song time (`refAt`) — how a captured note is placed — and, while playing,
 * every song time ahead maps to the one audio time it is due (`audioTimeOf`) — how a note is scheduled and how a prompt is placed. Both come from these
 * segments: the playback and the prompts cannot drift apart.
 */
import { tempoMapOf, type Reference } from '../music/reference.ts';

interface Segment {
  readonly audioFrom: number;
  /** null while it is the open one */
  audioTo: number | null;
  readonly refFrom: number;
  readonly tempo: number;
}

export type PlayClockState = 'stopped' | 'running' | 'paused';

export class PlayClock {
  readonly #segments: Segment[] = [];
  #state: PlayClockState = 'stopped';
  /** where the song is while paused or stopped */
  #held = 0;

  get state(): PlayClockState {
    return this.#state;
  }

  get tempo(): number {
    return this.#segments[this.#segments.length - 1]?.tempo ?? 1;
  }

  /** The song starts at reference time `from`, at audio time `at` (after a count-in, `at` is in the future), at `tempo`. Forgets the past run. */
  start(at: number, from: number, tempo: number): void {
    if (!(tempo > 0)) throw new RangeError(`a tempo is above 0, not ${tempo}`);
    this.#segments.length = 0;
    this.#segments.push({ audioFrom: at, audioTo: null, refFrom: from, tempo });
    this.#state = 'running';
  }

  /** The song position at audio time `t`: before the open segment starts (a count-in), its start; while paused, where it stopped. */
  position(t: number): number {
    if (this.#state !== 'running') return this.#held;
    const s = this.#segments[this.#segments.length - 1] as Segment;
    return s.refFrom + Math.max(0, t - s.audioFrom) * s.tempo;
  }

  /** The audio time reference time `r` is due, in the open segment — null when paused or stopped, or when `r` is behind the segment's start. */
  audioTimeOf(r: number): number | null {
    if (this.#state !== 'running') return null;
    const s = this.#segments[this.#segments.length - 1] as Segment;
    if (r < s.refFrom - 1e-9) return null;
    return s.audioFrom + (r - s.refFrom) / s.tempo;
  }

  /**
   * The song time that was playing at audio time `t` — for a captured note — or null: in a count-in, a pause, or before the run. A note up to
   * `earlySeconds` before a segment starts (the first note after a count-in, played a little early) belongs to it, at a song time just before its start.
   */
  refAt(t: number, earlySeconds = 0): { readonly time: number; readonly tempo: number } | null {
    for (let i = this.#segments.length - 1; i >= 0; i--) {
      const s = this.#segments[i] as Segment;
      if (t >= s.audioFrom - earlySeconds && (s.audioTo === null || t < s.audioTo)) return { time: s.refFrom + (t - s.audioFrom) * s.tempo, tempo: s.tempo };
    }
    return null;
  }

  /** Pause at audio time `t`: the position is held. */
  pause(t: number): void {
    if (this.#state !== 'running') return;
    this.#held = this.position(t);
    const s = this.#segments[this.#segments.length - 1] as Segment;
    s.audioTo = Math.max(s.audioFrom, t);
    this.#state = 'paused';
  }

  /** Resume where the song was held, at audio time `at` (a count-in before it, when `at` is later than now). */
  resume(at: number, tempo = this.tempo): void {
    if (this.#state !== 'paused') return;
    this.#segments.push({ audioFrom: at, audioTo: null, refFrom: this.#held, tempo });
    this.#state = 'running';
  }

  /** A new tempo from audio time `t` on, at the same song position. */
  setTempo(t: number, tempo: number): void {
    if (!(tempo > 0)) throw new RangeError(`a tempo is above 0, not ${tempo}`);
    if (this.#state !== 'running') {
      // paused: the next segment takes it
      const s = this.#segments[this.#segments.length - 1];
      if (s !== undefined) this.#segments[this.#segments.length - 1] = { ...s, tempo };
      return;
    }
    const s = this.#segments[this.#segments.length - 1] as Segment;
    const at = Math.max(t, s.audioFrom);
    const position = this.position(at);
    s.audioTo = at;
    this.#segments.push({ audioFrom: at, audioTo: null, refFrom: position, tempo });
  }

  /** Stop: the position is held where it was. */
  stop(t: number): void {
    if (this.#state === 'running') this.pause(t);
    this.#state = 'stopped';
  }
}

export interface Beat {
  /** reference seconds */
  readonly time: number;
  /** the bar, counted as practice counts it: 0 for a pickup */
  readonly bar: number;
  /** the beat in its bar, from 1 */
  readonly beat: number;
  /** beats in this bar */
  readonly of: number;
}

/** Every beat of the song (the time signature's note value), from its start to its end, numbered within its bar — a pickup's beats end its bar. */
export function beatGrid(reference: Reference, pickupTicks = 0): Beat[] {
  const timing = reference.timing;
  if (timing.division.kind !== 'ppq') return [];
  const ppq = timing.division.ticksPerQuarter;
  const map = tempoMapOf(reference);
  const signatures = timing.timeSignatures.length > 0 ? timing.timeSignatures : [{ tick: 0, seconds: 0, numerator: 4, denominator: 4 }];
  const sigAt = (tick: number): (typeof signatures)[number] => [...signatures].reverse().find((s) => s.tick <= tick) ?? (signatures[0] as (typeof signatures)[number]);
  const beats: Beat[] = [];
  // the pickup: the last beats of bar 0
  const first = sigAt(0);
  const pickupBeat = (4 * ppq) / first.denominator;
  const pickupBeats = Math.round(pickupTicks / pickupBeat);
  for (let i = 0; i < pickupBeats; i++) beats.push({ time: map.secondsAt(i * pickupBeat), bar: 0, beat: first.numerator - pickupBeats + 1 + i, of: first.numerator });
  let tick = pickupTicks;
  let bar = 1;
  while (tick < timing.endTick) {
    const sig = sigAt(tick);
    const beatTicks = (4 * ppq) / sig.denominator;
    for (let b = 1; b <= sig.numerator && tick < timing.endTick; b++, tick += beatTicks) beats.push({ time: map.secondsAt(tick), bar, beat: b, of: sig.numerator });
    bar++;
  }
  return beats;
}
