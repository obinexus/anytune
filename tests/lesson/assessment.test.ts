/**
 * Assessment, feedback and the practice clock (src/lesson/): what a learner played against what the arrangement asks for — pitch and timing apart, a missed
 * note never blamed on the notes after it, a steady lag told as "late" rather than "missed", an uncertain reading never a mistake; and the clock that keeps
 * loops, slow tempos and the count-in on one timeline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assessChords, assessNotes, DEFAULT_POLICY, type ExpectedNote, type HeardNote } from '../../src/lesson/assessment.ts';
import { feedbackOf } from '../../src/lesson/feedback.ts';
import { LessonClock, StepPractice, barOfTick, melodyTargets, notesByPass, targetsIn, type CapturedNote } from '../../src/lesson/practice.ts';
import { referenceFromMidi } from '../../src/music/reference.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** a scale, one note a beat at 120 BPM: C4 D4 E4 F4 G4 A4 B4 C5, two to a bar */
const SCALE: ExpectedNote[] = [60, 62, 64, 65, 67, 69, 71, 72].map((key, i) => ({ id: `n${i}`, key, time: i * 0.5, bar: 1 + Math.floor(i / 2) }));
const play = (notes: readonly ExpectedNote[], shift = 0, override: Partial<HeardNote> = {}): HeardNote[] => notes.map((n) => ({ time: n.time + shift, key: n.key, cents: 2, confidence: 0.9, ...override }));

test('played as written: every note right and on time; nothing extra', () => {
  const { results, extra } = assessNotes(SCALE, play(SCALE, 0.01));
  assert.deepEqual(results.map((r) => [r.pitch, r.timing]), SCALE.map(() => ['correct', 'on-time']));
  assert.equal(extra.length, 0);
});

test('one note missed in the middle is that note’s miss alone — the notes after it are still right and on time (no cascade)', () => {
  const heard = play(SCALE).filter((_, i) => i !== 3);
  const { results, extra } = assessNotes(SCALE, heard);
  assert.deepEqual(results.map((r) => r.pitch), ['correct', 'correct', 'correct', 'missed', 'correct', 'correct', 'correct', 'correct']);
  assert.ok(results.filter((r) => r.pitch !== 'missed').every((r) => r.timing === 'on-time'));
  assert.equal(extra.length, 0);
});

test('a note added between two others is extra, and takes nothing from them', () => {
  const heard = [...play(SCALE), { time: 1.25, key: 66, cents: 0, confidence: 0.9 }];
  const { results, extra } = assessNotes(SCALE, heard);
  assert.ok(results.every((r) => r.pitch === 'correct'));
  assert.deepEqual(extra.map((e) => [e.time, e.key]), [[1.25, 66]]);
});

test('pitch and timing are judged apart: a wrong note on time, the right note late, the right note an octave down early, an unsure reading neither right nor wrong', () => {
  const heard: HeardNote[] = play(SCALE);
  heard[1] = { time: 0.5, key: 63, cents: 0, confidence: 0.9 }; // wrong, on time
  heard[2] = { time: 1.15, key: 64, cents: 0, confidence: 0.9 }; // right, 150 ms late
  heard[4] = { time: 1.88, key: 55, cents: 0, confidence: 0.9 }; // octave below, 120 ms early
  heard[6] = { time: 3.0, key: 70, cents: 0, confidence: 0.3 }; // too unsure to judge
  const { results } = assessNotes(SCALE, heard);
  assert.deepEqual(results.map((r) => [r.pitch, r.timing]), [
    ['correct', 'on-time'],
    ['wrong', 'on-time'],
    ['correct', 'late'],
    ['correct', 'on-time'],
    ['octave', 'early'],
    ['correct', 'on-time'],
    ['uncertain', 'on-time'],
    ['correct', 'on-time'],
  ]);
  assert.ok(Math.abs((results[2]?.offsetSeconds as number) - 0.15) < 1e-9);
});

