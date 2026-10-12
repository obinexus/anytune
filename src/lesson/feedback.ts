/**
 * Feedback a learner can act on: what went right, then the one thing to do next — "Try bar 3 again", "You are about 60 ms late: listen to the click" — in
 * words, never only a colour or a score. Pitch and timing are reported separately. Uncertain readings are counted apart and never counted as mistakes.
 *
 * Only what was ASSESSED counts. A target the microphone could not cover (its capture had stopped, or sent digital silence) is unassessed: it is in no
 * total, no accuracy and no bar to repeat, and the review says how much was assessed. With nothing assessed there is no verdict at all — "This attempt could
 * not be assessed — check your microphone" — never every note missed. A bar is recommended only when enough was assessed, and something was heard.
 */
import type { ChordResult, NoteResult } from './assessment.ts';

export interface BarSummary {
  readonly bar: number;
  readonly targets: number;
  readonly pitchRight: number;
  readonly onTime: number;
  readonly missed: number;
  readonly wrong: number;
  readonly uncertain: number;
  /** targets the microphone could not cover: not counted */
  readonly unassessed: number;
}

export interface Feedback {
  readonly pitch: { readonly right: number; readonly octave: number; readonly wrong: number; readonly missed: number; readonly uncertain: number; readonly unassessed: number; readonly of: number; readonly assessed: number };
  /** of the targets whose timing was judged */
  readonly timing: { readonly onTime: number; readonly early: number; readonly late: number; readonly judged: number; readonly typicalOffsetMs: number | null };
  readonly extra: number;
  readonly bars: readonly BarSummary[];
  /** the bar most worth repeating — or null when there is none, or not enough was assessed to say */
  readonly repeatBar: number | null;
  /** short sentences, most useful first */
  readonly sentences: readonly string[];
}

type Judged = { readonly bar: number; readonly pitch: 'right' | 'octave' | 'wrong' | 'missed' | 'uncertain' | 'unassessed'; readonly timing: 'on-time' | 'early' | 'late' | null; readonly offsetSeconds: number | null };

const fromNote = (r: NoteResult): Judged => ({ bar: r.expected.bar, pitch: r.pitch === 'correct' ? 'right' : r.pitch, timing: r.timing, offsetSeconds: r.offsetSeconds });
const fromChord = (r: ChordResult): Judged => ({ bar: r.expected.bar, pitch: r.chord === 'correct' ? 'right' : r.chord, timing: r.timing, offsetSeconds: r.offsetSeconds });

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Below this share of the targets assessed, no bar is recommended: there is not enough to go on. */
export const MIN_ASSESSED_SHARE = 0.5;

export const NOT_ASSESSED = 'This attempt could not be assessed — check your microphone.';

