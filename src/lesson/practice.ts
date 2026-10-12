/**
 * A practice session's time and targets. The learner practises an ARRANGEMENT of a reference — for a guitarist learning a piano piece, its melody, perhaps an
 * octave lower — never the reference changed. Three clocks are kept apart:
 *
 *   capture time    seconds on the device's monotonic clock, where the microphone's samples are stamped
 *   reference time  seconds on the reference's own timeline (its tempo map); what the targets and the assessment use
 *   wall clock      only metadata (when an attempt was made), never used for timing
 *
 * The LessonClock maps capture time to reference time — through the count-in, the tempo factor (0.5 = half speed), the A–B loop (pass after pass) and the
 * measured input latency — so that prompts, the reference's playback and the assessment stay on one timeline whatever the tempo and the loop.
 */
import type { Reference, ReferenceNote, ReferenceTiming } from '../music/reference.ts';
import type { ExpectedNote, HeardNote } from './assessment.ts';

/** The bar a tick falls in, counted from 1 — following the time signatures, after a pickup (anacrusis) of `pickupTicks` that counts as bar 0. */
export function barOfTick(tick: number, timing: ReferenceTiming, pickupTicks = 0): number {
  if (timing.division.kind !== 'ppq') return 1; // an SMPTE file has no bars to count
  const ppq = timing.division.ticksPerQuarter;
  if (tick < pickupTicks) return 0;
  const signatures = timing.timeSignatures.length > 0 ? timing.timeSignatures : [{ tick: 0, seconds: 0, numerator: 4, denominator: 4 }];
  let bar = 1;
  let at = pickupTicks;
  for (let s = 0; s < signatures.length; s++) {
    const sig = signatures[s] as (typeof signatures)[number];
    const barTicks = (sig.numerator * 4 * ppq) / sig.denominator;
    const next = signatures[s + 1];
    const until = next === undefined ? Number.POSITIVE_INFINITY : Math.max(at, next.tick);
    if (tick < until) return bar + Math.floor((tick - at) / barTicks);
    bar += Math.ceil((until - at) / barTicks);
    at = until;
  }
  return bar;
}

export interface ArrangementTargets {
  readonly targets: readonly ExpectedNote[];
  /** the transposition applied to the reference's notes, said to the learner */
  readonly octaveShift: number;
}

/**
 * The targets of a melody arrangement: the notes of one track of a reference, each moved by `octaveShift` semitones, with its bar. The reference is not
 * changed; the arrangement says what was taken and how it was moved.
 */
export function melodyTargets(reference: Reference, track: number, octaveShift: number, pickupTicks = 0): ArrangementTargets {
  const notes: ReferenceNote[] = reference.notes.filter((n) => n.track === track);
  return {
    octaveShift,
    targets: notes.map((n) => ({ id: n.id, key: n.key + octaveShift, time: n.onsetSeconds, bar: barOfTick(n.onsetTick, reference.timing, pickupTicks) })),
  };
}

export interface LessonClockSettings {
  /** capture time at which the count-in began */
  readonly startedAt: number;
  /** the count-in, in capture seconds */
  readonly countInSeconds: number;
  /** how fast the reference runs: 1 as written, 0.5 half speed */
  readonly tempoFactor: number;
  /** the A–B loop in reference seconds, or from `from` to the end once */
  readonly from: number;
  readonly to: number | null;
  /** measured input latency: a sound reaches the capture stamps this much late */
  readonly inputLatencySeconds: number;
  /** a note this much before the loop's end may be the next pass's first note, played early */
  readonly earlyAllowanceSeconds: number;
}

export type ClockReading = { readonly phase: 'count-in'; readonly secondsLeft: number } | { readonly phase: 'playing'; readonly pass: number; readonly time: number };

export class LessonClock {
  readonly settings: LessonClockSettings;

  constructor(settings: LessonClockSettings) {
    if (!(settings.tempoFactor > 0 && settings.tempoFactor <= 2)) throw new RangeError(`a tempo factor is in (0, 2], not ${settings.tempoFactor}`);
    if (settings.to !== null && !(settings.to > settings.from)) throw new RangeError('a loop ends after it starts');
    this.settings = settings;
  }

