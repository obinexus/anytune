/**
 * The live analysis of what a learner plays: captured frames in — each stamped with the capture time of its first sample — and timed events out: a note
 * (onset, settled pitch), a strum's chord candidates, and the current pitch for the meter. Everything happens on the frames pushed, never on a timer, so the
 * times are the capture clock's, whatever the delay before they are pushed.
 *
 * Bounded: the history kept is a few hundred milliseconds of samples (enough for the chord frame after a strum and the pitch after an onset), and the events
 * waiting to be settled are capped — a learner strumming faster than the analysis can settle drops the oldest, said in `dropped`. No allocation grows with the
 * length of a session.
 */
import { createYinDetector, type PitchDetector } from '../audio/pitch-detector.ts';
import { CHORD_FRAME_SIZE, createChordAnalyser, type ChordAnalyser, type ChordReading } from './chords.ts';
import { OnsetDetector, type Onset } from './onsets.ts';

/** One pitch reading after an onset: the fractional MIDI note YIN found (null: no pitch at all) and how sure it was. */
export interface Observation {
  readonly time: number;
  readonly midi: number | null;
  readonly confidence: number;
}

export type LiveEvent =
  /** an onset whose pitch settled: its key, and every reading of its window (the observations a consensus is taken over) */
  | { readonly kind: 'note'; readonly time: number; readonly key: number; readonly cents: number; readonly confidence: number; readonly observations: readonly Observation[] }
  /** something was struck — an onset — but no pitch settled after it with confidence: a note too faint, too short or too noisy to name. Said apart, so that
   * it is never mistaken for a note not played. */
  | { readonly kind: 'unclear'; readonly time: number; readonly strength: number; readonly observations: readonly Observation[] }
  /** a strum: its chord readings (one per chord frame after it, the first also as `reading`) and the pitch readings of the same window */
  | { readonly kind: 'chord'; readonly time: number; readonly reading: ChordReading; readonly readings: readonly ChordReading[]; readonly observations: readonly Observation[] }
  | { readonly kind: 'onset'; readonly time: number; readonly strength: number }
  | { readonly kind: 'pitch'; readonly time: number; readonly frequencyHz: number; readonly confidence: number };

export interface LiveOptions {
  readonly sampleRate: number;
  /** what to listen for: single notes (melody), chords (strums), or both */
  readonly listenFor: 'notes' | 'chords' | 'both';
  readonly referenceHz: number;
  readonly minConfidence: number;
  /** the most onsets waiting to be settled */
  readonly maxPending: number;
  /** the pitch readings after an onset: from `from` to `to` seconds after it, every `step` — the observation window */
  readonly noteWindow: { readonly from: number; readonly to: number; readonly step: number };
  /** the chord frames read after a strum: seconds after the onset (each frame is CHORD_FRAME_SIZE samples) */
  readonly chordOffsets: readonly number[];
}

export const DEFAULT_NOTE_WINDOW = Object.freeze({ from: 0.03, to: 0.12, step: 0.015 });

const PITCH_FRAME = 2048;

export class LiveAnalyser {
  readonly #o: LiveOptions;
  #onsets: OnsetDetector;
  readonly #yin: PitchDetector;
  readonly #chords: ChordAnalyser;
  /** a ring of the most recent samples */
  readonly #ring: Float32Array;
  #written = 0; // samples ever written
  #origin: number | null = null; // capture time of sample 0
  readonly #pending: Onset[] = [];
  #lastStrum = Number.NEGATIVE_INFINITY;
  #lastPitchAt = Number.NEGATIVE_INFINITY;
  dropped = 0;

