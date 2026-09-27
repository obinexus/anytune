/**
 * The instruments AnyTune knows, as data. A string's frequency is its note in equal temperament at A4 = 440 Hz, as published (two decimals); the domain tunes
 * to the note (`midi`) at the reference the policy gives. An instrument with no `strings` is tuned note by note, to the chromatic scale.
 */
import type { InstrumentTuning, TargetPitch } from '../domain/tuning.ts';

const string = (label: string, midi: number, frequencyHz: number): TargetPitch => Object.freeze({ label, midi, frequencyHz });
const tuning = (id: string, name: string, strings?: readonly TargetPitch[]): InstrumentTuning =>
  Object.freeze(strings === undefined ? { id, name } : { id, name, strings: Object.freeze([...strings]) });

export const CATALOG: readonly InstrumentTuning[] = Object.freeze([
  tuning('guitar-standard', 'Standard Guitar', [string('E2', 40, 82.41), string('A2', 45, 110), string('D3', 50, 146.83), string('G3', 55, 196), string('B3', 59, 246.94), string('E4', 64, 329.63)]),
  tuning('bass-standard', 'Standard Bass', [string('E1', 28, 41.2), string('A1', 33, 55), string('D2', 38, 73.42), string('G2', 43, 98)]),
  tuning('violin', 'Violin', [string('G3', 55, 196), string('D4', 62, 293.66), string('A4', 69, 440), string('E5', 76, 659.26)]),
  tuning('ukulele-standard', 'Standard Ukulele', [string('G4', 67, 392), string('C4', 60, 261.63), string('E4', 64, 329.63), string('A4', 69, 440)]),
  tuning('chromatic', 'Chromatic (voice, flute, any pitched instrument)'),
]);
