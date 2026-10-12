/**
 * Notes from a monophonic line — a guitarist's single notes: each onset, and the pitch that settles after it (the median of the YIN detections from 30 ms to
 * 120 ms after the onset, past the pluck's noisy attack), as a note with its cents and confidence. A pitch change without an onset (a hammer-on, a slide)
 * becomes a note too, once the new pitch has held for 60 ms. What this cannot do: tell which string or fret made the pitch, or hear chords — chords are
 * src/analysis/chords.ts's.
 */
import { createYinDetector, DETECTOR_FRAME_SIZE, type PitchDetector } from '../audio/pitch-detector.ts';
import { detectOnsets, type Onset } from './onsets.ts';

export interface TrackedNote {
  /** seconds on the samples' clock */
  readonly time: number;
  readonly key: number;
  readonly cents: number;
  readonly confidence: number;
  /** what found it: an onset, or a change of pitch with no onset */
  readonly by: 'onset' | 'pitch-change';
}

const frequencyToMidi = (hz: number, referenceHz: number): number => 69 + 12 * Math.log2(hz / referenceHz);
const median = (values: readonly number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? (s[(s.length - 1) / 2] as number) : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
};

export interface NoteTrackerOptions {
  readonly referenceHz: number;
  /** seconds between pitch frames */
  readonly hopSeconds: number;
  readonly minConfidence: number;
}

/** The notes of a whole monophonic signal (the batch form of what the live path does frame by frame). */
export function trackNotes(samples: Float32Array, sampleRate: number, options: Partial<NoteTrackerOptions> = {}, detector: PitchDetector = createYinDetector()): TrackedNote[] {
  const o: NoteTrackerOptions = { referenceHz: 440, hopSeconds: 0.01, minConfidence: 0.6, ...options };
  const frame = Math.min(DETECTOR_FRAME_SIZE, 2 ** Math.floor(Math.log2(sampleRate * 0.085)));
  const hop = Math.round(o.hopSeconds * sampleRate);
  const pitches: { time: number; midi: number; confidence: number }[] = [];
  for (let start = 0; start + frame <= samples.length; start += hop) {
    const d = detector.detect(samples.subarray(start, start + frame), sampleRate);
    // a detection describes the frame; its time is the frame's start, where a new pitch begins to be heard
    if (d !== null) pitches.push({ time: start / sampleRate, midi: frequencyToMidi(d.frequencyHz, o.referenceHz), confidence: d.confidence });
  }
  const onsets: Onset[] = detectOnsets(samples, sampleRate);
  const notes: TrackedNote[] = [];
  const settle = (from: number, to: number): { key: number; cents: number; confidence: number } | null => {
    const within = pitches.filter((p) => p.time + frame / sampleRate / 2 >= from && p.time + frame / sampleRate / 2 <= to && p.confidence >= o.minConfidence);
    if (within.length === 0) return null;
    const m = median(within.map((p) => p.midi));
    const key = Math.round(m);
    return { key, cents: Math.round((m - key) * 1000) / 10, confidence: median(within.map((p) => p.confidence)) };
  };
  for (const onset of onsets) {
    const settled = settle(onset.time + 0.03, onset.time + 0.12);
    if (settled !== null) notes.push({ time: onset.time, ...settled, by: 'onset' });
  }
  // a pitch that changes and holds with no onset: a new note
  let current: number | null = null;
  let since = 0;
  for (const p of pitches.filter((x) => x.confidence >= o.minConfidence)) {
    const key = Math.round(p.midi);
    const centre = p.time + frame / sampleRate / 2;
    const noted = notes.some((n) => Math.abs(n.time - centre) < 0.15 && n.key === key);
    if (key !== current) {
      current = key;
      since = centre;
    } else if (centre - since >= 0.06 && !noted && !notes.some((n) => n.key === key && n.time >= since - 0.15 && n.time <= centre)) {
      const settled = settle(since, centre);
      if (settled !== null && settled.key === key) notes.push({ time: since, ...settled, by: 'pitch-change' });
    }
  }
  return notes.sort((a, b) => a.time - b.time);
}
