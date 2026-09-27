/**
 * The pitch detector (src/audio/pitch-detector.ts): pure — samples and a sample rate in, a frequency and a confidence out, or null — tested on signals
 * generated here from their mathematics. The expected frequency is the one the signal was generated with, never one the implementation computed.
 *
 * The accuracy target: within ±1 cent of the true frequency on a clean tone — a fifth of the domain's ±5-cent in-tune window, so that flat, in tune and sharp
 * are told apart by the detector's error, never decided by it. The domain's window is not loosened for the detector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DETECTOR_FRAME_SIZE, DEFAULT_DETECTOR_OPTIONS, createYinDetector } from '../../src/audio/pitch-detector.ts';

const RATES = [44100, 48000] as const;
const cents = (detected: number, truth: number): number => 1200 * Math.log2(detected / truth);

/** A sum of sinusoids: [frequency, amplitude, phase] each, sampled at `rate`. */
function tone(rate: number, partials: readonly (readonly [number, number, number?])[], n = DETECTOR_FRAME_SIZE): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const [f, a, phase = 0] of partials) v += a * Math.sin(2 * Math.PI * f * (i / rate) + phase);
    out[i] = v;
  }
  return out;
}
const sine = (rate: number, f: number, amplitude = 0.5, phase = 0.3): Float32Array => tone(rate, [[f, amplitude, phase]]);

// the open strings of a standard guitar, and A4, in equal temperament at A4 = 440 Hz: 440 · 2^((m − 69)/12)
const et = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const TARGETS: readonly [string, number][] = [
  ['E2', et(40)],
  ['A2', et(45)],
  ['D3', et(50)],
  ['G3', et(55)],
  ['B3', et(59)],
  ['E4', et(64)],
  ['A4', et(69)],
];

test('the targets are the published frequencies: E2 82.4069, A2 110, D3 146.8324, G3 195.9977, B3 246.9417, E4 329.6276, A4 440 Hz', () => {
  assert.deepEqual(TARGETS.map(([, f]) => Number(f.toFixed(4))), [82.4069, 110, 146.8324, 195.9977, 246.9417, 329.6276, 440]);
});

test('the contract: a pure detector of a frame at a sample rate — the frame size is enough for the lowest frequency it looks for, at both rates', () => {
  const detector = createYinDetector();
  assert.equal(typeof detector.detect, 'function');
  assert.equal(DETECTOR_FRAME_SIZE, 4096);
  assert.deepEqual(DEFAULT_DETECTOR_OPTIONS, { minFrequencyHz: 40, maxFrequencyHz: 2000, threshold: 0.1, silenceRms: 0.004 });
  // YIN compares a window of half the frame with itself shifted by up to one period: the longest period, sampleRate / 40 Hz, fits in half a frame
  for (const rate of RATES) assert.ok(rate / DEFAULT_DETECTOR_OPTIONS.minFrequencyHz < DETECTOR_FRAME_SIZE / 2, String(rate));
  // the same input, the same answer: no state is kept between frames
  const frame = sine(48000, 110);
  assert.deepEqual(detector.detect(frame, 48000), detector.detect(frame, 48000));
});

for (const rate of RATES) {
  test(`a pure tone at ${rate} Hz sampling: each open string of the guitar, and A4, within ±1 cent, with a high confidence`, () => {
    const detector = createYinDetector();
    for (const [name, f] of TARGETS) {
      const found = detector.detect(sine(rate, f), rate);
      assert.ok(found, `${name}: nothing detected`);
      assert.ok(Math.abs(cents(found.frequencyHz, f)) <= 1, `${name} ${f.toFixed(4)} Hz: detected ${found.frequencyHz.toFixed(4)} Hz, ${cents(found.frequencyHz, f).toFixed(3)} cents`);
      assert.ok(found.confidence >= 0.9, `${name}: confidence ${found.confidence}`);
    }
  });
}

test('beyond the guitar: the bass’s E1 (41.2 Hz) and the violin’s E5 (659.3 Hz) and A5 (880 Hz), at both rates, within ±1 cent', () => {
  const detector = createYinDetector();
  for (const rate of RATES) {
    for (const f of [et(28), et(76), et(81)]) {
      const found = detector.detect(sine(rate, f), rate);
      assert.ok(found && Math.abs(cents(found.frequencyHz, f)) <= 1, `${f.toFixed(3)} Hz at ${rate}: ${found?.frequencyHz}`);
    }
  }
});

test('slightly flat and slightly sharp: A2 3 cents flat reads below 110 Hz, 3 cents sharp above — each within ±1 cent of the truth', () => {
  const detector = createYinDetector();
  for (const rate of RATES) {
    for (const offset of [-3, 3, -6, 6]) {
      const f = 110 * 2 ** (offset / 1200);
      const found = detector.detect(sine(rate, f), rate);
      assert.ok(found);
      assert.ok(offset < 0 ? found.frequencyHz < 110 : found.frequencyHz > 110, `${offset} cents at ${rate}: ${found.frequencyHz}`);
      assert.ok(Math.abs(cents(found.frequencyHz, f)) <= 1, `${offset} cents at ${rate}: ${cents(found.frequencyHz, f)}`);
    }
  }
});

test('the phase of the tone and its level (above silence) do not move the answer', () => {
  const detector = createYinDetector();
  for (const phase of [0, 1, 2, 3, 4, 5]) {
    for (const amplitude of [0.02, 0.2, 0.9]) {
      const found = detector.detect(sine(48000, 110, amplitude, phase), 48000);
      assert.ok(found && Math.abs(cents(found.frequencyHz, 110)) <= 1, `phase ${phase}, amplitude ${amplitude}: ${found?.frequencyHz}`);
    }
  }
});
