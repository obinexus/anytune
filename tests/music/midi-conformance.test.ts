/**
 * The codec against an independent implementation: midi-file 1.2.4 (MIT, Carter Thaxton; a devDependency used only here, as an oracle). What AnyTune writes,
 * midi-file reads as the same events; what midi-file writes — with running status and note-ons of velocity 0, which AnyTune never writes — AnyTune reads as
 * the same events. Both sides are reduced to one neutral form (kind, absolute tick, the fields) so that neither's representation is the reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, writeMidi, type MidiData, type MidiEvent as TheirEvent } from 'midi-file';
import { readMidiFile, writeMidiFile, type MidiEvent, type MidiFile } from '../../src/music/midi-file.ts';

type Neutral = readonly (string | number)[];

const ours = (event: MidiEvent): Neutral | null => {
  switch (event.kind) {
    case 'noteOn':
      return event.velocity === 0 ? ['off', event.channel, event.key] : ['on', event.channel, event.key, event.velocity];
    case 'noteOff':
      return ['off', event.channel, event.key];
    case 'controlChange':
      return ['cc', event.channel, event.controller, event.value];
    case 'programChange':
      return ['program', event.channel, event.program];
    case 'pitchBend':
      return ['bend', event.channel, event.value];
    case 'channelPressure':
      return ['pressure', event.channel, event.pressure];
    case 'polyPressure':
      return ['polyPressure', event.channel, event.key, event.pressure];
    case 'tempo':
      return ['tempo', event.microsecondsPerQuarter];
    case 'timeSignature':
      return ['timeSignature', event.numerator, 2 ** event.denominator];
    case 'keySignature':
      return ['keySignature', event.sharpsOrFlats, event.minor ? 1 : 0];
    case 'text':
      return event.type === 'trackName' ? ['trackName', event.text] : null;
    case 'endOfTrack':
      return ['end'];
    default:
      return null;
  }
};

const theirs = (event: TheirEvent): Neutral | null => {
  switch (event.type) {
    case 'noteOn':
      return ['on', event.channel, event.noteNumber, event.velocity];
    case 'noteOff':
      return ['off', event.channel, event.noteNumber];
    case 'controller':
      return ['cc', event.channel, event.controllerType, event.value];
    case 'programChange':
      return ['program', event.channel, event.programNumber];
    case 'pitchBend':
      return ['bend', event.channel, event.value];
    case 'channelAftertouch':
      return ['pressure', event.channel, event.amount];
    case 'noteAftertouch':
      return ['polyPressure', event.channel, event.noteNumber, event.amount];
    case 'setTempo':
      return ['tempo', event.microsecondsPerBeat];
    case 'timeSignature':
      return ['timeSignature', event.numerator, event.denominator];
    case 'keySignature':
      return ['keySignature', event.key, event.scale];
    case 'trackName':
      return ['trackName', event.text];
    case 'endOfTrack':
      return ['end'];
    default:
      return null;
  }
};

const neutralOurs = (file: MidiFile): Neutral[][] => file.tracks.map((t) => t.events.flatMap(({ tick, event }) => (ours(event) === null ? [] : [[tick, ...(ours(event) as Neutral)]])));
const neutralTheirs = (data: MidiData): Neutral[][] =>
  data.tracks.map((events) => {
    let tick = 0;
    return events.flatMap((event) => {
      tick += event.deltaTime;
      const n = theirs(event);
      return n === null ? [] : [[tick, ...n]];
    });
  });

const FILE: MidiFile = {
  format: 1,
  division: { kind: 'ppq', ticksPerQuarter: 480 },
  tracks: [
    {
      events: [
        { tick: 0, event: { kind: 'text', type: 'trackName', text: 'conductor' } },
        { tick: 0, event: { kind: 'tempo', microsecondsPerQuarter: 857143 } },
        { tick: 0, event: { kind: 'timeSignature', numerator: 3, denominator: 3, clocksPerClick: 24, thirtySecondsPerQuarter: 8 } },
        { tick: 0, event: { kind: 'keySignature', sharpsOrFlats: -2, minor: true } },
        { tick: 960, event: { kind: 'tempo', microsecondsPerQuarter: 600000 } },
      ],
    },
    {
      events: [
        { tick: 0, event: { kind: 'programChange', channel: 0, program: 24 } },
        { tick: 0, event: { kind: 'noteOn', channel: 0, key: 76, velocity: 80 } },
        { tick: 240, event: { kind: 'noteOff', channel: 0, key: 76, velocity: 0 } },
        { tick: 240, event: { kind: 'noteOn', channel: 0, key: 75, velocity: 70 } },
        { tick: 240, event: { kind: 'controlChange', channel: 0, controller: 64, value: 127 } },
        { tick: 300, event: { kind: 'pitchBend', channel: 0, value: -8192 } },
        { tick: 301, event: { kind: 'pitchBend', channel: 0, value: 8191 } },
        { tick: 302, event: { kind: 'channelPressure', channel: 0, pressure: 40 } },
        { tick: 303, event: { kind: 'polyPressure', channel: 0, key: 75, pressure: 41 } },
        { tick: 480, event: { kind: 'noteOff', channel: 0, key: 75, velocity: 10 } },
        { tick: 70000, event: { kind: 'controlChange', channel: 0, controller: 64, value: 0 } },
      ],
    },
  ],
};

test('what AnyTune writes, midi-file reads as the same events at the same ticks — the header too', () => {
  const data = parseMidi(writeMidiFile(FILE));
  assert.equal(data.header.format, 1);
  assert.equal(data.header.ticksPerBeat, 480);
  assert.deepEqual(neutralTheirs(data), neutralOurs({ ...FILE, tracks: FILE.tracks.map((t) => ({ events: [...t.events, { tick: t.events.at(-1)?.tick ?? 0, event: { kind: 'endOfTrack' } }] })) }));
});

test('what midi-file writes — with running status and velocity-0 note-ons — AnyTune reads as the same events', () => {
  const data = parseMidi(writeMidiFile(FILE));
  const bytes = Uint8Array.from(writeMidi(data, { running: true, useByte9ForNoteOff: true }));
  // running status and byte-9 note-offs really are in their bytes: they are shorter than ours
  assert.ok(bytes.length < writeMidiFile(FILE).length);
  const read = readMidiFile(bytes);
  if (!read.ok) assert.fail(read.reason);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(neutralOurs(read.file), neutralTheirs(data));
});

test('the SMPTE division agrees with midi-file: 25 fps and 40 ticks per frame either way, written by either', () => {
  const smpte: MidiFile = { format: 0, division: { kind: 'smpte', framesPerSecond: 25, ticksPerFrame: 40 }, tracks: [{ events: [{ tick: 0, event: { kind: 'endOfTrack' } }] }] };
  const data = parseMidi(writeMidiFile(smpte));
  assert.equal(data.header.framesPerSecond, 25);
  assert.equal(data.header.ticksPerFrame, 40);
  const back = readMidiFile(Uint8Array.from(writeMidi(data)));
  if (!back.ok) assert.fail(back.reason);
  assert.deepEqual(back.file.division, smpte.division);
});