  constructor(options: Partial<LiveOptions> & Pick<LiveOptions, 'sampleRate'>) {
    this.#o = { listenFor: 'notes', referenceHz: 440, minConfidence: 0.6, maxPending: 8, noteWindow: DEFAULT_NOTE_WINDOW, chordOffsets: [0.02], ...options };
    this.#onsets = new OnsetDetector({ sampleRate: this.#o.sampleRate });
    this.#yin = createYinDetector();
    this.#chords = createChordAnalyser();
    // the chord frames after a strum (the last starts at the largest offset), the pitch window, and room for the frames still to come
    const reach = Math.max(this.#o.noteWindow.to, ...this.#o.chordOffsets);
    this.#ring = new Float32Array(2 ** Math.ceil(Math.log2(CHORD_FRAME_SIZE + this.#o.sampleRate * (reach + 0.3))));
  }

  /** Push captured samples whose first sample was captured at `captureTime` (seconds, monotonic). Returns the events they complete, in time order. */
  push(samples: Float32Array, captureTime: number): LiveEvent[] {
    if (this.#origin === null) this.#origin = captureTime;
    else {
      // a gap or an overlap in the capture (a dropped buffer, a clock jump): the stream is restarted from here, so that no time is invented
      const expected = this.#origin + this.#written / this.#o.sampleRate;
      if (Math.abs(captureTime - expected) > 0.05) this.#restart(captureTime);
    }
    const events: LiveEvent[] = [];
    for (let i = 0; i < samples.length; i++) this.#ring[(this.#written + i) % this.#ring.length] = samples[i] as number;
    this.#written += samples.length;
    for (const onset of this.#onsets.push(samples)) {
      const at = (this.#origin as number) + onset.time;
      if (this.#o.listenFor !== 'notes') {
        if (at - this.#lastStrum < 0.15) continue; // the later strings of the same strum
        this.#lastStrum = at;
      }
      events.push({ kind: 'onset', time: at, strength: onset.strength });
      this.#pending.push({ time: at, strength: onset.strength });
      if (this.#pending.length > this.#o.maxPending) {
        this.#pending.shift();
        this.dropped++;
      }
    }
    events.push(...this.#settle());
    const now = this.#time(this.#written);
    if (now - this.#lastPitchAt >= 0.05 && this.#written >= PITCH_FRAME) {
      this.#lastPitchAt = now;
      const d = this.#yin.detect(this.#window(this.#written - PITCH_FRAME, PITCH_FRAME), this.#o.sampleRate);
      if (d !== null) events.push({ kind: 'pitch', time: this.#time(this.#written - PITCH_FRAME / 2), frequencyHz: d.frequencyHz, confidence: d.confidence });
    }
    return events.sort((a, b) => a.time - b.time);
  }

  /** A discontinuity: everything belonging to the interrupted stream is dropped, and analysis starts again at `captureTime`. */
  #restart(captureTime: number): void {
    this.#origin = captureTime;
    this.#written = 0;
    this.#pending.length = 0;
    this.#ring.fill(0);
    this.#onsets = new OnsetDetector({ sampleRate: this.#o.sampleRate });
    this.discontinuities++;
  }

  /** gaps or overlaps found in the capture's timestamps */
  discontinuities = 0;

  #time(sample: number): number {
    return (this.#origin as number) + sample / this.#o.sampleRate;
  }

  /** `length` samples starting at absolute sample `from`, out of the ring. */
  #window(from: number, length: number): Float32Array {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = this.#ring[(from + i) % this.#ring.length] as number;
    return out;
  }

  /** Onsets whose following audio has arrived are settled into notes or chords. */
  #settle(): LiveEvent[] {
    const out: LiveEvent[] = [];
    const sr = this.#o.sampleRate;
    while (this.#pending.length > 0) {
      const onset = this.#pending[0] as Onset;
      const start = Math.round((onset.time - (this.#origin as number)) * sr);
      const w = this.#o.noteWindow;
      const needNote = start + Math.round(w.to * sr) + PITCH_FRAME / 2;
      const needChord = this.#o.listenFor !== 'notes' ? start + Math.round(Math.max(...this.#o.chordOffsets) * sr) + CHORD_FRAME_SIZE : 0;
      if (this.#written < Math.max(needNote, needChord)) break;
      this.#pending.shift();
      if (this.#written - start > this.#ring.length - CHORD_FRAME_SIZE) continue; // too old: its samples are gone
      const { note, observations } = this.#noteAfter(start, onset.time);
      if (this.#o.listenFor !== 'chords') {
        out.push(note !== null ? { kind: 'note', time: onset.time, ...note, observations } : { kind: 'unclear', time: onset.time, strength: onset.strength, observations });
      }
      if (this.#o.listenFor !== 'notes') {
        const readings = this.#o.chordOffsets.flatMap((offset) => {
          const r = this.#chords.read(this.#window(start + Math.round(offset * sr), CHORD_FRAME_SIZE), sr);
          return r === null ? [] : [r];
        });
        const first = readings[0];
        if (first !== undefined) out.push({ kind: 'chord', time: onset.time, reading: first, readings, observations });
      }
    }
    return out;
  }

  /**
   * The pitch that settles after an onset — the median of the confident YIN readings in the observation window (30 ms to 120 ms after it, by default) —
   * and every reading of the window, confident or not: the observations a consensus is taken over.
   */
  #noteAfter(start: number, onsetTime: number): { note: { key: number; cents: number; confidence: number } | null; observations: Observation[] } {
    const sr = this.#o.sampleRate;
    const w = this.#o.noteWindow;
    const readings: { midi: number; confidence: number }[] = [];
    const observations: Observation[] = [];
    for (let centre = start + Math.round(w.from * sr); centre <= start + Math.round(w.to * sr); centre += Math.max(1, Math.round(w.step * sr))) {
      const d = this.#yin.detect(this.#window(centre - PITCH_FRAME / 2, PITCH_FRAME), sr);
      const midi = d === null ? null : 69 + 12 * Math.log2(d.frequencyHz / this.#o.referenceHz);
      observations.push({ time: onsetTime + (centre - start) / sr, midi, confidence: d?.confidence ?? 0 });
      if (d !== null && midi !== null && d.confidence >= this.#o.minConfidence) readings.push({ midi, confidence: d.confidence });
    }
    if (readings.length === 0) return { note: null, observations };
    const sorted = readings.map((r) => r.midi).sort((a, b) => a - b);
    const m = sorted[Math.floor(sorted.length / 2)] as number;
    const key = Math.round(m);
    const confidences = readings.map((r) => r.confidence).sort((a, b) => a - b);
    return { note: { key, cents: Math.round((m - key) * 1000) / 10, confidence: confidences[Math.floor(confidences.length / 2)] as number }, observations };
  }
}
