/**
 * The timeline of a MIDI file (src/music/timeline.ts): ticks to seconds through the tempo map (or the SMPTE rate), and note-ons paired with note-offs by the
 * rules the module writes down. Expected seconds are computed here from the definitions — ticks × µs per quarter ÷ (PPQ × 10⁶) — never read back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MidiFile, TimedEvent } from '../../src/music/midi-file.ts';
import { TempoMap, timelineOf, type Timeline } from '../../src/music/timeline.ts';

const ppq = (ticksPerQuarter: number, ...tracks: TimedEvent[][]): MidiFile => ({ format: 1, division: { kind: 'ppq', ticksPerQuarter }, tracks: tracks.map((events) => ({ events })) });
const on = (tick: number, key: number, velocity = 100, channel = 0): TimedEvent => ({ tick, event: { kind: 'noteOn', channel, key, velocity } });
const off = (tick: number, key: number, velocity = 64, channel = 0): TimedEvent => ({ tick, event: { kind: 'noteOff', channel, key, velocity } });
const tempo = (tick: number, microsecondsPerQuarter: number): TimedEvent => ({ tick, event: { kind: 'tempo', microsecondsPerQuarter } });
const pedal = (tick: number, value: number, channel = 0): TimedEvent => ({ tick, event: { kind: 'controlChange', channel, controller: 64, value } });
const end = (tick: number): TimedEvent => ({ tick, event: { kind: 'endOfTrack' } });
const timeline = (file: MidiFile): Timeline => {
  const result = timelineOf(file);
  if (!result.ok) assert.fail(result.reason);
  return result.timeline;
};
const close = (actual: number, expected: number, what = ''): void => assert.ok(Math.abs(actual - expected) < 1e-12, `${what}: ${actual} ≠ ${expected}`);

test('before any tempo event, 120 BPM: 480 ticks at 480 PPQ are half a second', () => {
  const map = new TempoMap({ kind: 'ppq', ticksPerQuarter: 480 });
  close(map.secondsAt(480), 0.5);
  close(map.tickAt(0.5), 480);
});

test('a tempo change mid-file: seconds accumulate per segment, and the inverse holds across the change', () => {
  // 0…960 at 500 000 µs/q (1 s), then 300 000 µs/q (200 BPM)
  const map = new TempoMap({ kind: 'ppq', ticksPerQuarter: 480 }, [{ tick: 960, microsecondsPerQuarter: 300000 }]);
  close(map.secondsAt(960), 1);
  close(map.secondsAt(1440), 1 + (480 * 300000) / (480 * 1e6));
  for (const tick of [0, 1, 479, 960, 961, 5000, 1234.5]) close(map.tickAt(map.secondsAt(tick)), tick, `tick ${tick}`);
  assert.equal(map.microsecondsPerQuarterAt(959), 500000);
  assert.equal(map.microsecondsPerQuarterAt(960), 300000);
});

test('two tempo events on one tick: the later one holds; a tempo at tick 0 replaces the default', () => {
  const map = new TempoMap({ kind: 'ppq', ticksPerQuarter: 96 }, [
    { tick: 0, microsecondsPerQuarter: 1_000_000 },
    { tick: 96, microsecondsPerQuarter: 250_000 },
    { tick: 96, microsecondsPerQuarter: 750_000 },
  ]);
  assert.equal(map.segments.length, 2);
  close(map.secondsAt(96), 1);
  close(map.secondsAt(192), 1.75);
});

test('SMPTE: 25 fps × 40 ticks is 1000 ticks a second, and a tempo event changes nothing; 29.97 is 30000/1001 frames a second', () => {
  const file: MidiFile = { format: 0, division: { kind: 'smpte', framesPerSecond: 25, ticksPerFrame: 40 }, tracks: [{ events: [tempo(0, 250000), on(0, 60), off(1500, 60), end(1500)] }] };
  const t = timeline(file);
  close(t.notes[0]?.offSeconds as number, 1.5);
  assert.ok(t.diagnostics.some((d) => /SMPTE: the tempo events are kept, and change no time/.test(d)));
  const drop = new TempoMap({ kind: 'smpte', framesPerSecond: 29.97, ticksPerFrame: 80 });
  close(drop.secondsAt(80 * 30000), 1001);
});

test('tempo events from every track are merged: a format 1 file whose tempo is in track 1 is still timed by it', () => {
  const t = timeline(ppq(480, [end(0)], [tempo(0, 1_000_000), on(0, 64), off(480, 64), end(480)]));
  close(t.notes[0]?.offSeconds as number, 1);
});

test('a note-on of velocity 0 is a note-off; the note keeps its note-on velocity, and its release velocity is unknown', () => {
  const t = timeline(ppq(480, [on(0, 60, 90), on(480, 60, 0), end(480)]));
  assert.equal(t.notes.length, 1);
  assert.deepEqual({ ...t.notes[0], onSeconds: 0 }, { track: 0, channel: 0, key: 60, velocity: 90, releaseVelocity: null, onTick: 0, offTick: 480, onSeconds: 0, offSeconds: 0.5, sustainedOffSeconds: 0.5, flags: [] });
});

test('overlapping notes of one key pair first-in, first-out, and both are flagged; a repeated note written note-on then note-off on one tick reads as end-and-restart, unflagged', () => {
  const overlap = timeline(ppq(480, [on(0, 60), on(240, 60), off(480, 60), off(960, 60), end(960)]));
  assert.deepEqual(overlap.notes.map((n) => [n.onTick, n.offTick, n.flags]), [[0, 480, ['overlapped']], [240, 960, ['overlapped']]]);
  const restrike = timeline(ppq(480, [on(0, 62), on(480, 62), off(480, 62), off(960, 62), end(960)]));
  assert.deepEqual(restrike.notes.map((n) => [n.onTick, n.offTick, n.flags]), [[0, 480, []], [480, 960, []]], 'touching, not overlapping');
});

test('a note-off with nothing sounding is ignored and said; a note never released ends with its track, flagged unterminated', () => {
  const t = timeline(ppq(480, [off(0, 50), on(100, 52), end(700)]));
  assert.deepEqual(t.notes.map((n) => [n.key, n.onTick, n.offTick, n.flags]), [[52, 100, 700, ['unterminated']]]);
  assert.ok(t.diagnostics.some((d) => /note-off of key 50 .* ignored/.test(d)));
  assert.ok(t.diagnostics.some((d) => /key 52 .* never released/.test(d)));
});

test('the sustain pedal keeps a released note sounding until it rises — or until the key is struck again — and never moves the release itself', () => {
  const t = timeline(ppq(480, [pedal(0, 127), on(0, 60), off(240, 60), on(720, 60), off(960, 60), pedal(1200, 0), on(1200, 64), off(1440, 64), end(1440)]));
  const [first, second, third] = t.notes;
  close(first?.offSeconds as number, 0.25);
  close(first?.sustainedOffSeconds as number, 0.75, 'cut by the restrike at 720');
  close(second?.sustainedOffSeconds as number, 1.25, 'until the pedal rises at 1200');
  close(third?.sustainedOffSeconds as number, third?.offSeconds as number, 'no pedal');
  assert.deepEqual(t.pedals.map((p) => [p.channel, p.downTick, p.upTick, p.unterminated]), [[0, 0, 1200, false]]);
});

test('the pedal is per channel: channel 2’s pedal holds nothing on channel 1', () => {
  const t = timeline(ppq(480, [pedal(0, 127, 1), on(0, 60), off(240, 60), end(960)]));
  close(t.notes[0]?.sustainedOffSeconds as number, 0.25);
  assert.equal(t.pedals[0]?.unterminated, true);
});

test('time and key signatures are timed; the denominator is the note value; track names are kept; the end is the last end-of-track', () => {
  const t = timeline(
    ppq(
      96,
      [{ tick: 0, event: { kind: 'text', type: 'trackName', text: 'Melody' } }, { tick: 0, event: { kind: 'timeSignature', numerator: 3, denominator: 3, clocksPerClick: 24, thirtySecondsPerQuarter: 8 } }, { tick: 0, event: { kind: 'keySignature', sharpsOrFlats: 0, minor: true } }, end(288)],
      [end(960)],
    ),
  );
  assert.deepEqual(t.timeSignatures, [{ tick: 0, seconds: 0, numerator: 3, denominator: 8 }]);
  assert.deepEqual(t.keySignatures, [{ tick: 0, seconds: 0, sharpsOrFlats: 0, minor: true }]);
  assert.deepEqual(t.trackNames, ['Melody', null]);
  assert.equal(t.endTick, 960);
  close(t.endSeconds, 5);
});

test('format 2 has no single timeline, and is refused with the reason', () => {
  const result = timelineOf({ format: 2, division: { kind: 'ppq', ticksPerQuarter: 96 }, tracks: [{ events: [end(0)] }] });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /format 2/);
});

test('notes are ordered by onset, then track, then key — a chord’s keys low to high', () => {
  const t = timeline(ppq(96, [on(0, 67), on(0, 60), on(0, 64), off(96, 60), off(96, 64), off(96, 67), end(96)]));
  assert.deepEqual(t.notes.map((n) => n.key), [60, 64, 67]);
  assert.ok(t.notes.every((n) => n.flags.length === 0));
});
