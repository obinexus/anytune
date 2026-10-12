/**
 * The consensus a Follow my playing decision is taken over (src/lesson/consensus.ts): YES, NO or MAYBE on one attack, from the observations after it. First
 * on observation sequences written out, then on what the live analyser (src/analysis/live.ts) reports for SYNTHETIC plucked strings and strums — the only
 * audio measured so far. No real guitar recording is tested here: none is in the repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveAnalyser, type LiveEvent } from '../../src/analysis/live.ts';
import { DEFAULT_CONSENSUS, judgeChord, judgeNote } from '../../src/lesson/consensus.ts';
import { MVP_CHORDS } from '../../src/music/chords.ts';
import { OPEN_VOICINGS, soundingKeys } from '../../src/music/guitar.ts';
import { renderNotes } from '../../src/synthesis/pluck.ts';
import { strum } from '../../tools/analysis/evaluate-guitar.ts';

const SR = 48000;
const obs = (...xs: (readonly [number | null, number])[]) => xs.map(([midi, confidence]) => ({ midi, confidence }));

test('a note: YES when the confident observations agree on it; NO when they agree on another (an octave said apart); MAYBE otherwise — never a mistake', () => {
  assert.deepEqual(judgeNote(52, obs([52.1, 0.9], [51.9, 0.92], [52.0, 0.9], [52.2, 0.88])), { kind: 'yes' });
  assert.deepEqual(judgeNote(52, obs([53, 0.9], [53.1, 0.9], [52.9, 0.9])), { kind: 'no', why: 'different-note', heardKey: 53, heardSymbol: null });
  assert.deepEqual(judgeNote(52, obs([64, 0.9], [64, 0.9], [64, 0.9])), { kind: 'no', why: 'octave', heardKey: 64, heardSymbol: null });
  assert.deepEqual(judgeNote(52, obs([null, 0], [null, 0], [null, 0])), { kind: 'maybe', why: 'silence' });
  assert.deepEqual(judgeNote(52, obs([52, 0.3], [52, 0.4], [52, 0.2])), { kind: 'maybe', why: 'unclear' }, 'unsure observations are not a verdict');
  assert.deepEqual(judgeNote(52, obs([52, 0.9], [57, 0.9], [60, 0.9], [47, 0.9])), { kind: 'maybe', why: 'disagreement' });
  assert.deepEqual(judgeNote(52, obs([52, 0.9], [52, 0.9])), { kind: 'maybe', why: 'unclear' }, 'too few to agree');
});

test('the thresholds are options: a stricter confidence turns a borderline YES into MAYBE; a looser agreement accepts a split', () => {
  const borderline = obs([52, 0.65], [52, 0.66], [52, 0.7]);
  assert.equal(judgeNote(52, borderline).kind, 'yes');
  assert.equal(judgeNote(52, borderline, { ...DEFAULT_CONSENSUS, minConfidence: 0.8 }).kind, 'maybe');
  const split = obs([52, 0.9], [52, 0.9], [53, 0.9], [53, 0.9]);
  assert.equal(judgeNote(52, split).kind, 'maybe', 'half and half is not agreement');
  assert.equal(judgeNote(52, split, { ...DEFAULT_CONSENSUS, agreement: 0.5 }).kind, 'yes', 'ties go to the first agreed — a looser setting decides');
});

/** The attacks the analyser reports for a signal, as Follow would receive them. */
function attacks(signal: Float32Array, listenFor: 'notes' | 'both', start = 3): LiveEvent[] {
  const a = new LiveAnalyser({ sampleRate: SR, listenFor, chordOffsets: [0.02, 0.09, 0.16] });
  const out: LiveEvent[] = [];
  for (let i = 0; i + 1024 <= signal.length; i += 1024) out.push(...a.push(signal.slice(i, i + 1024), start + i / SR));
  return out.filter((e) => e.kind === 'note' || e.kind === 'unclear' || e.kind === 'chord');
}

