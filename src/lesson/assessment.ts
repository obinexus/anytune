/**
 * Assessment: what the learner played, aligned with what the reference asks for — pitch and timing judged SEPARATELY, so that "the right note, late" is never
 * confused with "a wrong note on time", and one missed note never shifts the blame onto every note after it.
 *
 * The alignment is a dynamic program over the expected events and the heard events (both in reference seconds): an expected event is matched with at most one
 * heard event, in order, or missed; a heard event is matched or extra. A match is allowed only within a bounded window around where the expected event is
 * due — shifted by the learner's own local offset (the median lag of nearby same-pitch hits, clamped), so that a learner running steadily behind is still
 * aligned, note for note, and told "late", rather than told everything was missed. Timing is then judged against the reference's own time, unshifted.
 *
 * Uncertainty is kept out of correctness: a heard event less sure than the policy's minimum is "uncertain" — neither right nor wrong.
 */

export interface ExpectedNote {
  readonly id: string;
  /** MIDI note number the arrangement asks for */
  readonly key: number;
  /** reference seconds */
  readonly time: number;
  /** the bar it is in, counted from 1 */
  readonly bar: number;
}

export interface HeardNote {
  /** reference seconds (the lesson clock maps capture time to these) */
  readonly time: number;
  /** the nearest MIDI note to the pitch heard */
  readonly key: number;
  /** how far the pitch was from that note, in cents */
  readonly cents: number;
  /** how sure the detector was, 0…1 */
  readonly confidence: number;
}

export type PitchVerdict = 'correct' | 'octave' | 'wrong' | 'uncertain' | 'missed';
export type TimingVerdict = 'on-time' | 'early' | 'late';

export interface NoteResult {
  readonly expected: ExpectedNote;
  readonly heard: HeardNote | null;
  readonly pitch: PitchVerdict;
  /** null when missed, or when timing is not being assessed (step mode) */
  readonly timing: TimingVerdict | null;
  /** heard − expected, seconds; null when missed */
  readonly offsetSeconds: number | null;
}

export interface NoteAssessment {
  readonly results: readonly NoteResult[];
  /** heard notes no expected note accounts for */
  readonly extra: readonly HeardNote[];
}

export interface AssessmentPolicy {
  /** |offset| within this is on time */
  readonly onTimeSeconds: number;
  /** a heard note further than this from where the expected note is due (after the local offset) cannot be it */
  readonly windowSeconds: number;
  /** the largest local offset followed */
  readonly maxDriftSeconds: number;
  /** a heard note less sure than this is uncertain */
  readonly minConfidence: number;
  /** judge timing at all (false in step mode, where the learner sets the pace) */
  readonly assessTiming: boolean;
}

export const DEFAULT_POLICY: AssessmentPolicy = Object.freeze({ onTimeSeconds: 0.08, windowSeconds: 0.3, maxDriftSeconds: 0.5, minConfidence: 0.6, assessTiming: true });

const MISS = 1;
const EXTRA = 0.6;

function pitchOf(expected: ExpectedNote, heard: HeardNote, policy: AssessmentPolicy): Exclude<PitchVerdict, 'missed'> {
  if (!(heard.confidence >= policy.minConfidence)) return 'uncertain';
  if (heard.key === expected.key) return 'correct';
  if ((heard.key - expected.key) % 12 === 0) return 'octave';
  return 'wrong';
}

const pitchCost: Readonly<Record<Exclude<PitchVerdict, 'missed'>, number>> = { correct: 0, uncertain: 0.25, octave: 0.35, wrong: 0.75 };

/** The learner's local lag around each expected note: the median offset of the nearest same-pitch-class hits within reach of its neighbours, clamped. */
function localOffsets(expected: readonly ExpectedNote[], heard: readonly HeardNote[], policy: AssessmentPolicy): number[] {
  const reach = policy.windowSeconds + policy.maxDriftSeconds;
  const lags = expected.map((e) => {
    let best: number | null = null;
    for (const h of heard) {
      const dt = h.time - e.time;
      if (Math.abs(dt) <= reach && ((h.key - e.key) % 12 + 12) % 12 === 0 && h.confidence >= policy.minConfidence && (best === null || Math.abs(dt) < Math.abs(best))) best = dt;
    }
    return best;
  });
  return expected.map((_, i) => {
    const near = lags.slice(Math.max(0, i - 3), i + 4).filter((x): x is number => x !== null).sort((a, b) => a - b);
    if (near.length === 0) return 0;
    const median = near.length % 2 === 1 ? (near[(near.length - 1) / 2] as number) : ((near[near.length / 2 - 1] as number) + (near[near.length / 2] as number)) / 2;
    return Math.max(-policy.maxDriftSeconds, Math.min(policy.maxDriftSeconds, median));
  });
}