test('a learner steadily behind — 200 ms, even 450 ms, beyond the window — is aligned note for note and told late, never told everything was missed', () => {
  for (const lag of [0.2, 0.45]) {
    const { results, extra } = assessNotes(SCALE, play(SCALE, lag));
    assert.deepEqual(results.map((r) => [r.pitch, r.timing]), SCALE.map(() => ['correct', 'late']), `lag ${lag}`);
    assert.equal(extra.length, 0);
  }
  // the cascade the local offset prevents: not following the lag, each note 450 ms late is 50 ms from the NEXT target, and is judged against it — the
  // first note "missed", every other "wrong" though every note was right
  const rigid = assessNotes(SCALE, play(SCALE, 0.45), { ...DEFAULT_POLICY, maxDriftSeconds: 0 });
  assert.deepEqual(rigid.results.map((r) => r.pitch), ['missed', 'wrong', 'wrong', 'wrong', 'wrong', 'wrong', 'wrong', 'wrong']);
});

test('step mode judges no timing; a missed target before an early one is still the right one missed', () => {
  const { results } = assessNotes(SCALE, play(SCALE, 0.2), { ...DEFAULT_POLICY, assessTiming: false });
  assert.ok(results.every((r) => r.pitch === 'correct' && r.timing === null));
});

test('chords: the identity judged apart from the timing — right, wrong (and what was heard instead), too unsure, missed', () => {
  const expected = ['C', 'G', 'Am', 'F', 'C'].map((symbol, i) => ({ id: `c${i}`, symbol, time: i * 2, bar: i + 1 }));
  const heard = [
    { time: 0.02, candidates: [{ symbol: 'C', score: 0.9 }], confidence: 0.85 },
    { time: 2.3, candidates: [{ symbol: 'Em', score: 0.7 }, { symbol: 'G', score: 0.6 }], confidence: 0.7 },
    { time: 3.98, candidates: [{ symbol: 'Am', score: 0.5 }], confidence: 0.4 },
    { time: 8.0, candidates: [{ symbol: 'C', score: 0.9 }], confidence: 0.9 },
  ];
  const { results, extra } = assessChords(expected, heard);
  assert.deepEqual(results.map((r) => [r.chord, r.heardSymbol, r.timing]), [
    ['correct', null, 'on-time'],
    ['wrong', 'Em', 'late'],
    ['uncertain', null, 'on-time'],
    ['missed', null, null],
    ['correct', null, 'on-time'],
  ]);
  assert.equal(extra.length, 0);
});

test('feedback says what went right, then the bar to repeat, the octave slip, the miss, the steady lag — and keeps the unsure readings out of the mistakes', () => {
  const heard = play(SCALE, 0.12);
  heard[5] = { ...(heard[5] as HeardNote), key: 57 }; // bar 3: an octave slip
  heard.splice(4, 1); // bar 3: a miss
  heard[0] = { ...(heard[0] as HeardNote), confidence: 0.2 };
  const notes = assessNotes(SCALE, heard);
  const fb = feedbackOf(notes.results, [], notes.extra.length);
  assert.deepEqual(fb.pitch, { right: 5, octave: 1, wrong: 0, missed: 1, uncertain: 1, of: 8 });
  assert.equal(fb.repeatBar, 3);
  assert.equal(fb.timing.typicalOffsetMs, 120);
  assert.deepEqual(fb.sentences, [
    '5 of the 6 notes I heard clearly were right.',
    'Try bar 3 again: that is where most notes went astray.',
    '1 note was the right note in the wrong octave.',
    'I did not hear 1 note where it was due.',
    'You are about 120 ms behind the beat: listen to the click, or try a slower tempo.',
    '1 note was too unclear to judge — not counted as mistakes.',
  ]);
  const perfect = assessNotes(SCALE, play(SCALE));
  assert.deepEqual(feedbackOf(perfect.results, [], 0).sentences, ['Every note I heard clearly was the right one (8 notes).', 'Timing: 8 on time, 0 early, 0 late.']);
});

test('bars follow the time signature after the pickup: in Für Elise (3/8, a two-sixteenth pickup) the melody’s first notes are bar 0, then bar 1 starts on E5', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid')));
  const made = referenceFromMidi(bytes, { song: { id: 'fe', title: 'Für Elise', composer: null }, arrangement: { id: 'fe-melody', version: 1, instrument: 'acoustic-guitar', part: 'melody' }, provenance: { kind: 'midi-import', midi: { role: 'midi', fileName: 'f.mid', mediaType: 'audio/midi', sha256: 'f', bytes: 1 } } });
  assert.ok(made.ok);
  const { targets, octaveShift } = melodyTargets(made.reference, 1, -12, 240);
  assert.equal(octaveShift, -12);
  assert.deepEqual(targets.slice(0, 9).map((t) => [t.key, t.bar]), [[64, 0], [63, 0], [64, 1], [63, 1], [64, 1], [59, 1], [62, 1], [60, 1], [57, 2]]);
  assert.equal(barOfTick(240 + 720 * 4, made.reference.timing, 240), 5);
  // the reference is not changed by the arrangement
  assert.equal(made.reference.notes.find((n) => n.track === 1)?.key, 76);
});