  /** Where on the reference's timeline a sound captured at `captureTime` was played: in the count-in, or in a pass of the loop at a reference time. */
  read(captureTime: number): ClockReading {
    const s = this.settings;
    const elapsed = captureTime - s.inputLatencySeconds - s.startedAt - s.countInSeconds;
    const early = s.earlyAllowanceSeconds * s.tempoFactor;
    if (elapsed * s.tempoFactor < -early) return { phase: 'count-in', secondsLeft: -elapsed };
    const reference = elapsed * s.tempoFactor;
    if (s.to === null) return { phase: 'playing', pass: 0, time: s.from + reference };
    const span = s.to - s.from;
    // a note a little before a pass's start belongs to that pass, played early
    const pass = Math.max(0, Math.floor((reference + early) / span));
    return { phase: 'playing', pass, time: s.from + reference - pass * span };
  }

  /** The capture time at which a reference time falls due in a pass — for prompts and the reference's playback. */
  due(pass: number, referenceTime: number): number {
    const s = this.settings;
    const span = s.to === null ? 0 : s.to - s.from;
    return s.startedAt + s.countInSeconds + (pass * span + referenceTime - s.from) / s.tempoFactor;
  }
}

export interface CapturedNote {
  /** capture time */
  readonly at: number;
  readonly key: number;
  readonly cents: number;
  readonly confidence: number;
}

/** Captured notes, sorted into the passes of a loop, on the reference's timeline; count-in notes are left out (they are the learner getting ready). */
export function notesByPass(clock: LessonClock, captured: readonly CapturedNote[]): Map<number, HeardNote[]> {
  const passes = new Map<number, HeardNote[]>();
  for (const c of captured) {
    const reading = clock.read(c.at);
    if (reading.phase !== 'playing') continue;
    passes.set(reading.pass, [...(passes.get(reading.pass) ?? []), { time: reading.time, key: c.key, cents: c.cents, confidence: c.confidence }]);
  }
  return passes;
}

/** The targets a loop pass asks for: those due from its start (inclusive) to its end (exclusive). */
export const targetsIn = <T extends ExpectedNote>(targets: readonly T[], from: number, to: number | null): T[] => targets.filter((t) => t.time >= from - 1e-9 && (to === null || t.time < to - 1e-9));

export type StepOutcome = { readonly kind: 'advanced'; readonly next: ExpectedNote | null } | { readonly kind: 'not-yet'; readonly heard: 'wrong' | 'octave' | 'uncertain' };

/**
 * Slow learning: the music waits for the learner. Each target is asked for in turn and the lesson moves on only when it is heard (with confidence); a wrong
 * note is said, and asked for again. Timing is not judged here — the learner sets the pace.
 */
export class StepPractice {
  readonly #targets: readonly ExpectedNote[];
  readonly #minConfidence: number;
  #index = 0;
  readonly tries: number[];

  constructor(targets: readonly ExpectedNote[], minConfidence = 0.6) {
    this.#targets = [...targets].sort((a, b) => a.time - b.time);
    this.#minConfidence = minConfidence;
    this.tries = this.#targets.map(() => 0);
  }

  get current(): ExpectedNote | null {
    return this.#targets[this.#index] ?? null;
  }

  get done(): boolean {
    return this.#index >= this.#targets.length;
  }

  hear(note: { readonly key: number; readonly confidence: number }): StepOutcome {
    const target = this.current;
    if (target === null) return { kind: 'advanced', next: null };
    if (!(note.confidence >= this.#minConfidence)) return { kind: 'not-yet', heard: 'uncertain' };
    this.tries[this.#index] = (this.tries[this.#index] as number) + 1;
    if (note.key === target.key) {
      this.#index++;
      return { kind: 'advanced', next: this.current };
    }
    return { kind: 'not-yet', heard: (note.key - target.key) % 12 === 0 ? 'octave' : 'wrong' };
  }
}
