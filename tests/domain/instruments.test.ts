/**
 * The instrument catalog is data: every tuning is valid, its frequencies are those of equal temperament at A4 = 440 Hz for the notes it names, and the guitar's
 * are the published ones. Nothing about an instrument is a conditional in code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { midiToFrequency, noteOf } from '../../src/domain/pitch.ts';
import { validateTuning } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';

test('the catalog: ids are unique, every tuning is valid, and it is frozen data', () => {
  const ids = CATALOG.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const tuning of CATALOG) assert.deepEqual(validateTuning(tuning), [], tuning.id);
  assert.ok(Object.isFrozen(CATALOG) && CATALOG.every((t) => Object.isFrozen(t) && (t.strings === undefined || Object.isFrozen(t.strings))));
});

test('standard guitar: E2 A2 D3 G3 B3 E4, low to high, at the published frequencies', () => {
  const guitar = CATALOG.find((t) => t.id === 'guitar-standard');
  assert.ok(guitar?.strings);
  assert.equal(guitar.name, 'Standard Guitar');
  assert.deepEqual(guitar.strings.map((s) => [s.label, s.midi, s.frequencyHz]), [
    ['E2', 40, 82.41],
    ['A2', 45, 110],
    ['D3', 50, 146.83],
    ['G3', 55, 196],
    ['B3', 59, 246.94],
    ['E4', 64, 329.63],
  ]);
});

test('every string of every tuning names its note, and its frequency is that note in equal temperament to within 0.005 Hz', () => {
  for (const tuning of CATALOG) {
    for (const s of tuning.strings ?? []) {
      assert.equal(s.label, noteOf(s.midi).label, `${tuning.id}: ${s.label}`);
      assert.ok(Math.abs(s.frequencyHz - midiToFrequency(s.midi)) <= 0.005, `${tuning.id}: ${s.label} ${s.frequencyHz}`);
    }
  }
});

test('the catalog is not only a guitar: bass, violin, ukulele, and a chromatic tuning with no strings for voice, flute and any pitched instrument', () => {
  const byId = new Map(CATALOG.map((t) => [t.id, t]));
  assert.deepEqual(byId.get('bass-standard')?.strings?.map((s) => s.label), ['E1', 'A1', 'D2', 'G2']);
  assert.deepEqual(byId.get('violin')?.strings?.map((s) => s.label), ['G3', 'D4', 'A4', 'E5']);
  assert.deepEqual(byId.get('ukulele-standard')?.strings?.map((s) => s.label), ['G4', 'C4', 'E4', 'A4']);
  assert.equal(byId.get('chromatic')?.strings, undefined);
});
