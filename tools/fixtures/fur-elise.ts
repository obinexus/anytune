/**
 * Writes tests/fixtures/midi/fur-elise-opening.mid: the opening phrase of Beethoven's "Für Elise" (WoO 59, 1810 — the composition is in the public domain),
 * encoded for AnyTune by hand from the score. It is written by midi-file (an independent implementation), not by AnyTune's own writer, so that the reader
 * under test is not reading its own output.
 *
 * What it holds, on purpose, for the round trip of milestone 2:
 *   - 3/8 time, A minor, 480 PPQ; ♩ = 72 for bars 1–4, a tempo change to ♩ = 60 at bar 5 (the phrase repeated, more slowly);
 *   - track 1, the right hand (channel 1): the melody, E5 D♯5 E5 B4 D5 C5 | A4 …, the part a guitarist learns first;
 *   - track 2, the left hand (channel 2): A2 E3 A3 and E2 E3 G♯3 under the melody — notes that sound at the same time as the melody's;
 *   - the sustain pedal on channel 2 through each left-hand figure;
 *   - one deliberate same-key overlap in the left hand (A2 struck again before its release), which the timeline flags.
 *
 *   node tools/fixtures/fur-elise.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeMidi, type MidiData, type MidiEvent } from 'midi-file';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PPQ = 480;
const S = PPQ / 4; // a sixteenth
const BAR = 6 * S; // 3/8

type Abs = { tick: number; order: number; event: Omit<MidiEvent, 'deltaTime'> };
const toTrack = (events: Abs[]): MidiEvent[] => {
  let last = 0;
  return events
    .sort((a, b) => a.tick - b.tick || a.order - b.order)
    .map(({ tick, event }) => {
      const out = { ...event, deltaTime: tick - last } as MidiEvent;
      last = tick;
      return out;
    });
};

// the right hand: [key or null for a rest, length in sixteenths], from the pickup
const E5 = 76, Ds5 = 75, B4 = 71, D5 = 74, C5 = 72, A4 = 69, C4 = 60, E4 = 64, Gs4 = 68;
const PHRASE: [number | null, number][] = [
  [E5, 1], [Ds5, 1],
  [E5, 1], [Ds5, 1], [E5, 1], [B4, 1], [D5, 1], [C5, 1],
  [A4, 2], [null, 1], [C4, 1], [E4, 1], [A4, 1],
  [B4, 2], [null, 1], [E4, 1], [Gs4, 1], [B4, 1],
  [C5, 2], [null, 1], [E4, 1], [E5, 1], [Ds5, 1],
];
const ENDING: [number | null, number][] = [
  [E5, 1], [Ds5, 1], [E5, 1], [B4, 1], [D5, 1], [C5, 1],
  [A4, 2], [null, 1], [C4, 1], [E4, 1], [A4, 1],
  [B4, 2], [null, 1], [E4, 1], [C5, 1], [B4, 1],
  [A4, 3],
];

const right: Abs[] = [{ tick: 0, order: 0, event: { type: 'trackName', text: 'Right hand (melody)' } as never }];
let at = 0;
let order = 1;
for (const [key, sixteenths] of [...PHRASE, ...ENDING]) {
  const length = sixteenths * S;
  if (key !== null) {
    // legato, but released 10 ticks early so that repeated keys never touch
    right.push({ tick: at, order: order++, event: { type: 'noteOn', channel: 0, noteNumber: key, velocity: 72 } as never });
    right.push({ tick: at + length - 10, order: order++, event: { type: 'noteOff', channel: 0, noteNumber: key, velocity: 0 } as never });
  }
  at += length;
}
const end = at;
right.push({ tick: end, order: order++, event: { type: 'endOfTrack' } as never });

// the left hand: a figure in each bar after the pickup's downbeat — bar 2 (A minor), bar 3 (E major), bar 6, bar 7
const A2 = 45, E3 = 52, A3 = 57, E2 = 40, Gs3 = 56;
const pickup = 2 * S;
const left: Abs[] = [{ tick: 0, order: 0, event: { type: 'trackName', text: 'Left hand' } as never }];
order = 1;
const figure = (bar: number, keys: [number, number, number]): void => {
  const start = pickup + bar * BAR;
  left.push({ tick: start, order: order++, event: { type: 'controller', channel: 1, controllerType: 64, value: 127 } as never });
  keys.forEach((key, i) => {
    left.push({ tick: start + i * S, order: order++, event: { type: 'noteOn', channel: 1, noteNumber: key, velocity: 56 } as never });
    left.push({ tick: start + i * S + 2 * S, order: order++, event: { type: 'noteOff', channel: 1, noteNumber: key, velocity: 0 } as never });
  });
  left.push({ tick: start + BAR - S, order: order++, event: { type: 'controller', channel: 1, controllerType: 64, value: 0 } as never });
};
figure(1, [A2, E3, A3]);
figure(2, [E2, E3, Gs3]);
figure(5, [A2, E3, A3]);
figure(6, [E2, E3, Gs3]);
// the deliberate same-key overlap: A2 struck again in bar 6 a sixteenth before the one already sounding is released
left.push({ tick: pickup + 5 * BAR + S, order: order++, event: { type: 'noteOn', channel: 1, noteNumber: A2, velocity: 40 } as never });
left.push({ tick: pickup + 5 * BAR + 4 * S, order: order++, event: { type: 'noteOff', channel: 1, noteNumber: A2, velocity: 0 } as never });
left.push({ tick: end, order: order++, event: { type: 'endOfTrack' } as never });

const conductor: Abs[] = [
  { tick: 0, order: 0, event: { type: 'trackName', text: 'Für Elise (opening) — Beethoven, WoO 59' } as never },
  { tick: 0, order: 1, event: { type: 'timeSignature', numerator: 3, denominator: 8, metronome: 24, thirtyseconds: 8 } as never },
  { tick: 0, order: 2, event: { type: 'keySignature', key: 0, scale: 1 } as never },
  { tick: 0, order: 3, event: { type: 'setTempo', microsecondsPerBeat: Math.round(60e6 / 72) } as never },
  { tick: pickup + 4 * BAR, order: 4, event: { type: 'setTempo', microsecondsPerBeat: 1_000_000 } as never },
  { tick: end, order: 5, event: { type: 'endOfTrack' } as never },
];

const data: MidiData = { header: { format: 1, numTracks: 3, ticksPerBeat: PPQ }, tracks: [toTrack(conductor), toTrack(right), toTrack(left)] };
const out = path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Uint8Array.from(writeMidi(data, { running: true, useByte9ForNoteOff: true })));
console.log(`${path.relative(ROOT, out)}: ${fs.statSync(out).size} bytes`);
