/**
 * The tuning domain: what a pitch means for the instrument being tuned. An instrument's tuning is data (its strings, or none for a chromatic instrument); a
 * policy says how close is in tune and how sure a reading must be; `readPitch` turns one pitch into a reading — the target, the note, the cents, and flat / in
 * tune / sharp / uncertain — or into nothing when there is no signal. Pure: it knows no browser, no Vue, no Polycall and no microphone.
 */
import { centsBetween, midiToFrequency, nearestNote, noteOf } from './pitch.ts';

export interface TargetPitch {
  /** the note of the string, as scientific pitch notation: `A2` */
  readonly label: string;
  readonly midi: number;
  /** the frequency of the note at A4 = 440 Hz, as published — documentation of the data; the domain tunes to `midi` at the policy's reference */
  readonly frequencyHz: number;
}

export interface InstrumentTuning {
  readonly id: string;
  readonly name: string;
  /** the open strings, low to high; none for an instrument tuned note by note (voice, flute) */
  readonly strings?: readonly TargetPitch[];
}

export type TuningStatus = 'flat' | 'in-tune' | 'sharp' | 'uncertain';

export interface TuningReading {
  readonly detectedFrequencyHz: number;
  readonly targetFrequencyHz: number;
  readonly targetMidi: number;
  readonly targetLabel: string;
  readonly note: string;
  readonly octave: number;
  readonly cents: number;
  readonly confidence: number;
  readonly status: TuningStatus;
}

export interface TuningPolicy {
  /** the frequency of A4 */
  readonly referenceHz: number;
  /** in tune when |cents| ≤ this */
  readonly inTuneCents: number;
  /** a reading less sure than this is uncertain */
  readonly minConfidence: number;
  /** a string captures a pitch within this many cents of it; further from every string, the reading is uncertain */
  readonly captureCents: number;
  /** stable when this many readings in a row agree… */
  readonly stableCount: number;
  /** …on the target and the status, and lie within this many cents of each other */
  readonly stableSpreadCents: number;
}

export const DEFAULT_POLICY: TuningPolicy = Object.freeze({
  referenceHz: 440,
  inTuneCents: 5,
  minConfidence: 0.6,
  captureCents: 600,
  stableCount: 2,
  stableSpreadCents: 3,
});

/** What a pitch observation brings to the domain: a frequency, and how sure its source is of it. */
export interface PitchSample {
  readonly frequencyHz: number;
  readonly confidence: number;
}

export function classify(cents: number, confidence: number, policy: TuningPolicy): TuningStatus {
  if (!(confidence >= policy.minConfidence)) return 'uncertain';
  if (Math.abs(cents) <= policy.inTuneCents) return 'in-tune';
  return cents < 0 ? 'flat' : 'sharp';
}

const clampConfidence = (confidence: number): number => (Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0);

/** The reading of one pitch for a tuning, or `null` when there is no signal (a frequency that is not a positive finite number). */
export function readPitch(sample: PitchSample, tuning: InstrumentTuning, policy: TuningPolicy): TuningReading | null {
  const detected = sample.frequencyHz;
  if (!Number.isFinite(detected) || detected <= 0) return null;
  const confidence = clampConfidence(sample.confidence);

  let targetMidi: number;
  let targetLabel: string;
  let captured = true;
  if (tuning.strings === undefined) {
    const note = nearestNote(detected, policy.referenceHz);
    targetMidi = note.midi;
    targetLabel = note.label;
  } else {
    let best: TargetPitch | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const string of tuning.strings) {
      const distance = Math.abs(centsBetween(detected, midiToFrequency(string.midi, policy.referenceHz)));
      if (distance < bestDistance) {
        best = string;
        bestDistance = distance;
      }
    }
    if (best === undefined) return null;
    targetMidi = best.midi;
    targetLabel = best.label;
    captured = bestDistance <= policy.captureCents;
  }
  const targetFrequencyHz = midiToFrequency(targetMidi, policy.referenceHz);
  const cents = centsBetween(detected, targetFrequencyHz);
  const note = noteOf(targetMidi);
  return {
    detectedFrequencyHz: detected,
    targetFrequencyHz,
    targetMidi,
    targetLabel,
    note: note.name,
    octave: note.octave,
    cents,
    confidence,
    status: captured ? classify(cents, confidence, policy) : 'uncertain',
  };
}

/** Whether the last readings agree: `stableCount` of them, one target, one status that is not uncertain, within `stableSpreadCents`. */
export function isStable(recent: readonly TuningReading[], policy: TuningPolicy): boolean {
  if (recent.length < policy.stableCount) return false;
  const last = recent.slice(-policy.stableCount);
  const first = last[0] as TuningReading;
  if (first.status === 'uncertain') return false;
  if (!last.every((r) => r.targetMidi === first.targetMidi && r.status === first.status)) return false;
  const cents = last.map((r) => r.cents);
  return Math.max(...cents) - Math.min(...cents) <= policy.stableSpreadCents;
}

export function findTuning(catalog: readonly InstrumentTuning[], id: string): InstrumentTuning | undefined {
  return catalog.find((tuning) => tuning.id === id);
}

/** What is wrong with a tuning, issue by issue — empty when it is valid. */
export function validateTuning(tuning: InstrumentTuning): string[] {
  const issues: string[] = [];
  if (tuning.id.trim() === '') issues.push('empty-id');
  if (tuning.name.trim() === '') issues.push('empty-name');
  if (tuning.strings !== undefined) {
    if (tuning.strings.length === 0) issues.push('no-strings');
    const seen = new Set<string>();
    for (const string of tuning.strings) {
      if (seen.has(string.label)) issues.push(`duplicate-label:${string.label}`);
      seen.add(string.label);
      if (!Number.isInteger(string.midi)) issues.push(`midi-not-integer:${string.label}`);
      if (!Number.isFinite(string.frequencyHz) || string.frequencyHz <= 0) issues.push(`frequency-not-positive:${string.label}`);
    }
  }
  return issues;
}