export function feedbackOf(notes: readonly NoteResult[], chords: readonly ChordResult[], extra: number): Feedback {
  const all: Judged[] = [...notes.map(fromNote), ...chords.map(fromChord)];
  const count = (p: (j: Judged) => boolean): number => all.filter(p).length;
  const unassessed = count((j) => j.pitch === 'unassessed');
  const pitch = { right: count((j) => j.pitch === 'right'), octave: count((j) => j.pitch === 'octave'), wrong: count((j) => j.pitch === 'wrong'), missed: count((j) => j.pitch === 'missed'), uncertain: count((j) => j.pitch === 'uncertain'), unassessed, of: all.length, assessed: all.length - unassessed };
  const judged = all.filter((j) => j.timing !== null);
  const offsets = judged.map((j) => j.offsetSeconds as number).sort((a, b) => a - b);
  const typical = offsets.length === 0 ? null : Math.round(1000 * (offsets.length % 2 ? (offsets[(offsets.length - 1) / 2] as number) : ((offsets[offsets.length / 2 - 1] as number) + (offsets[offsets.length / 2] as number)) / 2));
  const timing = { onTime: judged.filter((j) => j.timing === 'on-time').length, early: judged.filter((j) => j.timing === 'early').length, late: judged.filter((j) => j.timing === 'late').length, judged: judged.length, typicalOffsetMs: typical };

  const bars = [...new Set(all.map((j) => j.bar))].sort((a, b) => a - b).map((bar): BarSummary => {
    const inBar = all.filter((j) => j.bar === bar);
    return {
      bar,
      targets: inBar.length,
      pitchRight: inBar.filter((j) => j.pitch === 'right').length,
      onTime: inBar.filter((j) => j.timing === 'on-time').length,
      missed: inBar.filter((j) => j.pitch === 'missed').length,
      wrong: inBar.filter((j) => j.pitch === 'wrong' || j.pitch === 'octave').length,
      uncertain: inBar.filter((j) => j.pitch === 'uncertain').length,
      unassessed: inBar.filter((j) => j.pitch === 'unassessed').length,
    };
  });

  // nothing assessed: no verdict at all — never every note "missed"
  if (pitch.assessed === 0) return { pitch, timing, extra, bars, repeatBar: null, sentences: all.length === 0 ? [] : [NOT_ASSESSED] };

  // heard: a note, or something unclear, matched to a target — or a note the music did not ask for
  const heardAnything = pitch.right + pitch.octave + pitch.wrong + pitch.uncertain + extra > 0;
  const enough = pitch.assessed / pitch.of >= MIN_ASSESSED_SHARE && heardAnything;
  // the bar to repeat: the most missed and wrong targets, then the fewest on time; ties go to the earlier bar — among bars with enough assessed in them
  const trouble = (b: BarSummary): number => 2 * (b.missed + b.wrong) + (b.targets - b.unassessed - b.uncertain - b.onTime - b.missed) * 0.5;
  const candidates = bars.filter((b) => b.targets - b.unassessed - b.uncertain >= Math.min(2, b.targets));
  const worst = !enough ? null : candidates.reduce<BarSummary | null>((w, b) => (trouble(b) > 0 && (w === null || trouble(b) > trouble(w)) ? b : w), null);

  const sentences: string[] = [];
  if (!heardAnything) sentences.push('I heard no notes at all while the microphone was working. If you were playing, check that it can hear the guitar: Timing and microphone details shows what it received.');
  // heard clearly: neither missed, unclear nor unassessed
  const clear = pitch.assessed - pitch.uncertain - pitch.missed;
  if (clear > 0 && pitch.right === clear) sentences.push(`Every note I heard clearly was the right one (${plural(pitch.right, 'note', 'notes')}).`);
  else if (clear > 0) sentences.push(`${pitch.right} of the ${plural(clear, 'note', 'notes')} I heard clearly ${pitch.right === 1 ? 'was' : 'were'} right.`);
  if (worst !== null) sentences.push(`Try bar ${worst.bar} again${worst.missed + worst.wrong > 0 ? ': that is where most notes went astray' : ': the notes were right, the timing can be closer'}.`);
  if (pitch.octave > 0) sentences.push(`${plural(pitch.octave, 'note was', 'notes were')} the right note in the wrong octave.`);
  if (pitch.missed > 0 && heardAnything) sentences.push(`I did not hear ${plural(pitch.missed, 'note', 'notes')} where ${pitch.missed === 1 ? 'it was' : 'they were'} due.`);
  if (typical !== null && Math.abs(typical) > 50 && timing.late + timing.early > timing.onTime) sentences.push(`You are about ${Math.abs(typical)} ms ${typical > 0 ? 'behind' : 'ahead of'} the beat: listen to the click${typical > 0 ? ', or try a slower tempo' : ''}.`);
  else if (timing.judged > 0) sentences.push(`Timing: ${timing.onTime} on time, ${timing.early} early, ${timing.late} late.`);
  if (pitch.uncertain > 0) sentences.push(`${plural(pitch.uncertain, 'note was', 'notes were')} too unclear to judge — not counted as mistakes.`);
  if (extra > 0) sentences.push(`I also heard ${plural(extra, 'note', 'notes')} the music does not ask for.`);
  if (pitch.unassessed > 0) sentences.push(`Assessed: ${pitch.assessed} of ${plural(pitch.of, 'note', 'notes')}. For the other ${pitch.unassessed} the microphone was not delivering sound, so they are not counted.`);
  if (!enough && heardAnything) sentences.push('Not enough of the attempt was assessed to say which bar to repeat.');
  return { pitch, timing, extra, bars, repeatBar: worst?.bar ?? null, sentences };
}