test('on synthetic plucks, through the live analyser: E3 to an E3 target is YES; F3 is NO, heard as F3; the same pluck at −40 dBFS is MAYBE', () => {
  const pluck = (key: number, level = 1): Float32Array => {
    const s = renderNotes([{ key, onsetSeconds: 0.2, durationSeconds: 0.6, velocity: 90 }], SR);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    return s.map((v) => (v * level) / peak);
  };
  const e3 = attacks(pluck(52, 0.7), 'notes');
  assert.equal(e3.length, 1, 'one pluck, one attack');
  assert.deepEqual(judgeNote(52, (e3[0] as unknown as { observations: [] }).observations), { kind: 'yes' });
  const f3 = attacks(pluck(53, 0.7), 'notes');
  assert.deepEqual(judgeNote(52, (f3[0] as unknown as { observations: [] }).observations), { kind: 'no', why: 'different-note', heardKey: 53, heardSymbol: null });
  const faint = attacks(pluck(52, 10 ** (-40 / 20)), 'notes');
  assert.ok(faint.length <= 1);
  if (faint[0] !== undefined) assert.equal(judgeNote(52, (faint[0] as unknown as { observations: [] }).observations).kind, 'maybe', 'too faint to name: no verdict');
});

test('on synthetic strums: an E strum (its strings spread over ~100 ms) is YES for E; an Am strum is NO, heard as Am; a lone E2 — the root alone — is NOT the chord', () => {
  const chord = (symbol: string, seed: number): Float32Array => strum(soundingKeys(OPEN_VOICINGS[symbol] as NonNullable<(typeof OPEN_VOICINGS)[string]>), seed, 30, 1.2);
  const e = attacks(chord('E', 1001), 'both').filter((x) => x.kind === 'chord');
  assert.equal(e.length, 1, 'one strum, one attack: its later strings are part of it');
  const ev = e[0] as Extract<LiveEvent, { kind: 'chord' }>;
  assert.equal(ev.readings.length, 3, 'three chord frames after the strum');
  assert.deepEqual(judgeChord('E', ev.readings, ev.observations, MVP_CHORDS), { kind: 'yes' });
  const am = attacks(chord('Am', 1002), 'both').filter((x) => x.kind === 'chord')[0] as Extract<LiveEvent, { kind: 'chord' }>;
  assert.deepEqual(judgeChord('E', am.readings, am.observations, MVP_CHORDS), { kind: 'no', why: 'different-chord', heardKey: null, heardSymbol: 'Am' });
  // the root alone: E2 plucked — its harmonics hold E, B and G♯, the E chord's notes; a single clear pitch is not a strum
  const root = renderNotes([{ key: 40, onsetSeconds: 0.2, durationSeconds: 1, velocity: 90 }], SR);
  const rootEvents = attacks(root, 'both').filter((x) => x.kind === 'chord') as Extract<LiveEvent, { kind: 'chord' }>[];
  assert.equal(rootEvents.length, 1);
  const verdict = judgeChord('E', (rootEvents[0] as Extract<LiveEvent, { kind: 'chord' }>).readings, (rootEvents[0] as Extract<LiveEvent, { kind: 'chord' }>).observations, MVP_CHORDS);
  assert.notEqual(verdict.kind, 'yes', 'the root alone never counts as the chord');
  assert.deepEqual(verdict, { kind: 'no', why: 'single-note', heardKey: 40, heardSymbol: null });
});

test('a chord the detector does not support is never judged: MAYBE, whatever was played', () => {
  assert.deepEqual(judgeChord('Fmaj7', [{ candidates: [{ symbol: 'Am' }], confidence: 0.9 }], [], MVP_CHORDS), { kind: 'maybe', why: 'unsupported' });
  assert.deepEqual([...MVP_CHORDS], ['C', 'D', 'E', 'G', 'A', 'Am', 'Em', 'Dm'], 'the declared vocabulary, in open voicings (src/music/guitar.ts)');
});
