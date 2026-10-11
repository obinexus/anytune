/**
 * Feedback a learner can act on: what went right, then the one thing to do next — "Try bar 3 again", "You are about 60 ms late: listen to the click" — in
 * words, never only a colour or a score. Pitch and timing are reported separately. Uncertain readings are counted apart and never counted as mistakes.
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
}

export interface Feedback {
  readonly pitch: { readonly right: number; readonly octave: number; readonly wrong: number; readonly missed: number; readonly uncertain: number; readonly of: number };
  /** of the targets whose timing was judged */
  readonly timing: { readonly onTime: number; readonly early: number; readonly late: number; readonly judged: number; readonly typicalOffsetMs: number | null };
  readonly extra: number;
  readonly bars: readonly BarSummary[];
  /** the bar most worth repeating, or null when there is none */
  readonly repeatBar: number | null;
  /** short sentences, most useful first */
  readonly sentences: readonly string[];
}

type Judged = { readonly bar: number; readonly pitch: 'right' | 'octave' | 'wrong' | 'missed' | 'uncertain'; readonly timing: 'on-time' | 'early' | 'late' | null; readonly offsetSeconds: number | null };

const fromNote = (r: NoteResult): Judged => ({ bar: r.expected.bar, pitch: r.pitch === 'correct' ? 'right' : r.pitch, timing: r.timing, offsetSeconds: r.offsetSeconds });
const fromChord = (r: ChordResult): Judged => ({ bar: r.expected.bar, pitch: r.chord === 'correct' ? 'right' : r.chord, timing: r.timing, offsetSeconds: r.offsetSeconds });

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function feedbackOf(notes: readonly NoteResult[], chords: readonly ChordResult[], extra: number): Feedback {
  const all: Judged[] = [...notes.map(fromNote), ...chords.map(fromChord)];
  const count = (p: (j: Judged) => boolean): number => all.filter(p).length;
  const pitch = { right: count((j) => j.pitch === 'right'), octave: count((j) => j.pitch === 'octave'), wrong: count((j) => j.pitch === 'wrong'), missed: count((j) => j.pitch === 'missed'), uncertain: count((j) => j.pitch === 'uncertain'), of: all.length };
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
    };
  });
  // the bar to repeat: the most missed and wrong targets, then the fewest on time; ties go to the earlier bar
  const trouble = (b: BarSummary): number => 2 * (b.missed + b.wrong) + (b.targets - b.uncertain - b.onTime - b.missed) * 0.5;
  const worst = bars.reduce<BarSummary | null>((w, b) => (trouble(b) > 0 && (w === null || trouble(b) > trouble(w)) ? b : w), null);

  const sentences: string[] = [];
  // heard clearly: neither missed nor too unsure to judge
  const clear = pitch.of - pitch.uncertain - pitch.missed;
  if (clear > 0 && pitch.right === clear) sentences.push(`Every note I heard clearly was the right one (${plural(pitch.right, 'note', 'notes')}).`);
  else if (clear > 0) sentences.push(`${pitch.right} of the ${plural(clear, 'note', 'notes')} I heard clearly ${pitch.right === 1 ? 'was' : 'were'} right.`);
  if (worst !== null) sentences.push(`Try bar ${worst.bar} again${worst.missed + worst.wrong > 0 ? ': that is where most notes went astray' : ': the notes were right, the timing can be closer'}.`);
  if (pitch.octave > 0) sentences.push(`${plural(pitch.octave, 'note was', 'notes were')} the right note in the wrong octave.`);
  if (pitch.missed > 0) sentences.push(`I did not hear ${plural(pitch.missed, 'note', 'notes')} where ${pitch.missed === 1 ? 'it was' : 'they were'} due.`);
  if (typical !== null && Math.abs(typical) > 50 && timing.late + timing.early > timing.onTime) sentences.push(`You are about ${Math.abs(typical)} ms ${typical > 0 ? 'behind' : 'ahead of'} the beat: listen to the click${typical > 0 ? ', or try a slower tempo' : ''}.`);
  else if (timing.judged > 0) sentences.push(`Timing: ${timing.onTime} on time, ${timing.early} early, ${timing.late} late.`);
  if (pitch.uncertain > 0) sentences.push(`${plural(pitch.uncertain, 'note was', 'notes were')} too unclear to judge — not counted as mistakes.`);
  if (extra > 0) sentences.push(`I also heard ${plural(extra, 'note', 'notes')} the music does not ask for.`);
  return { pitch, timing, extra, bars, repeatBar: worst?.bar ?? null, sentences };
}
