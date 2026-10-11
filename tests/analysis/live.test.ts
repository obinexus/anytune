/**
 * The live analyser (src/analysis/live.ts), fed as a capture would feed it: synthetic audio in 10 ms buffers, each stamped with the capture time of its first
 * sample. Events carry capture times; a gap in the stamps restarts the analysis rather than inventing time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveAnalyser, type LiveEvent } from '../../src/analysis/live.ts';
import { OPEN_VOICINGS, soundingKeys } from '../../src/music/guitar.ts';
import { renderNotes } from '../../src/synthesis/pluck.ts';
import { strum } from '../../tools/analysis/evaluate-guitar.ts';

const SR = 48000;
const feed = (analyser: LiveAnalyser, samples: Float32Array, start: number): LiveEvent[] => {
  const events: LiveEvent[] = [];
  for (let at = 0; at < samples.length; at += 480) events.push(...analyser.push(samples.subarray(at, Math.min(samples.length, at + 480)), start + at / SR));
  return events;
};

test('a melody, heard live: each note at its capture time (within 25 ms), at its key, sure of it', () => {
  const melody = [64, 63, 64, 59, 62, 60, 57].map((key, i) => ({ key, onsetSeconds: 0.3 + i * 0.35, durationSeconds: 0.3, velocity: 85 }));
  const start = 1234.5; // a monotonic clock's seconds, not zero
  const notes = feed(new LiveAnalyser({ sampleRate: SR, listenFor: 'notes' }), renderNotes(melody, SR), start).filter((e) => e.kind === 'note');
  assert.deepEqual(notes.map((n) => (n.kind === 'note' ? n.key : 0)), melody.map((m) => m.key));
  notes.forEach((n, i) => assert.ok(Math.abs(n.time - (start + (melody[i] as { onsetSeconds: number }).onsetSeconds)) < 0.025, `note ${i}`));
  assert.ok(notes.every((n) => n.kind === 'note' && n.confidence >= 0.6));
});

test('strums, heard live: one chord reading per strum, the right identity, at the strum’s time', () => {
  const g = strum(soundingKeys(OPEN_VOICINGS['G'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 11, 30, 1.0);
  const am = strum(soundingKeys(OPEN_VOICINGS['Am'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 12, 30, 1.0);
  const both = new Float32Array(g.length + am.length);
  both.set(g, 0);
  both.set(am, g.length);
  const chords = feed(new LiveAnalyser({ sampleRate: SR, listenFor: 'chords' }), both, 50).filter((e) => e.kind === 'chord');
  assert.deepEqual(chords.map((c) => (c.kind === 'chord' ? c.reading.candidates[0]?.symbol : '')), ['G', 'Am']);
  assert.ok(Math.abs((chords[0] as { time: number }).time - 50.1) < 0.03);
  assert.ok(Math.abs((chords[1] as { time: number }).time - 51.1) < 0.03);
});

test('a gap in the capture’s timestamps restarts the analysis there — counted — and later notes keep their true capture times', () => {
  const analyser = new LiveAnalyser({ sampleRate: SR, listenFor: 'notes' });
  const one = renderNotes([{ key: 60, onsetSeconds: 0.2, durationSeconds: 0.3, velocity: 90 }], SR);
  feed(analyser, one, 10);
  const later = feed(analyser, renderNotes([{ key: 67, onsetSeconds: 0.2, durationSeconds: 0.3, velocity: 90 }], SR), 20); // 10 s later, not where the samples left off
  assert.equal(analyser.discontinuities, 1);
  const note = later.find((e) => e.kind === 'note');
  assert.ok(note !== undefined && note.kind === 'note' && note.key === 67 && Math.abs(note.time - 20.2) < 0.025);
});

test('a note too faint to name is said to be unclear — an onset with no pitch — never dropped as if nothing had been played', () => {
  // the same plucked melody at −38 dBFS peak: the onsets are found, but no frame after them is loud enough for a confident pitch (YIN's silence: −48 dBFS RMS)
  const melody = [64, 63, 64, 59].map((key, i) => ({ key, onsetSeconds: 0.3 + i * 0.35, durationSeconds: 0.3, velocity: 85 }));
  const loud = renderNotes(melody, SR);
  let peak = 0;
  for (const v of loud) peak = Math.max(peak, Math.abs(v));
  const faint = loud.map((v) => (v * 10 ** (-38 / 20)) / peak);
  const events = feed(new LiveAnalyser({ sampleRate: SR, listenFor: 'notes' }), faint, 7);
  assert.equal(events.filter((e) => e.kind === 'note').length, 0, 'no pitch is claimed');
  const unclear = events.filter((e) => e.kind === 'unclear');
  assert.equal(unclear.length, melody.length);
  unclear.forEach((u, i) => assert.ok(Math.abs(u.time - (7 + (melody[i] as { onsetSeconds: number }).onsetSeconds)) < 0.025, `onset ${i}`));
});