test('the lesson clock: the count-in, half speed, two passes of an A–B loop, input latency, a note just early for the next pass — and due() is read()’s inverse', () => {
  const clock = new LessonClock({ startedAt: 100, countInSeconds: 2, tempoFactor: 0.5, from: 1, to: 3, inputLatencySeconds: 0.05, earlyAllowanceSeconds: 0.1 });
  const counting = clock.read(101);
  assert.ok(counting.phase === 'count-in' && Math.abs(counting.secondsLeft - 1.05) < 1e-9);
  const r = (at: number): { pass: number; time: number } => {
    const reading = clock.read(at);
    assert.equal(reading.phase, 'playing');
    return reading as { pass: number; time: number };
  };
  // half speed: 4 capture seconds per 2-second pass
  assert.equal(r(102.05).pass, 0);
  assert.ok(Math.abs(r(102.05).time - 1) < 1e-9);
  assert.ok(Math.abs(r(104.05).time - 2) < 1e-9);
  const early = r(105.97); // 80 ms (capture) before the second pass starts: 40 ms of reference time early, within the allowance
  assert.equal(early.pass, 1);
  assert.ok(Math.abs(early.time - (1 - 0.04)) < 1e-9);
  for (const [pass, time] of [[0, 1.5], [1, 2.25], [3, 1]] as const) {
    const back = r(clock.due(pass, time) + 0.05);
    assert.equal(back.pass, pass);
    assert.ok(Math.abs(back.time - time) < 1e-9);
  }
});

test('a looped, slowed practice is assessed pass by pass: bars 2–3 of the scale at half speed, the second pass with one wrong note', () => {
  const from = 1; // bar 2 starts at 1 s
  const to = 3; // bar 4 starts at 3 s
  const clock = new LessonClock({ startedAt: 0, countInSeconds: 1, tempoFactor: 0.5, from, to, inputLatencySeconds: 0, earlyAllowanceSeconds: 0.1 });
  const loop = targetsIn(SCALE, from, to);
  const captured: CapturedNote[] = [];
  for (const pass of [0, 1]) for (const t of loop) captured.push({ at: clock.due(pass, t.time) + 0.02, key: pass === 1 && t.id === 'n4' ? 66 : t.key, cents: 0, confidence: 0.9 });
  const byPass = notesByPass(clock, [{ at: 0.5, key: 60, cents: 0, confidence: 0.9 }, ...captured]); // a note in the count-in is not counted
  assert.deepEqual([...byPass.keys()], [0, 1]);
  const first = assessNotes(loop, byPass.get(0) ?? []);
  const second = assessNotes(loop, byPass.get(1) ?? []);
  assert.ok(first.results.every((x) => x.pitch === 'correct' && x.timing === 'on-time'), 'on time at half speed: 20 ms of capture time is 10 ms of reference time');
  assert.deepEqual(second.results.map((x) => x.pitch), ['correct', 'correct', 'wrong', 'correct']);
});

test('step mode waits for the right note: a wrong note or an octave is said and asked again; an unsure one is not counted as a try', () => {
  const step = new StepPractice(SCALE.slice(0, 3));
  assert.equal(step.current?.key, 60);
  assert.deepEqual(step.hear({ key: 61, confidence: 0.9 }), { kind: 'not-yet', heard: 'wrong' });
  assert.deepEqual(step.hear({ key: 48, confidence: 0.9 }), { kind: 'not-yet', heard: 'octave' });
  assert.deepEqual(step.hear({ key: 60, confidence: 0.2 }), { kind: 'not-yet', heard: 'uncertain' });
  assert.equal(step.hear({ key: 60, confidence: 0.9 }).kind, 'advanced');
  step.hear({ key: 62, confidence: 0.9 });
  step.hear({ key: 64, confidence: 0.9 });
  assert.ok(step.done);
  assert.deepEqual(step.tries, [3, 1, 1]);
});
