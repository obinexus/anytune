/**
 * The teaching reference (src/music/reference.ts): a MIDI file becomes a reference that keeps its timing exactly, says where it came from, and marks every
 * estimate as one; estimated notes become a MIDI file whose every change from the estimate is counted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { referenceFromMidi, tempoMapOf, transcriptionToMidi, type EstimatedNote, type ReferenceDescription, type SourceAsset } from '../../src/music/reference.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FUR_ELISE = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid')));
const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
const midiAsset = (bytes: Uint8Array, fileName = 'fur-elise-opening.mid'): SourceAsset => ({ role: 'midi', fileName, mediaType: 'audio/midi', sha256: sha256(bytes), bytes: bytes.length });
const imported = (bytes: Uint8Array): ReferenceDescription => ({
  song: { id: 'fur-elise', title: 'Für Elise', composer: 'Ludwig van Beethoven' },
  arrangement: { id: 'fur-elise-full', version: 1, instrument: 'piano', part: 'full' },
  provenance: { kind: 'midi-import', midi: midiAsset(bytes) },
});

test('a MIDI import: the notes the file states — reviewed, none estimated, no confidence — with stable ids and an id that is the file’s SHA-256', () => {
  const result = referenceFromMidi(FUR_ELISE, imported(FUR_ELISE));
  if (!result.ok) assert.fail(result.reason);
  const ref = result.reference;
  assert.equal(ref.format, 'anytune-reference/1');
  assert.equal(ref.id, `ref-${sha256(FUR_ELISE)}`);
  assert.deepEqual(ref.review, { state: 'reviewed', corrections: 0 });
  assert.equal(ref.notes.length, 48);
  assert.deepEqual(ref.notes.map((n) => n.id), ref.notes.map((_, i) => `n${i}`));
  assert.ok(ref.notes.every((n) => !n.estimated && n.confidence === null));
  // the melody's first notes, the pickup E5 D♯5 then E5 D♯5 E5 B4 D5 C5, on track 1, channel 1
  assert.deepEqual(ref.notes.filter((n) => n.track === 1).slice(0, 8).map((n) => n.key), [76, 75, 76, 75, 76, 71, 74, 72]);
  assert.ok(ref.notes.filter((n) => n.track === 1).every((n) => n.channel === 0));
});

test('the timing is the file’s: 480 PPQ, ♩ = 72 then ♩ = 60 at bar 5, 3/8, A minor — and every note’s seconds are its ticks through that tempo map', () => {
  const result = referenceFromMidi(FUR_ELISE, imported(FUR_ELISE));
  if (!result.ok) assert.fail(result.reason);
  const { timing, notes } = result.reference;
  assert.deepEqual(timing.division, { kind: 'ppq', ticksPerQuarter: 480 });
  assert.deepEqual(timing.tempo.map((s) => [s.tick, s.microsecondsPerQuarter]), [[0, 833333], [3120, 1000000]]);
  assert.deepEqual(timing.timeSignatures.map((t) => [t.numerator, t.denominator]), [[3, 8]]);
  assert.deepEqual(timing.keySignatures.map((k) => [k.sharpsOrFlats, k.minor]), [[0, true]]);
  const map = tempoMapOf(result.reference);
  for (const note of notes) {
    // definition: before tick 3120, ticks × 833 333 µs ÷ 480; after, 3120 ticks of that plus the rest at 1 000 000 µs ÷ 480
    const expected = (tick: number): number => (tick <= 3120 ? (tick * 833333) / 480e6 : (3120 * 833333) / 480e6 + ((tick - 3120) * 1e6) / 480e6);
    assert.ok(Math.abs(note.onsetSeconds - expected(note.onsetTick)) < 1e-12);
    assert.ok(Math.abs(note.releaseSeconds - expected(note.releaseTick)) < 1e-12);
    assert.ok(Math.abs(map.secondsAt(note.onsetTick) - note.onsetSeconds) < 1e-12);
  }
  // ordering preserved: by onset
  for (let i = 1; i < notes.length; i++) assert.ok((notes[i]?.onsetTick as number) >= (notes[i - 1]?.onsetTick as number));
});

test('simultaneous notes, the sustain pedal and the deliberate same-key overlap are all kept for what they are', () => {
  const result = referenceFromMidi(FUR_ELISE, imported(FUR_ELISE));
  if (!result.ok) assert.fail(result.reason);
  const { notes } = result.reference;
  const overlapped = notes.filter((n) => n.flags.includes('overlapped'));
  assert.deepEqual(overlapped.map((n) => [n.key, n.onsetTick, n.releaseTick]), [[45, 3840, 4080], [45, 3960, 4320]]);
  // the left hand sounds with the melody: some left-hand note is sounding at the onset of some melody note
  assert.ok(notes.some((m) => m.track === 1 && notes.some((l) => l.track === 2 && l.onsetTick <= m.onsetTick && m.onsetTick < l.releaseTick)));
  // the pedal holds left-hand notes past their key release, never the melody (another channel)
  assert.ok(notes.some((n) => n.track === 2 && n.sustainedReleaseSeconds > n.releaseSeconds));
  assert.ok(notes.filter((n) => n.track === 1).every((n) => n.sustainedReleaseSeconds === n.releaseSeconds));
});

test('what cannot be a reference is refused with the reason, and nothing is invented: unreadable bytes, a file of no notes', () => {
  const bad = referenceFromMidi(Uint8Array.from([0x4d, 0x54, 0x68, 0x64]), imported(FUR_ELISE));
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.reason, /not readable at byte 0/);
  const silent = transcriptionToMidi([]);
  const none = referenceFromMidi(silent.bytes, imported(silent.bytes));
  assert.equal(none.ok, false);
  assert.match(none.ok ? '' : none.reason, /no notes/);
});

const estimate = (key: number, onsetSeconds: number, releaseSeconds: number, confidence: number): EstimatedNote => ({ key, onsetSeconds, releaseSeconds, velocity: 80, confidence });

test('a transcription: its notes are written to MIDI at 480 PPQ, read back within half a tick, marked estimated with their own confidences, and unreviewed', () => {
  const notes = [estimate(76, 0.0003, 0.2501, 0.91), estimate(75, 0.25, 0.4999, 0.62), estimate(64, 0.25, 0.75, 0.33), estimate(76, 0.5, 0.75, 0.88)];
  const midi = transcriptionToMidi(notes, { title: 'estimate' });
  assert.deepEqual(midi.adjustments, { mergedDuplicates: 0, releasesShortened: 0, releasesLengthened: 0 });
  const halfTick = 0.5 / 480 / 2; // 120 BPM: a tick is 1/960 s
  assert.ok(midi.maxRoundingSeconds <= halfTick + 1e-15);
  const description: ReferenceDescription = {
    song: { id: 'mine', title: 'My recording', composer: null },
    arrangement: { id: 'mine-melody', version: 1, instrument: 'acoustic-guitar', part: 'melody' },
    provenance: {
      kind: 'transcription',
      source: { role: 'source-media', fileName: 'furelise.mp4', mediaType: 'video/mp4', sha256: '0'.repeat(64), bytes: 1 },
      engine: { name: 'test-engine', version: '0', parameters: { onsetThreshold: 0.5 } },
      midi: midiAsset(midi.bytes, 'furelise.transcribed.mid'),
    },
    confidences: midi.confidences,
  };
  const result = referenceFromMidi(midi.bytes, description);
  if (!result.ok) assert.fail(result.reason);
  const ref = result.reference;
  assert.deepEqual(ref.review, { state: 'unreviewed', corrections: 0 });
  assert.ok(ref.notes.every((n) => n.estimated));
  // in the reference's order (onset, then key): E5@0, E4@0.25, D♯5@0.25, E5@0.5 — each with its own confidence
  assert.deepEqual(ref.notes.map((n) => [n.key, n.confidence]), [[76, 0.91], [64, 0.33], [75, 0.62], [76, 0.88]]);
  for (const note of ref.notes) {
    const source = notes.find((n) => n.key === note.key && Math.abs(n.onsetSeconds - note.onsetSeconds) <= halfTick + 1e-12);
    assert.ok(source, `note ${note.key} at ${note.onsetSeconds}`);
    assert.ok(Math.abs((source as EstimatedNote).releaseSeconds - note.releaseSeconds) <= halfTick + 1e-12);
  }
});

test('what MIDI cannot hold of an estimate is changed and counted: a duplicate keeps the more confident, a re-strike shortens the sounding note, a note lasts a tick', () => {
  const midi = transcriptionToMidi([
    estimate(60, 1, 2, 0.4),
    estimate(60, 1, 1.5, 0.9), // same key, same tick: the more confident is kept
    estimate(60, 1.25, 1.75, 0.7), // strikes 60 while the kept one (to 1.5) sounds: that one is released at 1.25
    estimate(62, 3, 3, 0.5), // zero length: one tick
  ]);
  assert.deepEqual(midi.adjustments, { mergedDuplicates: 1, releasesShortened: 1, releasesLengthened: 1 });
  assert.deepEqual(midi.confidences, [0.9, 0.7, 0.5]);
  const description: ReferenceDescription = { ...imported(midi.bytes), provenance: { kind: 'transcription', source: midiAsset(midi.bytes), engine: { name: 't', version: '0', parameters: {} }, midi: midiAsset(midi.bytes) }, confidences: midi.confidences };
  const result = referenceFromMidi(midi.bytes, description);
  if (!result.ok) assert.fail(result.reason);
  assert.deepEqual(result.reference.notes.map((n) => [n.key, n.onsetSeconds, n.releaseSeconds, n.confidence, n.flags]), [
    [60, 1, 1.25, 0.9, []],
    [60, 1.25, 1.75, 0.7, []],
    [62, 3, 3 + 1 / 960, 0.5, []],
  ]);
  assert.deepEqual(result.reference.diagnostics, []);
});

test('a transcription writer refuses an estimate MIDI cannot represent at all, rather than guessing', () => {
  assert.throws(() => transcriptionToMidi([estimate(128, 0, 1, 0.5)]), /not a MIDI note number/);
  assert.throws(() => transcriptionToMidi([estimate(60, 1, 0.5, 0.5)]), /ends before it starts/);
  assert.throws(() => transcriptionToMidi([estimate(60, 0, 1, 1.5)]), /confidence/);
});
