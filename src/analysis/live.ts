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

export type LiveEvent =
  | { readonly kind: 'note'; readonly time: number; readonly key: number; readonly cents: number; readonly confidence: number }
  /** something was struck — an onset — but no pitch settled after it with confidence: a note too faint, too short or too noisy to name. Said apart, so that
   * it is never mistaken for a note not played. */
  | { readonly kind: 'unclear'; readonly time: number; readonly strength: number }
  | { readonly kind: 'chord'; readonly time: number; readonly reading: ChordReading }
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
}

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
    this.#o = { listenFor: 'notes', referenceHz: 440, minConfidence: 0.6, maxPending: 8, ...options };
    this.#onsets = new OnsetDetector({ sampleRate: this.#o.sampleRate });
    this.#yin = createYinDetector();
    this.#chords = createChordAnalyser();
    // the chord frame after a strum, 20 ms of attack before it, and room for the frames still to come
    this.#ring = new Float32Array(2 ** Math.ceil(Math.log2(CHORD_FRAME_SIZE + this.#o.sampleRate * 0.4)));
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
      const needNote = this.#o.listenFor !== 'chords' ? start + Math.round(0.12 * sr) + PITCH_FRAME / 2 : 0;
      const needChord = this.#o.listenFor !== 'notes' ? start + Math.round(0.02 * sr) + CHORD_FRAME_SIZE : 0;
      if (this.#written < Math.max(needNote, needChord)) break;
      this.#pending.shift();
      if (this.#written - start > this.#ring.length - CHORD_FRAME_SIZE) continue; // too old: its samples are gone
      if (this.#o.listenFor !== 'chords') {
        const note = this.#noteAfter(start);
        out.push(note !== null ? { kind: 'note', time: onset.time, ...note } : { kind: 'unclear', time: onset.time, strength: onset.strength });
      }
      if (this.#o.listenFor !== 'notes') {
        const reading = this.#chords.read(this.#window(start + Math.round(0.02 * sr), CHORD_FRAME_SIZE), sr);
        if (reading !== null) out.push({ kind: 'chord', time: onset.time, reading });
      }
    }
    return out;
  }

  /** The pitch that settles from 30 ms to 120 ms after an onset: the median of the confident YIN readings there. */
  #noteAfter(start: number): { key: number; cents: number; confidence: number } | null {
    const sr = this.#o.sampleRate;
    const readings: { midi: number; confidence: number }[] = [];
    for (let centre = start + Math.round(0.03 * sr); centre <= start + Math.round(0.12 * sr); centre += Math.round(0.015 * sr)) {
      const d = this.#yin.detect(this.#window(centre - PITCH_FRAME / 2, PITCH_FRAME), sr);
      if (d !== null && d.confidence >= this.#o.minConfidence) readings.push({ midi: 69 + 12 * Math.log2(d.frequencyHz / this.#o.referenceHz), confidence: d.confidence });
    }
    if (readings.length === 0) return null;
    const sorted = readings.map((r) => r.midi).sort((a, b) => a - b);
    const m = sorted[Math.floor(sorted.length / 2)] as number;
    const key = Math.round(m);
    const confidences = readings.map((r) => r.confidence).sort((a, b) => a - b);
    return { key, cents: Math.round((m - key) * 1000) / 10, confidence: confidences[Math.floor(confidences.length / 2)] as number };
  }
}
