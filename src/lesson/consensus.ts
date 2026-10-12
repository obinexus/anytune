/**
 * The decision Follow my playing takes on one attack — one pluck or strum: a CONSENSUS across the short sequence of observations that follows it.
 *
 *   YES     enough confident observations, and enough of them agree on the target: the target was played
 *   NO      enough confident observations agree on something else: what was heard is said, and the same target is tried again
 *   MAYBE   silence, too few confident observations, or no agreement — or a chord the detector cannot assess: keep listening; never a mistake
 *
 * The thresholds are options, not constants: how sure an observation must be to count (`minConfidence`), how many must count (`minObservations`), and how
 * many of those must agree (`agreement`). The observation window itself — how long after the attack, how often — is the analyser's (src/analysis/live.ts,
 * `noteWindow`, `chordOffsets`). The defaults are calibrated on SYNTHETIC plucked strings only (tests/lesson/consensus.test.ts); no real guitar recording
 * has been measured yet.
 *
 * Notes and chords are judged apart. A note target wants one pitch. A chord target wants the chord's pattern, read from chord frames — and a clean single
 * note (a confident, agreeing pitch: periodic, as a chord is not) is NOT a chord, even when it is the chord's root: "heard only E2".
 */

export interface ConsensusOptions {
  /** an observation counts only at or above this confidence (0…1) */
  readonly minConfidence: number;
  /** a decision needs at least this many confident pitch observations… */
  readonly minObservations: number;
  /** …of which this share must agree on one note */
  readonly agreement: number;
  /** a chord decision needs at least this many confident chord readings, agreeing as above */
  readonly minChordReadings: number;
}

export const DEFAULT_CONSENSUS: ConsensusOptions = Object.freeze({ minConfidence: 0.6, minObservations: 3, agreement: 0.6, minChordReadings: 2 });

/** A pitch observation: a fractional MIDI note (null: no pitch) and how sure it is. */
export interface PitchObservation {
  readonly midi: number | null;
  readonly confidence: number;
}

/** A chord reading: candidates best first, and how sure of the best (0 when the open-set gate refused every chord). */
export interface ChordObservation {
  readonly candidates: readonly { readonly symbol: string }[];
  readonly confidence: number;
}

export type MaybeReason = 'silence' | 'unclear' | 'disagreement' | 'unsupported' | 'own-playback';

export type Decision =
  | { readonly kind: 'yes' }
  | { readonly kind: 'no'; readonly why: 'different-note' | 'octave' | 'single-note' | 'different-chord'; readonly heardKey: number | null; readonly heardSymbol: string | null }
  | { readonly kind: 'maybe'; readonly why: MaybeReason };

/** The note most confident observations agree on, if enough do: its rounded key. */
export function agreedNote(observations: readonly PitchObservation[], o: ConsensusOptions = DEFAULT_CONSENSUS): { readonly key: number } | { readonly none: MaybeReason } {
  const confident = observations.filter((x): x is { midi: number; confidence: number } => x.midi !== null && x.confidence >= o.minConfidence);
  if (confident.length === 0) return { none: observations.some((x) => x.midi !== null) ? 'unclear' : 'silence' };
  if (confident.length < o.minObservations) return { none: 'unclear' };
  const counts = new Map<number, number>();
  for (const x of confident) counts.set(Math.round(x.midi), (counts.get(Math.round(x.midi)) ?? 0) + 1);
  const [key, count] = [...counts.entries()].reduce((best, e) => (e[1] > best[1] ? e : best));
  return count / confident.length >= o.agreement ? { key } : { none: 'disagreement' };
}

/** A note target: YES on agreement on its key; NO on agreement on another (an octave said apart); otherwise MAYBE. */
export function judgeNote(targetKey: number, observations: readonly PitchObservation[], o: ConsensusOptions = DEFAULT_CONSENSUS): Decision {
  const agreed = agreedNote(observations, o);
  if ('none' in agreed) return { kind: 'maybe', why: agreed.none };
  if (agreed.key === targetKey) return { kind: 'yes' };
  return { kind: 'no', why: (agreed.key - targetKey) % 12 === 0 ? 'octave' : 'different-note', heardKey: agreed.key, heardSymbol: null };
}

/**
 * A chord target, of a vocabulary the detector supports: a clean single note is NO ("heard only…"), whatever it is; YES on agreement of the chord readings
 * on the target; NO on agreement on another chord; otherwise MAYBE. A chord outside `supported` is always MAYBE: it cannot be assessed.
 */
export function judgeChord(symbol: string, readings: readonly ChordObservation[], observations: readonly PitchObservation[], supported: readonly string[], o: ConsensusOptions = DEFAULT_CONSENSUS): Decision {
  if (!supported.includes(symbol)) return { kind: 'maybe', why: 'unsupported' };
  const single = agreedNote(observations, o);
  if ('key' in single) return { kind: 'no', why: 'single-note', heardKey: single.key, heardSymbol: null };
  const confident = readings.filter((r) => r.confidence >= o.minConfidence && r.candidates[0] !== undefined);
  if (confident.length === 0) return { kind: 'maybe', why: readings.length === 0 ? 'silence' : 'unclear' };
  if (confident.length < o.minChordReadings) return { kind: 'maybe', why: 'unclear' };
  const counts = new Map<string, number>();
  for (const r of confident) {
    const best = (r.candidates[0] as { symbol: string }).symbol;
    counts.set(best, (counts.get(best) ?? 0) + 1);
  }
  const [best, count] = [...counts.entries()].reduce((b, e) => (e[1] > b[1] ? e : b));
  if (count / confident.length < o.agreement) return { kind: 'maybe', why: 'disagreement' };
  return best === symbol ? { kind: 'yes' } : { kind: 'no', why: 'different-chord', heardKey: null, heardSymbol: best };
}
