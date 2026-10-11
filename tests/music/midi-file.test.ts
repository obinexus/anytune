/**
 * The Standard MIDI File codec (src/music/midi-file.ts): files are built here byte by byte from the specification, so that what is expected is what the
 * specification says — never what the reader happened to produce. Refusals carry the offset and the reason; tolerances are warnings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile, writeMidiFile, type MidiFile, type MidiReadResult } from '../../src/music/midi-file.ts';

const bytesOf = (...parts: (number | string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : typeof part === 'number' ? [part] : part)));
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const header = (format: number, tracks: number, division: number): Uint8Array => bytesOf('MThd', u32(6), [0, format, 0, tracks, division >> 8, division & 0xff]);
const track = (...body: number[]): Uint8Array => bytesOf('MTrk', u32(body.length), body);
const join = (...chunks: Uint8Array[]): Uint8Array => Uint8Array.from(chunks.flatMap((c) => [...c]));
const ok = (result: MidiReadResult): Extract<MidiReadResult, { ok: true }> => {
  if (!result.ok) assert.fail(`refused at ${result.offset}: ${result.reason}`);
  return result;
};

test('a format 0 file at 96 PPQ: the header, a tempo, a note-on and its note-off, the end of track — at absolute ticks', () => {
  const file = join(header(0, 1, 96), track(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0x90, 60, 100, 0x60, 0x80, 60, 64, 0x00, 0xff, 0x2f, 0x00));
  const { file: read, warnings } = ok(readMidiFile(file));
  assert.deepEqual(warnings, []);
  assert.equal(read.format, 0);
  assert.deepEqual(read.division, { kind: 'ppq', ticksPerQuarter: 96 });
  assert.deepEqual(read.tracks[0]?.events, [
    { tick: 0, event: { kind: 'tempo', microsecondsPerQuarter: 500000 } },
    { tick: 0, event: { kind: 'noteOn', channel: 0, key: 60, velocity: 100 } },
    { tick: 96, event: { kind: 'noteOff', channel: 0, key: 60, velocity: 64 } },
    { tick: 96, event: { kind: 'endOfTrack' } },
  ]);
});

test('running status: a data byte continues the previous channel message; a meta or sysex event cancels it', () => {
  // 90 3C 64, then running status 40 64, then running 3C 00 (note-on velocity 0 stays a note-on here; the timeline reads it as a note-off)
  const file = join(header(0, 1, 480), track(0x00, 0x91, 60, 100, 0x00, 64, 100, 0x81, 0x70, 60, 0, 0x00, 0xff, 0x2f, 0x00));
  const events = ok(readMidiFile(file)).file.tracks[0]?.events;
  assert.deepEqual(events?.slice(0, 3), [
    { tick: 0, event: { kind: 'noteOn', channel: 1, key: 60, velocity: 100 } },
    { tick: 0, event: { kind: 'noteOn', channel: 1, key: 64, velocity: 100 } },
    { tick: 240, event: { kind: 'noteOn', channel: 1, key: 60, velocity: 0 } },
  ]);
  const cancelled = join(header(0, 1, 480), track(0x00, 0x90, 60, 100, 0x00, 0xff, 0x01, 0x00, 0x00, 60, 0, 0x00, 0xff, 0x2f, 0x00));
  const refused = readMidiFile(cancelled);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.reason, /no running status/);
});

test('variable-length quantities: 0x7F is one byte, 0x80 two, 0x0FFFFFFF four; a fifth byte is refused', () => {
  const at = (delta: number[]): number => ok(readMidiFile(join(header(0, 1, 96), track(...delta, 0xff, 0x2f, 0x00)))).file.tracks[0]?.events[0]?.tick as number;
  assert.equal(at([0x7f]), 0x7f);
  assert.equal(at([0x81, 0x00]), 0x80);
  assert.equal(at([0xff, 0xff, 0xff, 0x7f]), 0x0fffffff);
  const five = readMidiFile(join(header(0, 1, 96), track(0x81, 0x80, 0x80, 0x80, 0x00, 0xff, 0x2f, 0x00)));
  assert.equal(five.ok, false);
  assert.match(five.ok ? '' : five.reason, /more than four bytes/);
});

test('the SMPTE division is read as SMPTE — −25 frames per second, 40 ticks a frame — never as PPQ; −29 is 29.97; an unknown rate is refused', () => {
  const division = (word: number): MidiReadResult => readMidiFile(join(header(0, 1, word), track(0x00, 0xff, 0x2f, 0x00)));
  assert.deepEqual(ok(division(0xe728)).file.division, { kind: 'smpte', framesPerSecond: 25, ticksPerFrame: 40 });
  assert.deepEqual(ok(division(0xe350)).file.division, { kind: 'smpte', framesPerSecond: 29.97, ticksPerFrame: 80 });
  assert.deepEqual(ok(division(0xe850)).file.division, { kind: 'smpte', framesPerSecond: 24, ticksPerFrame: 80 });
  const odd = division(0xe628); // −26
  assert.equal(odd.ok, false);
  assert.match(odd.ok ? '' : odd.reason, /−24, −25, −29 and −30/);
  assert.equal(division(0x0000).ok, false, '0 ticks per quarter');
});

test('every channel message, meta events of known length and the text family, and sysex — kept for what they are', () => {
  const file = join(
    header(1, 1, 480),
    track(
      0x00, 0xa2, 61, 33, // poly pressure
      0x00, 0xb2, 64, 127, // sustain down
      0x00, 0xc2, 24, // program
      0x00, 0xd2, 77, // channel pressure
      0x00, 0xe2, 0x00, 0x40, // pitch bend centre
      0x00, 0xe2, 0x7f, 0x7f, // pitch bend top
      0x00, 0xff, 0x58, 0x04, 3, 3, 24, 8, // 3/8
      0x00, 0xff, 0x59, 0x02, 0xfd, 0x01, // three flats, minor
      0x00, 0xff, 0x03, 0x05, ...[...'Gtr 1'].map((c) => c.charCodeAt(0)),
      0x00, 0xff, 0x7f, 0x02, 0x41, 0x42, // sequencer-specific: kept raw
      0x00, 0xf0, 0x03, 0x43, 0x12, 0xf7, // sysex
      0x00, 0xff, 0x2f, 0x00,
    ),
  );
  const events = ok(readMidiFile(file)).file.tracks[0]?.events.map((e) => e.event);
  assert.deepEqual(events, [
    { kind: 'polyPressure', channel: 2, key: 61, pressure: 33 },
    { kind: 'controlChange', channel: 2, controller: 64, value: 127 },
    { kind: 'programChange', channel: 2, program: 24 },
    { kind: 'channelPressure', channel: 2, pressure: 77 },
    { kind: 'pitchBend', channel: 2, value: 0 },
    { kind: 'pitchBend', channel: 2, value: 8191 },
    { kind: 'timeSignature', numerator: 3, denominator: 3, clocksPerClick: 24, thirtySecondsPerQuarter: 8 },
    { kind: 'keySignature', sharpsOrFlats: -3, minor: true },
    { kind: 'text', type: 'trackName', text: 'Gtr 1' },
    { kind: 'meta', type: 0x7f, data: Uint8Array.from([0x41, 0x42]) },
    { kind: 'sysex', escape: false, data: Uint8Array.from([0x43, 0x12, 0xf7]) },
    { kind: 'endOfTrack' },
  ]);
});

test('refusals name the offset and the reason: not MThd, a truncated chunk, too few tracks, a tempo of the wrong length, a system real-time byte, a data byte with its high bit set', () => {
  const refused = (bytes: Uint8Array): { offset: number; reason: string } => {
    const result = readMidiFile(bytes);
    if (result.ok) assert.fail('accepted');
    return result;
  };
  assert.match(refused(bytesOf('RIFF', u32(6), [0, 0, 0, 1, 0, 96])).reason, /MThd/);
  assert.equal(refused(join(header(0, 1, 96), bytesOf('MTrk', u32(100), [0, 0xff, 0x2f, 0]))).offset, 14);
  assert.match(refused(join(header(1, 2, 96), track(0x00, 0xff, 0x2f, 0x00))).reason, /declares 2 tracks; the file holds 1/);
  assert.match(refused(join(header(0, 1, 96), track(0x00, 0xff, 0x51, 0x02, 0x07, 0xa1, 0x00, 0xff, 0x2f, 0x00))).reason, /tempo .* 2 bytes of data, not 3/);
  assert.match(refused(join(header(0, 1, 96), track(0x00, 0xf8, 0x00, 0xff, 0x2f, 0x00))).reason, /system common or real-time/);
  assert.match(refused(join(header(0, 1, 96), track(0x00, 0x90, 60, 0x80, 0x00, 0xff, 0x2f, 0x00))).reason, /high bit clear/);
  assert.match(refused(join(header(0, 2, 96), track(0x00, 0xff, 0x2f, 0x00), track(0x00, 0xff, 0x2f, 0x00))).reason, /format 0 file has one track/);
  assert.match(refused(join(header(3, 1, 96), track(0x00, 0xff, 0x2f, 0x00))).reason, /format 3 does not exist/);
  assert.match(refused(join(header(0, 1, 96), track(0x00, 0x90, 60))).reason, /ends inside a velocity/);
});

test('tolerated out loud: an alien chunk is skipped, a missing end-of-track and bytes after one are warnings, a longer header is read for its first 6 bytes', () => {
  const alien = bytesOf('XFIH', u32(3), [1, 2, 3]);
  const longHeader = bytesOf('MThd', u32(8), [0, 1, 0, 2, 0, 96, 0xaa, 0xbb]);
  const result = ok(readMidiFile(join(longHeader, alien, track(0x00, 0x90, 60, 100), track(0x00, 0xff, 0x2f, 0x00, 0x00, 0x90))));
  assert.equal(result.file.tracks.length, 2);
  const messages = result.warnings.map((w) => w.message);
  assert.ok(messages.some((m) => /2 bytes more than 6/.test(m)));
  assert.ok(messages.some((m) => /alien chunk "XFIH"/.test(m)));
  assert.ok(messages.some((m) => /no end-of-track/.test(m)));
  assert.ok(messages.some((m) => /after the end-of-track/.test(m)));
});

test('written and read back: the same file — PPQ and SMPTE, every event kind, absolute ticks; the end of track added when missing', () => {
  const file: MidiFile = {
    format: 1,
    division: { kind: 'ppq', ticksPerQuarter: 480 },
    tracks: [
      {
        events: [
          { tick: 0, event: { kind: 'text', type: 'trackName', text: 'Für Elise — conductor' } },
          { tick: 0, event: { kind: 'tempo', microsecondsPerQuarter: 857143 } },
          { tick: 0, event: { kind: 'timeSignature', numerator: 3, denominator: 3, clocksPerClick: 24, thirtySecondsPerQuarter: 8 } },
          { tick: 0, event: { kind: 'keySignature', sharpsOrFlats: 0, minor: true } },
          { tick: 1440, event: { kind: 'tempo', microsecondsPerQuarter: 600000 } },
          { tick: 1440, event: { kind: 'endOfTrack' } },
        ],
      },
      {
        events: [
          { tick: 0, event: { kind: 'programChange', channel: 0, program: 0 } },
          { tick: 0, event: { kind: 'noteOn', channel: 0, key: 76, velocity: 80 } },
          { tick: 240, event: { kind: 'noteOff', channel: 0, key: 76, velocity: 0 } },
          { tick: 240, event: { kind: 'controlChange', channel: 0, controller: 64, value: 127 } },
          { tick: 240, event: { kind: 'pitchBend', channel: 0, value: -8192 } },
          { tick: 300000, event: { kind: 'sysex', escape: true, data: Uint8Array.from([1, 2]) } },
        ],
      },
    ],
  };
  const read = ok(readMidiFile(writeMidiFile(file)));
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.file.tracks[0], file.tracks[0]);
  assert.deepEqual(read.file.tracks[1]?.events, [...(file.tracks[1]?.events ?? []), { tick: 300000, event: { kind: 'endOfTrack' } }]);
  const smpte: MidiFile = { format: 0, division: { kind: 'smpte', framesPerSecond: 29.97, ticksPerFrame: 100 }, tracks: [{ events: [{ tick: 0, event: { kind: 'endOfTrack' } }] }] };
  assert.deepEqual(ok(readMidiFile(writeMidiFile(smpte))).file, smpte);
});

test('the writer refuses what a MIDI file cannot hold, rather than writing something else', () => {
  const one = (event: MidiFile['tracks'][number]['events'][number]['event'], tick = 0): () => Uint8Array => () =>
    writeMidiFile({ format: 0, division: { kind: 'ppq', ticksPerQuarter: 96 }, tracks: [{ events: [{ tick, event }] }] });
  assert.throws(one({ kind: 'noteOn', channel: 16, key: 60, velocity: 1 }), /channel/);
  assert.throws(one({ kind: 'noteOn', channel: 0, key: 128, velocity: 1 }), /key/);
  assert.throws(one({ kind: 'tempo', microsecondsPerQuarter: 0x1000000 }), /microseconds/);
  assert.throws(one({ kind: 'endOfTrack' }, 0x10000000), /tick/);
  assert.throws(
    () => writeMidiFile({ format: 0, division: { kind: 'ppq', ticksPerQuarter: 96 }, tracks: [{ events: [{ tick: 5, event: { kind: 'endOfTrack' } }, { tick: 4, event: { kind: 'endOfTrack' } }] }] }),
    /ticks may not decrease|after its end-of-track/,
  );
  assert.throws(() => writeMidiFile({ format: 0, division: { kind: 'ppq', ticksPerQuarter: 96 }, tracks: [] }), /one track/);
});
