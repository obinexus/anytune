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
/** The start of the tone in its cycle: an error that depends on it would show in one of these. */
const PHASES = [0.3, 1.1, 2.3, 3.7, 4.9, 5.9] as const;
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
    for (const [name, f] of TARGETS) for (const phase of PHASES) {
      const found = detector.detect(sine(rate, f, 0.5, phase), rate);
      assert.ok(found, `${name}: nothing detected`);
      assert.ok(Math.abs(cents(found.frequencyHz, f)) <= 1, `${name} ${f.toFixed(4)} Hz: detected ${found.frequencyHz.toFixed(4)} Hz, ${cents(found.frequencyHz, f).toFixed(3)} cents`);
      assert.ok(found.confidence >= 0.9, `${name}: confidence ${found.confidence}`);
    }
  });
}

test('beyond the guitar: the bass’s E1 (41.2 Hz) and the violin’s E5 (659.3 Hz) and A5 (880 Hz), at both rates, within ±1 cent', () => {
  const detector = createYinDetector();
  for (const rate of RATES) {
    for (const f of [et(28), et(76), et(81)]) for (const phase of PHASES) {
      const found = detector.detect(sine(rate, f, 0.5, phase), rate);
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

// ── M2: silence, noise, harmonics and confidence ───────────────────────────────────────────────────────────────────────────────────────

/** Seeded white noise, uniform in −amplitude…amplitude (mulberry32): the same frames every run. */
function noise(amplitude: number, seed: number, n = DETECTOR_FRAME_SIZE): Float32Array {
  let a = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = amplitude * ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1);
  }
  return out;
}
const plus = (a: Float32Array, b: Float32Array): Float32Array => a.map((v, i) => v + (b[i] as number));
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test('silence is no pitch: zeros, a constant offset (a microphone’s DC), and a tone far below the silence threshold', () => {
  const detector = createYinDetector();
  for (const rate of RATES) {
    assert.equal(detector.detect(new Float32Array(DETECTOR_FRAME_SIZE), rate), null);
    assert.equal(detector.detect(new Float32Array(DETECTOR_FRAME_SIZE).fill(0.3), rate), null);
    const faint = sine(rate, 110, 0.002);
    assert.ok(rms(faint) < DEFAULT_DETECTOR_OPTIONS.silenceRms);
    assert.equal(detector.detect(faint, rate), null);
  }
});

test('white noise is never a confident pitch: across 40 frames of noise, no confidence reaches the domain’s 0.6', () => {
  const detector = createYinDetector();
  let highest = 0;
  for (let seed = 1; seed <= 20; seed++) {
    for (const rate of RATES) {
      const found = detector.detect(noise(0.3, seed), rate);
      if (found !== null) highest = Math.max(highest, found.confidence);
    }
  }
  assert.ok(highest < 0.6, `the most confident noise frame: ${highest}`);
});

test('a tone in noise at 20 dB SNR is still tuned: within ±2 cents, and confident enough for the domain (≥ 0.6) — and less confident than the clean tone', () => {
  const detector = createYinDetector();
  for (const rate of RATES) {
    for (const [name, f] of TARGETS) {
      const clean = sine(rate, f, 0.5);
      const noisy = plus(clean, noise(0.5 / Math.sqrt(2) / 10 * Math.sqrt(3), 7));
      assert.ok(Math.abs(20 * Math.log10(rms(clean) / rms(noise(0.5 / Math.sqrt(2) / 10 * Math.sqrt(3), 7))) - 20) < 0.5, 'the SNR is 20 dB');
      const found = detector.detect(noisy, rate);
      assert.ok(found, `${name} at ${rate}`);
      assert.ok(Math.abs(cents(found.frequencyHz, f)) <= 2, `${name} at ${rate}: ${cents(found.frequencyHz, f).toFixed(3)} cents`);
      assert.ok(found.confidence >= 0.6, `${name} at ${rate}: confidence ${found.confidence}`);
      assert.ok(found.confidence < (detector.detect(clean, rate)?.confidence ?? 0), `${name} at ${rate}: noise lowers the confidence`);
    }
  }
});

test('a harmonic-rich tone gives its fundamental within ±2 cents, whatever the phases of its partials — a plucked string (partials at 1/k), one whose second harmonic is louder than its fundamental, and one with no fundamental at all', () => {
  const detector = createYinDetector();
  const partials = (f: number, amplitudes: readonly number[], seed: number) => amplitudes.map((a, k) => [f * (k + 1), a, seed * (k + 1)] as const);
  for (const rate of RATES) {
    for (const [name, f] of TARGETS) {
      for (const [what, amplitudes] of [
        ['plucked', [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8]],
        ['weak fundamental', [0.3, 1, 0.8, 0.5, 0.3]],
        ['no fundamental', [0, 1, 0.8, 0.6, 0.4, 0.2]],
      ] as const) {
        for (let seed = 1; seed <= 8; seed++) {
          const signal = tone(rate, partials(f, amplitudes, seed).filter(([freq]) => freq < rate / 2).map(([freq, a, p]) => [freq, a * 0.2, p]));
          const found = detector.detect(signal, rate);
          assert.ok(found, `${name} ${what} at ${rate}`);
          assert.ok(Math.abs(cents(found.frequencyHz, f)) <= 2, `${name} ${what} at ${rate}, seed ${seed}: ${found.frequencyHz.toFixed(3)} Hz for ${f.toFixed(3)}`);
        }
      }
    }
  }
});

test('a decaying pluck — the level falling by a third within the frame — is still within ±1 cent', () => {
  const detector = createYinDetector();
  for (const rate of RATES) {
    for (const [name, f] of TARGETS) {
      const x = sine(rate, f, 0.6);
      const decay = x.map((v, i) => v * Math.exp(-i / rate / 0.2));
      const found = detector.detect(decay, rate);
      assert.ok(found && Math.abs(cents(found.frequencyHz, f)) <= 1, `${name} at ${rate}: ${found?.frequencyHz}`);
    }
  }
});

test('outside the range looked for is no pitch: 30 Hz is below it, and a frame too short for the lowest period finds nothing below what it can hold', () => {
  const detector = createYinDetector();
  assert.equal(detector.detect(sine(48000, 30), 48000), null);
  const short = sine(48000, 110).subarray(0, 512);
  assert.equal(detector.detect(short, 48000), null, 'a 512-sample frame holds a 110 Hz period (436 samples) in half of it only if it is 872 long');
  assert.equal(detector.detect(sine(48000, 110), 0), null, 'no sample rate, no frequency');
});

test('noise never names the wrong note with confidence: sines, plucks and weak-fundamental tones of the guitar at 10 and 20 dB SNR — and at 3 and 6 dB, at most 1 in 100', () => {
  const detector = createYinDetector();
  const shapes: readonly (readonly number[])[] = [[1], [1, 0.5, 0.33, 0.25, 0.2], [0.3, 1, 0.8, 0.5]];
  for (const snr of [3, 6, 10, 20]) {
    let wrong = 0;
    let total = 0;
    for (const rate of RATES) {
      for (const [, f] of TARGETS) {
        for (const shape of shapes) {
          for (let seed = 1; seed <= 6; seed++) {
            const clean = tone(rate, shape.map((a, k) => [f * (k + 1), 0.2 * a, seed * (k + 1)] as const));
            const noisy = plus(clean, noise((rms(clean) / 10 ** (snr / 20)) * Math.sqrt(3), seed * 31 + Math.round(f)));
            const found = detector.detect(noisy, rate);
            total++;
            if (found !== null && found.confidence >= 0.6 && Math.abs(cents(found.frequencyHz, f)) > 50) wrong++;
          }
        }
      }
    }
    if (snr >= 10) assert.equal(wrong, 0, `${snr} dB: ${wrong} of ${total} confidently wrong`);
    else assert.ok(wrong <= total / 100, `${snr} dB: ${wrong} of ${total} confidently wrong`);
  }
});