export function assessNotes(expectedIn: readonly ExpectedNote[], heardIn: readonly HeardNote[], policy: AssessmentPolicy = DEFAULT_POLICY): NoteAssessment {
  const expected = [...expectedIn].sort((a, b) => a.time - b.time);
  const heard = [...heardIn].sort((a, b) => a.time - b.time);
  const n = expected.length;
  const m = heard.length;
  const offsets = localOffsets(expected, heard, policy);
  const width = m + 1;
  const cost = new Float64Array((n + 1) * width).fill(Number.POSITIVE_INFINITY);
  const move = new Uint8Array((n + 1) * width); // 1 miss, 2 extra, 3 match
  cost[0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = cost[i * width + j] as number;
      if (here === Number.POSITIVE_INFINITY) continue;
      if (i < n && here + MISS < (cost[(i + 1) * width + j] as number)) {
        cost[(i + 1) * width + j] = here + MISS;
        move[(i + 1) * width + j] = 1;
      }
      if (j < m && here + EXTRA < (cost[i * width + j + 1] as number)) {
        cost[i * width + j + 1] = here + EXTRA;
        move[i * width + j + 1] = 2;
      }
      if (i < n && j < m) {
        const e = expected[i] as ExpectedNote;
        const h = heard[j] as HeardNote;
        const shifted = h.time - (e.time + (offsets[i] as number));
        if (Math.abs(shifted) <= policy.windowSeconds) {
          const c = here + pitchCost[pitchOf(e, h, policy)] + 0.5 * (Math.abs(shifted) / policy.windowSeconds);
          if (c < (cost[(i + 1) * width + j + 1] as number)) {
            cost[(i + 1) * width + j + 1] = c;
            move[(i + 1) * width + j + 1] = 3;
          }
        }
      }
    }
  }
  const results: NoteResult[] = [];
  const extra: HeardNote[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = move[i * width + j];
    if (step === 3) {
      const e = expected[i - 1] as ExpectedNote;
      const h = heard[j - 1] as HeardNote;
      const dt = h.time - e.time;
      const timing: TimingVerdict | null = !policy.assessTiming ? null : Math.abs(dt) <= policy.onTimeSeconds ? 'on-time' : dt < 0 ? 'early' : 'late';
      results.push({ expected: e, heard: h, pitch: pitchOf(e, h, policy), timing, offsetSeconds: dt });
      i--;
      j--;
    } else if (step === 1) {
      results.push({ expected: expected[i - 1] as ExpectedNote, heard: null, pitch: 'missed', timing: null, offsetSeconds: null });
      i--;
    } else {
      extra.push(heard[j - 1] as HeardNote);
      j--;
    }
  }
  return { results: results.reverse(), extra: extra.reverse() };
}

// --------------------------------------------------------------------------------------------------------------------------------------------- chords

export interface ExpectedChord {
  readonly id: string;
  /** a chord identity (src/music/chords.ts) */
  readonly symbol: string;
  readonly time: number;
  readonly bar: number;
}

export interface HeardChord {
  readonly time: number;
  /** the analysis's candidates, best first */
  readonly candidates: readonly { readonly symbol: string; readonly score: number }[];
  /** how sure the analysis is of its best candidate, 0…1 */
  readonly confidence: number;
}

export type ChordVerdict = 'correct' | 'wrong' | 'uncertain' | 'missed';

export interface ChordResult {
  readonly expected: ExpectedChord;
  readonly heard: HeardChord | null;
  readonly chord: ChordVerdict;
  /** what was heard instead, when wrong */
  readonly heardSymbol: string | null;
  readonly timing: TimingVerdict | null;
  readonly offsetSeconds: number | null;
}

/** Chords as notes are assessed: aligned in order within the window, the identity judged apart from the timing, an unsure analysis never a verdict. */
export function assessChords(expected: readonly ExpectedChord[], heard: readonly HeardChord[], policy: AssessmentPolicy = DEFAULT_POLICY): { readonly results: readonly ChordResult[]; readonly extra: readonly HeardChord[] } {
  // reuse the note alignment: a chord identity becomes a pseudo-key, its symbol's index in a shared table
  const symbols = [...new Set([...expected.map((e) => e.symbol), ...heard.flatMap((h) => h.candidates.map((c) => c.symbol))])];
  const keyOf = (symbol: string | undefined): number => (symbol === undefined ? -1 : symbols.indexOf(symbol) * 13 + 1); // never an octave of another
  const asNotes = assessNotes(
    expected.map((e) => ({ id: e.id, key: keyOf(e.symbol), time: e.time, bar: e.bar })),
    heard.map((h) => ({ time: h.time, key: keyOf(h.candidates[0]?.symbol), cents: 0, confidence: h.confidence })),
    policy,
  );
  const heardSorted = [...heard].sort((a, b) => a.time - b.time);
  const results = asNotes.results.map((r): ChordResult => {
    const e = expected.find((x) => x.id === r.expected.id) as ExpectedChord;
    const h = r.heard === null ? null : (heardSorted.find((x) => x.time === r.heard?.time) ?? null);
    const chord: ChordVerdict = r.pitch === 'missed' ? 'missed' : r.pitch === 'uncertain' ? 'uncertain' : r.pitch === 'correct' ? 'correct' : 'wrong';
    return { expected: e, heard: h, chord, heardSymbol: chord === 'wrong' ? (h?.candidates[0]?.symbol ?? null) : null, timing: r.timing, offsetSeconds: r.offsetSeconds };
  });
  const extra = asNotes.extra.map((x) => heardSorted.find((h) => h.time === x.time) as HeardChord);
  return { results, extra };
}
