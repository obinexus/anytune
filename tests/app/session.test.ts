/**
 * The application service: a tuning session holds AnyTune's state — session, instrument, reading, input — and moves it deterministically on the user's intents
 * (select an instrument, start, stop) and on the fusion's events. Framework-neutral: no Vue, no DOM; the fusion is injected. Failures are state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TuningSession } from '../../src/app/session.ts';
import type { AnyTuneState } from '../../src/app/session.ts';
import { toView } from '../../src/app/view.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { RecordedPitchFusion, SimulatedPitchFusion } from '../../src/fusion/pitch-fusion.ts';
import { parseRecording } from '../../src/audio/recording.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'pitch');
const recording = (name: string) => {
  const parsed = parseRecording(JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
  assert.ok(parsed.ok);
  return parsed.recording;
};
const simulated = (options: Parameters<typeof SimulatedPitchFusion>[1] = {}) => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock, options);
  const session = new TuningSession({ fusion: fusion.port, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  const mic = fusion.providers[0];
  assert.ok(mic);
  return { clock, session, mic };
};

test('the initial state: idle, Standard Guitar, no reading, no input', () => {
  const { session } = simulated();
  const state: AnyTuneState = session.getState();
  assert.deepEqual(state, {
    session: 'idle',
    instrumentId: 'guitar-standard',
    reading: null,
    stable: false,
    signal: 'none',
    input: { state: 'idle', connected: false, confidence: 0 },
    error: null,
    inputId: 'default',
    inputs: [{ id: 'default', label: 'Input' }],
  });
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.inputs) && Object.isFrozen(state.inputs[0]));
});

test('start: starting, then listening — and every pitch after that updates the reading with no further intent', async () => {
  const { session, mic } = simulated();
  const sessions: string[] = [];
  session.subscribe((s) => sessions.push(s.session));
  await session.start();
  assert.deepEqual(sessions, ['starting', 'listening']);
  assert.deepEqual(session.getState().input, { state: 'listening', connected: true, confidence: 0 });
  mic.hear(108, { confidence: 0.9 });
  assert.equal(session.getState().reading?.status, 'flat');
  mic.hear(110, { confidence: 0.92 });
  assert.equal(session.getState().reading?.status, 'in-tune');
  assert.deepEqual([session.getState().signal, session.getState().input.confidence], ['present', 0.92]);
});

test('the acceptance scenario, replayed: Standard Guitar, A2 — 108, 109, 110, 110 Hz give flat, flat, in tune, and in tune and stable', async () => {
  const clock = new ManualScheduler();
  const session = new TuningSession({ fusion: RecordedPitchFusion(recording('guitar-a2-acceptance'), clock), catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  await session.start();
  const steps: string[] = [];
  for (let i = 0; i < 4; i++) {
    clock.advance(i === 0 ? 0 : 250);
    const s = session.getState();
    steps.push(`${s.reading?.targetLabel} ${s.reading?.status} ${s.stable ? 'stable' : 'moving'}`);
  }
  assert.deepEqual(steps, ['A2 flat moving', 'A2 flat moving', 'A2 in-tune moving', 'A2 in-tune stable']);
  // the recording ends; the last reading stays, the session is idle again and the input is gone
  clock.advance(0);
  assert.deepEqual([session.getState().session, session.getState().input.state, session.getState().reading?.status], ['idle', 'ended', 'in-tune']);
});

test('silence clears the reading — no signal — and a pitch after it starts again from nothing', async () => {
  const { session, mic } = simulated();
  await session.start();
  mic.hear(110);
  mic.hear(110);
  assert.equal(session.getState().stable, true);
  mic.silence();
  assert.deepEqual([session.getState().reading, session.getState().stable, session.getState().signal], [null, false, 'none']);
  mic.hear(110);
  assert.equal(session.getState().stable, false, 'stability is counted again after silence');
});

test('low confidence: the reading is uncertain, and the signal is said to be so', async () => {
  const { session, mic } = simulated();
  await session.start();
  mic.hear(108, { confidence: 0.3 });
  assert.deepEqual([session.getState().reading?.status, session.getState().signal, session.getState().input.confidence], ['uncertain', 'uncertain', 0.3]);
});

test('an input that fails is an error state, never an exception: permission denied, no device, disconnected', async () => {
  for (const outcome of ['permission-denied', 'no-device'] as const) {
    const { session } = simulated({ startOutcome: outcome });
    await session.start();
    assert.deepEqual([session.getState().session, session.getState().error, session.getState().input.connected], ['error', { kind: outcome }, false]);
  }
  const { session, mic } = simulated();
  await session.start();
  mic.hear(110);
  mic.disconnect();
  assert.deepEqual([session.getState().session, session.getState().error, session.getState().input], ['error', { kind: 'disconnected' }, { state: 'disconnected', connected: false, confidence: 0 }]);
  assert.equal(session.getState().reading, null);
});

test('no source at all: the fusion is unavailable, and that is an error state', async () => {
  const { InverseVarianceFusion } = await import('../../src/fusion/pitch-fusion.ts');
  const session = new TuningSession({ fusion: new InverseVarianceFusion([], new ManualScheduler()), catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  await session.start();
  assert.deepEqual([session.getState().session, session.getState().error], ['error', { kind: 'unavailable' }]);
});

test('an unsupported instrument and an invalid tuning are errors before anything listens', async () => {
  const unknown = simulated();
  unknown.session.selectInstrument('banjo-17-string');
  assert.deepEqual([unknown.session.getState().instrumentId, unknown.session.getState().error], ['guitar-standard', { kind: 'unsupported-instrument', detail: 'banjo-17-string' }]);
  await unknown.session.start();
  assert.equal(unknown.session.getState().session, 'listening', 'the valid instrument that was kept still tunes');

  const clock = new ManualScheduler();
  const broken = new TuningSession({
    fusion: SimulatedPitchFusion(clock).port,
    catalog: [{ id: 'broken', name: 'Broken', strings: [] }],
    policy: DEFAULT_POLICY,
    instrumentId: 'broken',
  });
  await broken.start();
  assert.deepEqual([broken.getState().session, broken.getState().error], ['error', { kind: 'invalid-tuning', detail: 'no-strings' }]);
  assert.deepEqual(broken.getState().input, { state: 'idle', connected: false, confidence: 0 }, 'nothing was started');
});

test('changing the instrument while listening tunes to the new one from the next pitch on', async () => {
  const { session, mic } = simulated();
  await session.start();
  mic.hear(110);
  session.selectInstrument('chromatic');
  assert.deepEqual([session.getState().instrumentId, session.getState().reading, session.getState().error], ['chromatic', null, null]);
  mic.hear(440);
  assert.equal(session.getState().reading?.targetLabel, 'A4');
});

test('stop: idle again, the reading cleared, the input stopped; and subscribers hear every change, until they unsubscribe', async () => {
  const { session, mic } = simulated();
  const seen: AnyTuneState[] = [];
  const off = session.subscribe((s) => seen.push(s));
  await session.start();
  mic.hear(110);
  await session.stop();
  assert.deepEqual([session.getState().session, session.getState().reading, session.getState().input.state], ['idle', null, 'stopped']);
  const count = seen.length;
  off();
  await session.start();
  assert.equal(seen.length, count);
});

test('deterministic: the same events give the same states, and a state that does not change is not published again', async () => {
  const run = async (): Promise<string[]> => {
    const { session, mic, clock } = simulated();
    const states: string[] = [];
    session.subscribe((s) => states.push(JSON.stringify(s)));
    await session.start();
    for (const hz of [108, 109, 110, 110, 111]) {
      clock.advance(250);
      mic.hear(hz);
    }
    mic.silence();
    mic.silence();
    return states;
  };
  const a = await run();
  assert.deepEqual(a, await run());
  assert.equal(new Set(a.slice(-2)).size, 2, 'the second silence changed nothing and published nothing');
});

test('the view: what the UI shows, formatted here and not in the components — note, frequency, cents in words, status, needle, confidence', async () => {
  const { session, mic } = simulated();
  const idle = toView(session.getState(), CATALOG);
  assert.deepEqual(
    { note: idle.note, frequencyText: idle.frequencyText, statusText: idle.statusText, sessionText: idle.sessionText, summaryText: idle.summaryText, hasReading: idle.hasReading },
    { note: '–', frequencyText: '— Hz', statusText: 'No signal', sessionText: 'Not listening', summaryText: 'Standard Guitar', hasReading: false },
  );
  assert.deepEqual(
    idle.instruments.map((i) => [i.id, i.selected]),
    CATALOG.map((t) => [t.id, t.id === 'guitar-standard']),
  );
  await session.start();
  mic.hear(108, { confidence: 0.95 });
  const flat = toView(session.getState(), CATALOG);
  assert.deepEqual(
    [flat.note, flat.octaveText, flat.targetText, flat.frequencyText, flat.centsText, flat.status, flat.statusText, flat.needlePercent, flat.confidencePercent, flat.confidenceText, flat.summaryText, flat.sessionText],
    ['A', '2', 'A2', '108.0 Hz', '31.8 cents flat', 'flat', 'Flat', 18.2, 95, '95% confidence', 'Standard Guitar · A2', 'Listening'],
  );
  mic.hear(111.5);
  const sharp = toView(session.getState(), CATALOG);
  assert.deepEqual([sharp.centsText, sharp.statusText, sharp.needlePercent], ['23.4 cents sharp', 'Sharp', 73.4]);
  mic.hear(110);
  assert.deepEqual([toView(session.getState(), CATALOG).centsText, toView(session.getState(), CATALOG).statusText], ['0.0 cents', 'In tune']);
  mic.hear(200, { confidence: 0.2 });
  assert.equal(toView(session.getState(), CATALOG).statusText, 'Signal uncertain');
  mic.hear(60);
  assert.equal(toView(session.getState(), CATALOG).needlePercent, 0, 'the needle stops at the end of its scale, 50 cents either way');
});

test('the view of the failures says what happened in words', async () => {
  const texts: string[] = [];
  for (const outcome of ['permission-denied', 'no-device'] as const) {
    const { session } = simulated({ startOutcome: outcome });
    await session.start();
    texts.push(toView(session.getState(), CATALOG).errorText);
  }
  const { session, mic } = simulated();
  await session.start();
  mic.disconnect();
  texts.push(toView(session.getState(), CATALOG).errorText);
  session.selectInstrument('banjo-17-string');
  texts.push(toView(session.getState(), CATALOG).errorText);
  assert.deepEqual(texts, [
    'Microphone permission was denied. Allow the microphone to tune.',
    'No microphone was found. Connect one to tune.',
    'The input was disconnected. Start again to tune.',
    'This instrument is not supported: banjo-17-string.',
  ]);
});
