/**
 * The generic pitch model: equal temperament around A4 = 440 Hz, notes in scientific pitch notation (MIDI 60 = C4), and the cents between two frequencies.
 * Expected values are published constants (12-TET tables) or exact identities — never numbers read back from the implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { centsBetween, frequencyToMidi, midiToFrequency, nearestNote, noteOf } from '../../src/domain/pitch.ts';

const close = (actual: number, expected: number, tolerance: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test('cents: the same frequency is 0 cents, one octave up is +1200, one octave down is -1200', () => {
  assert.equal(centsBetween(440, 440), 0);
  assert.equal(centsBetween(880, 440), 1200);
  assert.equal(centsBetween(220, 440), -1200);
  assert.equal(centsBetween(110, 110), 0);
});

test('cents: a semitone of equal temperament is 100 cents, and cents add along a chain of frequencies', () => {
  close(centsBetween(440 * 2 ** (1 / 12), 440), 100, 1e-9, 'one semitone');
  close(centsBetween(300, 200) + centsBetween(200, 150), centsBetween(300, 150), 1e-9, 'additivity');
  close(centsBetween(150, 300), -centsBetween(300, 150), 1e-12, 'antisymmetry');
});

test('cents: a frequency that is not a positive finite number is refused (a programming error; the reading turns no-signal into data first)', () => {
  for (const bad of [0, -110, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => centsBetween(bad, 440), RangeError, String(bad));
    assert.throws(() => centsBetween(440, bad), RangeError, String(bad));
  }
});

test('equal temperament: MIDI 69 is A4 = 440 Hz, and the published frequencies of the guitar strings', () => {
  assert.equal(midiToFrequency(69), 440);
  assert.equal(midiToFrequency(57), 220);
  // published 12-TET values, A4 = 440 Hz, to two decimals
  for (const [midi, hz] of [[40, 82.41], [45, 110.0], [50, 146.83], [55, 196.0], [59, 246.94], [64, 329.63], [60, 261.63]] as const) {
    close(midiToFrequency(midi), hz, 0.005, `MIDI ${midi}`);
  }
  close(frequencyToMidi(440), 69, 1e-12, 'A4');
  close(frequencyToMidi(261.6256), 60, 1e-4, 'C4');
  close(frequencyToMidi(466.1638), 70, 1e-4, 'A#4');
});

test('equal temperament around another reference: A4 = 442 Hz moves every note by the same ratio', () => {
  assert.equal(midiToFrequency(69, 442), 442);
  close(midiToFrequency(45, 442), 110.5, 1e-9, 'A2 at 442');
  close(frequencyToMidi(442, 442), 69, 1e-12, 'A4 at 442');
});

test('note names: sharps, and the octave of scientific pitch notation (C4 = MIDI 60, B3 = 59, octave changes at C)', () => {
  assert.deepEqual(noteOf(69), { midi: 69, name: 'A', octave: 4, label: 'A4' });
  assert.deepEqual(noteOf(60), { midi: 60, name: 'C', octave: 4, label: 'C4' });
  assert.deepEqual(noteOf(59), { midi: 59, name: 'B', octave: 3, label: 'B3' });
  assert.deepEqual(noteOf(61), { midi: 61, name: 'C#', octave: 4, label: 'C#4' });
  assert.deepEqual(noteOf(40), { midi: 40, name: 'E', octave: 2, label: 'E2' });
  assert.deepEqual(noteOf(21), { midi: 21, name: 'A', octave: 0, label: 'A0' });
  assert.deepEqual(noteOf(12), { midi: 12, name: 'C', octave: 0, label: 'C0' });
  assert.deepEqual(noteOf(11), { midi: 11, name: 'B', octave: -1, label: 'B-1' });
});

test('the nearest note of a frequency: 440 Hz is A4 at 0 cents — through the generic pitch model, whatever the instrument', () => {
  const a4 = nearestNote(440);
  assert.deepEqual([a4.label, a4.midi, a4.cents], ['A4', 69, 0]);
  const flatA = nearestNote(436);
  assert.equal(flatA.label, 'A4');
  close(flatA.cents, 1200 * Math.log2(436 / 440), 1e-9, '436 Hz');
  assert.ok(flatA.cents < 0);
  // past the quarter-tone the nearer note wins: 453 Hz is 50.4 cents above A4 (49.6 below A#4), 452 Hz is 46.6 above A4
  assert.equal(nearestNote(453).label, 'A#4');
  assert.equal(nearestNote(452).label, 'A4');
  close(nearestNote(82.41).cents, 0, 0.1, 'E2');
});
