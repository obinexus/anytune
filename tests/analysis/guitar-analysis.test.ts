/**
 * The guitar analysis (src/analysis/) on SYNTHETIC plucked strings (src/synthesis/pluck.ts) — a quick, deterministic subset of what
 * tools/analysis/evaluate-guitar.ts measures in full (docs/evaluation/guitar-synthetic.md). These are not recordings of a guitar: they hold the analysis to what
 * it does on idealised strings, and they guard its refusals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHORD_FRAME_SIZE, createChordAnalyser } from '../../src/analysis/chords.ts';
import { trackNotes } from '../../src/analysis/notes.ts';
import { detectOnsets, groupStrums } from '../../src/analysis/onsets.ts';
import { magnitudeSpectrum } from '../../src/analysis/spectrum.ts';
import { createYinDetector } from '../../src/audio/pitch-detector.ts';
import { MVP_CHORDS } from '../../src/music/chords.ts';
import { OPEN_VOICINGS, soundingKeys } from '../../src/music/guitar.ts';
import { pluck, renderNotes } from '../../src/synthesis/pluck.ts';
import { REFUSALS, readStrum, strum, verdictOf } from '../../tools/analysis/evaluate-guitar.ts';

const SR = 48000;

test('the FFT: a 1 kHz sine at 48 kHz in an 8192-sample frame peaks at bin 1000·8192/48000 ≈ 170.7, the neighbours of the true frequency', () => {
  const frame = Float32Array.from({ length: 8192 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
  const mag = magnitudeSpectrum(frame);
  let peak = 0;
  for (let k = 1; k < mag.length; k++) if ((mag[k] as number) > (mag[peak] as number)) peak = k;
  assert.ok(peak === 170 || peak === 171, `peak at ${peak}`);
});

test('the synthetic string is tuned: YIN reads each open string of standard tuning within 2 cents of its note', () => {
  const yin = createYinDetector();
  for (const key of [40, 45, 50, 55, 59, 64]) {
    const hz = 440 * 2 ** ((key - 69) / 12);
    const d = yin.detect(pluck(hz, { sampleRate: SR }).subarray(4800, 4800 + 4096), SR);
    assert.ok(d !== null && Math.abs(1200 * Math.log2(d.frequencyHz / hz)) < 2, `key ${key}`);
  }
});

test('every chord of the vocabulary, strummed (synthetic, 20 dB SNR), is read as itself or said to be uncertain — and most strums are read', () => {
  const analyser = createChordAnalyser();
  let right = 0;
  let total = 0;
  for (const chord of MVP_CHORDS) {
    for (let s = 0; s < 4; s++) {
      const verdict = verdictOf(readStrum(strum(soundingKeys(OPEN_VOICINGS[chord] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 9000 + s * 17 + chord.length, 20), analyser));
      assert.ok(verdict === chord || verdict === 'uncertain', `${chord} read as ${verdict}`);
      total++;
      if (verdict === chord) right++;
    }
  }
  assert.ok(right / total >= 0.85, `${right} of ${total}`);
});

test('what is no chord of the vocabulary is refused: silence, noise, F major, B minor — said to be uncertain, never named as the nearest chord', () => {
  const analyser = createChordAnalyser();
  assert.equal(analyser.read(new Float32Array(CHORD_FRAME_SIZE), SR), null);
  for (const name of ['F major (barre)', 'B minor x24432', 'single note E4']) {
    for (let s = 0; s < 3; s++) assert.equal(verdictOf(readStrum(strum(REFUSALS[name] as number[], 9500 + s, 20), analyser)), 'uncertain', name);
  }
  const noise = Float32Array.from({ length: CHORD_FRAME_SIZE }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1 * 0.1);
  const reading = analyser.read(noise, SR);
  assert.ok(reading !== null && reading.confidence === 0 && !reading.fit.accepted, 'noise: the fit refuses it');
});

test('onsets: a strum is one strum, found within 30 ms of when it was struck; notes 300 ms and 125 ms apart stay separate', () => {
  // chord practice groups a strum's onsets: a slow strum's later strings can be struck as hard as its first
  for (const seed of [42, 43, 44, 45, 46, 47]) {
    const strums = groupStrums(detectOnsets(strum(soundingKeys(OPEN_VOICINGS['G'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), seed, 30), SR));
    assert.equal(strums.length, 1, `seed ${seed}: ${JSON.stringify(strums)}`);
    assert.ok(Math.abs((strums[0] as { time: number }).time - 0.1) < 0.03, `seed ${seed}: struck at 0.1 s`);
  }
  const fast = renderNotes([60, 62, 64, 65, 67].map((key, i) => ({ key, onsetSeconds: 0.2 + i * 0.125, durationSeconds: 0.12, velocity: 90 })), SR);
  assert.equal(detectOnsets(fast, SR).length, 5, 'sixteenths at 120 BPM');
  const one = strum(soundingKeys(OPEN_VOICINGS['G'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 42, 30);
  const onsets = detectOnsets(one, SR);
  assert.ok(Math.abs((onsets[0] as { time: number }).time - 0.1) < 0.025 + 0.06, 'the strum spreads over its strings, starting at 0.1 s');
  const two = renderNotes([{ key: 52, onsetSeconds: 0.2, durationSeconds: 0.35, velocity: 90 }, { key: 55, onsetSeconds: 0.6, durationSeconds: 0.35, velocity: 90 }], SR);
  assert.deepEqual(detectOnsets(two, SR).map((o) => Math.round(o.time * 10) / 10), [0.2, 0.6]);
});

test('single notes are tracked: a plucked melody comes back note for note, each within 20 ms of where it was played, at the right MIDI key', () => {
  const melody = [64, 63, 64, 63, 64, 59, 62, 60, 57].map((key, i) => ({ key, onsetSeconds: 0.2 + i * 0.3, durationSeconds: 0.28, velocity: 80 }));
  const heard = trackNotes(renderNotes(melody, SR), SR);
  assert.deepEqual(heard.map((h) => h.key), melody.map((m) => m.key));
  heard.forEach((h, i) => assert.ok(Math.abs(h.time - (melody[i] as { onsetSeconds: number }).onsetSeconds) < 0.02, `note ${i} at ${h.time}`));
  assert.ok(heard.every((h) => Math.abs(h.cents) < 10 && h.confidence >= 0.6));
});
