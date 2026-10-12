/**
 * A9 — the input of the browser demo (src/harness/demo-input.ts): a PitchFusionPort that, at each start, plays the input made for the chosen instrument —
 * a recording for Standard Guitar (the directive's acceptance sequence) and for Chromatic (A4 at 440 Hz), a simulation of its first string rising to pitch
 * for every other instrument — and says which. It needs no native library and no microphone. The session, the domain and the UI are those of the application.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TuningSession } from '../../src/app/session.ts';
import type { AnyTuneState } from '../../src/app/session.ts';
import { parseRecording } from '../../src/audio/recording.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { DEMO_RECORDINGS, DemoInput } from '../../src/harness/demo-input.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function demo(instrumentId: string) {
  const clock = new ManualScheduler();
  const input = new DemoInput(clock, instrumentId);
  const session = new TuningSession({ fusion: input, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId });
  const states: AnyTuneState[] = [];
  session.subscribe((s) => states.push(s));
  session.subscribe((s) => input.select(s.instrumentId));
  return { clock, input, session, states };
}

/** Each distinct reading, as `note octave frequency status[ stable]` — what the UI shows as the pitches come. */
const readings = (states: readonly AnyTuneState[]): string[] => {
  const out: string[] = [];
  for (const s of states) {
    if (s.reading === null) continue;
    const said = `${s.reading.note}${s.reading.octave} ${s.reading.detectedFrequencyHz.toFixed(1)} ${s.reading.status}${s.stable ? ' stable' : ''}`;
    if (out[out.length - 1] !== said) out.push(said);
  }
  return out;
};

test('what the demo plays for each instrument, and what it says it plays: recordings for the guitar and the chromatic tuning, a simulation for the others', () => {
  const said = Object.fromEntries(CATALOG.map((t) => [t.id, new DemoInput(new ManualScheduler(), t.id).source]));
  assert.deepEqual(said, {
    'guitar-standard': { kind: 'recorded', name: 'Standard Guitar, the A string rising to pitch: 108, 109, 110, 110 Hz (simulated data)' },
    'bass-standard': { kind: 'simulated', name: 'Standard Bass, the E1 string rising to pitch' },
    violin: { kind: 'simulated', name: 'Violin, the G3 string rising to pitch' },
    'ukulele-standard': { kind: 'simulated', name: 'Standard Ukulele, the G4 string rising to pitch' },
    chromatic: { kind: 'recorded', name: 'A4, 440 Hz (simulated data)' },
  });
});

test('the demo’s recordings are AnyTune recordings, of the simulated origin — the guitar’s is the committed acceptance fixture itself', () => {
  for (const recording of Object.values(DEMO_RECORDINGS)) {
    const parsed = parseRecording(JSON.parse(JSON.stringify(recording)));
    assert.ok(parsed.ok);
    assert.equal(parsed.recording.origin, 'simulated');
  }
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pitch', 'guitar-a2-acceptance.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(DEMO_RECORDINGS['guitar-standard'])), fixture);
});

test('Standard Guitar, hands-free: one start, and 108, 109, 110, 110 Hz are flat, flat, in tune, and in tune and steady — then the recording ends', async () => {
  const { clock, session, states } = demo('guitar-standard');
  await session.start();
  clock.advance(2000);
  assert.deepEqual(readings(states), ['A2 108.0 flat', 'A2 109.0 flat', 'A2 110.0 in-tune', 'A2 110.0 in-tune stable']);
  assert.equal(session.getState().input.state, 'ended');
});

test('Chromatic, hands-free: 440 Hz is A4, in tune — through the generic pitch model, with no string to capture it', async () => {
  const { clock, session, states } = demo('chromatic');
  await session.start();
  clock.advance(2000);
  const last = session.getState().reading;
  assert.ok(last);
  assert.deepEqual([last.note, last.octave, last.status, Math.abs(last.cents) < 1e-9], ['A', 4, 'in-tune', true]);
  assert.ok(readings(states).includes('A4 440.0 in-tune stable'));
});

test('another instrument, simulated: its first string, heard flat, then sharp, then in tune and steady — and the input stays connected', async () => {
  const { clock, session, states } = demo('bass-standard');
  await session.start();
  clock.advance(3000);
  const seen = readings(states);
  assert.deepEqual(seen.map((r) => r.split(' ')[0]), seen.map(() => 'E1'));
  assert.deepEqual(seen.map((r) => r.split(' ').slice(2).join(' ')), ['flat', 'sharp', 'in-tune', 'in-tune stable']);
  assert.equal(session.getState().input.state, 'listening');
});

test('the instrument chosen while idle is what the next start plays; the input said is the one playing', async () => {
  const { clock, input, session, states } = demo('bass-standard');
  session.selectInstrument('chromatic');
  assert.equal(input.source.kind, 'recorded');
  await session.start();
  clock.advance(2000);
  assert.ok(readings(states).at(-1)?.startsWith('A4 440.0'));
  await session.stop();
  session.selectInstrument('guitar-standard');
  assert.equal(input.source.name.startsWith('Standard Guitar'), true);
  await session.start();
  clock.advance(2000);
  assert.equal(readings(states).at(-1), 'A2 110.0 in-tune stable');
});

test('a recording that has ended plays no more: the input said is then what the next start will play — for the instrument chosen since', async () => {
  const { clock, input, session } = demo('guitar-standard');
  await session.start();
  clock.advance(2000);
  assert.equal(session.getState().input.state, 'ended');
  session.selectInstrument('violin');
  assert.deepEqual(input.source, { kind: 'simulated', name: 'Violin, the G3 string rising to pitch' });
  // while it plays, the input said is what plays, whatever is chosen meanwhile
  await session.start();
  session.selectInstrument('chromatic');
  assert.equal(input.source.name, 'Violin, the G3 string rising to pitch');
});

test('stop stops what is playing: nothing is heard after it', async () => {
  const { clock, session, states } = demo('guitar-standard');
  await session.start();
  clock.advance(300);
  await session.stop();
  const count = states.length;
  clock.advance(5000);
  assert.equal(states.length, count);
});
