/**
 * The generic pitch model of AnyTune: twelve-tone equal temperament around a reference A4 (440 Hz unless said otherwise), notes in scientific pitch notation
 * (MIDI 60 = C4, the octave number changes at C), and the distance between two frequencies in cents (1200 to the octave, 100 to the semitone).
 */

export const A4_MIDI = 69;
export const A4_HZ = 440;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface Note {
  readonly midi: number;
  readonly name: string;
  readonly octave: number;
  /** name and octave: `A4`, `C#3`, `B-1` */
  readonly label: string;
}

export interface NearestNote extends Note {
  readonly frequencyHz: number;
  /** how far the frequency is from the note: negative is flat */
  readonly cents: number;
}

const positive = (value: number, what: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${what} must be a positive finite number of hertz, not ${value}`);
  return value;
};

/** cents = 1200 · log2(detected / target): 0 when equal, +1200 an octave above, −1200 an octave below. */
export function centsBetween(detectedHz: number, targetHz: number): number {
  return 1200 * Math.log2(positive(detectedHz, 'the detected frequency') / positive(targetHz, 'the target frequency'));
}

/** The frequency of a (possibly fractional) MIDI note in equal temperament. */
export function midiToFrequency(midi: number, referenceHz: number = A4_HZ): number {
  return positive(referenceHz, 'the reference') * 2 ** ((midi - A4_MIDI) / 12);
}

/** The fractional MIDI note of a frequency in equal temperament. */
export function frequencyToMidi(frequencyHz: number, referenceHz: number = A4_HZ): number {
  return A4_MIDI + 12 * Math.log2(positive(frequencyHz, 'the frequency') / positive(referenceHz, 'the reference'));
}

/** The name and octave of an integer MIDI note. */
export function noteOf(midi: number): Note {
  if (!Number.isInteger(midi)) throw new RangeError(`a note is an integer MIDI number, not ${midi}`);
  const name = NAMES[((midi % 12) + 12) % 12] as string;
  const octave = Math.floor(midi / 12) - 1;
  return { midi, name, octave, label: `${name}${octave}` };
}

/** The note of equal temperament nearest to a frequency, and how many cents the frequency is from it. */
export function nearestNote(frequencyHz: number, referenceHz: number = A4_HZ): NearestNote {
  const midi = Math.round(frequencyToMidi(frequencyHz, referenceHz));
  const noteHz = midiToFrequency(midi, referenceHz);
  return { ...noteOf(midi), frequencyHz: noteHz, cents: centsBetween(frequencyHz, noteHz) };
}
