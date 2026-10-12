/**
 * The tuning domain: a pitch observation, an instrument's tuning and a policy make a reading — the target, the note, the cents and flat / in tune / sharp /
 * uncertain — or no reading at all when there is no signal. Pure: no browser, no Vue, no Polycall, no microphone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, classify, findTuning, isStable, readPitch, validateTuning } from '../../src/domain/tuning.ts';
import type { InstrumentTuning, TuningReading } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';

const guitar = findTuning(CATALOG, 'guitar-standard') as InstrumentTuning;
const chromatic = findTuning(CATALOG, 'chromatic') as InstrumentTuning;
const read = (frequencyHz: number, confidence = 0.95, tuning = guitar): TuningReading | null => readPitch({ frequencyHz, confidence }, tuning, DEFAULT_POLICY);
const must = (r: TuningReading | null): TuningReading => {
  assert.ok(r, 'a reading was expected');
  return r;
};
const round = (x: number, digits: number): number => Number(x.toFixed(digits));

test('the policy: in tune within ±5 cents, a reading below 0.6 confidence is uncertain, a string captures within 600 cents', () => {
  assert.deepEqual({ ...DEFAULT_POLICY }, { referenceHz: 440, inTuneCents: 5, minConfidence: 0.6, captureCents: 600, stableCount: 2, stableSpreadCents: 3 });
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
});

test('classification: flat below −5 cents, in tune within ±5 inclusive, sharp above +5, uncertain below the confidence threshold whatever the cents', () => {
  const at = (cents: number, confidence = 1): string => classify(cents, confidence, DEFAULT_POLICY);
  assert.deepEqual([at(-31.8), at(-5.01), at(-5), at(0), at(5), at(5.01), at(31.2)], ['flat', 'flat', 'in-tune', 'in-tune', 'in-tune', 'sharp', 'sharp']);
  assert.deepEqual([at(0, 0.59), at(-40, 0.1), at(0, 0.6)], ['uncertain', 'uncertain', 'in-tune']);
});

test('the acceptance sequence of the directive — Standard Guitar, A2: 108, 109, 110, 110 Hz are flat, flat, in tune, and in tune and stable', () => {
  const readings = [108, 109, 110, 110].map((hz) => must(read(hz)));
  assert.deepEqual(readings.map((r) => [r.targetLabel, r.note, r.octave, r.status]), [
    ['A2', 'A', 2, 'flat'],
    ['A2', 'A', 2, 'flat'],
    ['A2', 'A', 2, 'in-tune'],
    ['A2', 'A', 2, 'in-tune'],
  ]);
  // the cents are those of 1200·log2(f / 110): −31.77, −15.81, 0, 0
  assert.deepEqual(readings.map((r) => round(r.cents, 2)), [-31.77, -15.81, 0, 0]);
  assert.deepEqual(readings.map((r) => r.targetFrequencyHz), [110, 110, 110, 110]);
  // stable once two consecutive readings agree on the target and the status, within 3 cents of each other
  const stability = readings.map((_, i) => isStable(readings.slice(0, i + 1), DEFAULT_POLICY));
  assert.deepEqual(stability, [false, false, false, true]);
});

test('sharp: 111 Hz is 15.67 cents sharp of A2', () => {
  const r = must(read(111));
  assert.deepEqual([r.targetLabel, r.status, round(r.cents, 2)], ['A2', 'sharp', 15.67]);
});

test('the nearest string is the target: each open string of a standard guitar, and a frequency between two strings goes to the nearer in cents', () => {
  for (const [hz, label] of [[82.41, 'E2'], [110, 'A2'], [146.83, 'D3'], [196, 'G3'], [246.94, 'B3'], [329.63, 'E4']] as const) {
    const r = must(read(hz));
    assert.equal(r.targetLabel, label);
    assert.equal(r.status, 'in-tune', label);
  }
  // E2 and A2 are 500 cents apart; the midpoint in cents is 95.209 Hz: just below goes to E2, just above to A2
  assert.equal(must(read(95.1)).targetLabel, 'E2');
  assert.equal(must(read(95.3)).targetLabel, 'A2');
});

test('a string captures only what is near it: a frequency more than 600 cents from every string is a reading, of the nearest string, and uncertain', () => {
  const low = must(read(40)); // about 1250 cents below E2
  assert.deepEqual([low.targetLabel, low.status], ['E2', 'uncertain']);
  assert.ok(low.cents < -600);
  const high = must(read(1000));
  assert.deepEqual([high.targetLabel, high.status], ['E4', 'uncertain']);
});

test('an instrument with no strings tunes to the nearest note of the chromatic scale — 440 Hz is A4, 0 cents', () => {
  const a4 = must(read(440, 0.9, chromatic));
  assert.deepEqual([a4.targetLabel, a4.note, a4.octave, a4.cents, a4.status, a4.targetFrequencyHz], ['A4', 'A', 4, 0, 'in-tune', 440]);
  const flat = must(read(436, 0.9, chromatic));
  assert.deepEqual([flat.targetLabel, flat.status], ['A4', 'flat']);
});

test('confidence: below the threshold the reading is uncertain, not flat or sharp; a confidence outside 0…1 or not a number counts as none', () => {
  assert.equal(must(read(108, 0.3)).status, 'uncertain');
  assert.equal(must(read(108, 0.3)).confidence, 0.3);
  assert.equal(must(read(110, Number.NaN)).status, 'uncertain');
  assert.equal(must(read(110, Number.NaN)).confidence, 0);
  assert.equal(must(read(110, 7)).confidence, 1);
  assert.equal(must(read(110, -1)).confidence, 0);
});

test('no signal: a frequency that is not a positive finite number makes no reading', () => {
  for (const bad of [0, -110, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(read(bad), null, String(bad));
});

test('an unstable signal is not stable: another target, another status, or readings further apart than 3 cents', () => {
  const r = (hz: number, confidence = 0.95): TuningReading => must(read(hz, confidence));
  assert.equal(isStable([r(110)], DEFAULT_POLICY), false, 'one reading is not yet stable');
  assert.equal(isStable([r(110), r(82.41)], DEFAULT_POLICY), false, 'two strings');
  assert.equal(isStable([r(110), r(111)], DEFAULT_POLICY), false, 'in tune then sharp');
  assert.equal(isStable([r(107.5), r(108.5)], DEFAULT_POLICY), false, 'flat twice, 16 cents apart');
  assert.equal(isStable([r(108), r(108.1)], DEFAULT_POLICY), true, 'flat twice, 1.6 cents apart: stable flat');
  assert.equal(isStable([r(110, 0.2), r(110, 0.2)], DEFAULT_POLICY), false, 'uncertain is never stable');
  assert.equal(isStable([r(82.41), r(110), r(110.1)], DEFAULT_POLICY), true, 'only the last readings count');
});

test('instrument lookup: a tuning by its id, and an unknown id is undefined — a state for the app to show, never an exception', () => {
  assert.equal(findTuning(CATALOG, 'guitar-standard')?.name, 'Standard Guitar');
  assert.equal(findTuning(CATALOG, 'banjo-17-string'), undefined);
  assert.equal(findTuning(CATALOG, ''), undefined);
});

test('an invalid tuning is described, issue by issue, as data', () => {
  assert.deepEqual(validateTuning(guitar), []);
  const bad: InstrumentTuning = {
    id: '',
    name: ' ',
    strings: [
      { label: 'A2', midi: 45, frequencyHz: 110 },
      { label: 'A2', midi: 45.5, frequencyHz: -1 },
      { label: 'X', midi: 50, frequencyHz: Number.NaN },
    ],
  };
  assert.deepEqual(validateTuning(bad), ['empty-id', 'empty-name', 'duplicate-label:A2', 'midi-not-integer:A2', 'frequency-not-positive:A2', 'frequency-not-positive:X']);
  assert.deepEqual(validateTuning({ id: 'x', name: 'X', strings: [] }), ['no-strings']);
  // a tuning with no string to tune to makes no reading — the application refuses such a tuning before it listens
  assert.equal(readPitch({ frequencyHz: 110, confidence: 1 }, { id: 'x', name: 'X', strings: [] }, DEFAULT_POLICY), null);
});
