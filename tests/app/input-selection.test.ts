/**
 * M5 — the input is chosen in the application service: the session is given its inputs (each a PitchFusionPort, with an id and a label) and the user's
 * intent selects one. Only the active input's events move the state. Changing the input while listening stops the one that was listening: the session is
 * idle again, and Start begins the new one — the microphone's permission is never asked for without a press of Start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrophonePitchProvider } from '../../src/audio/microphone-provider.ts';
import { TuningSession } from '../../src/app/session.ts';
import type { AnyTuneState } from '../../src/app/session.ts';
import { toView } from '../../src/app/view.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { InverseVarianceFusion, SimulatedPitchFusion } from '../../src/fusion/pitch-fusion.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { DemoInput } from '../../src/harness/demo-input.ts';
import { FakeBrowser, sineSignal } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

function app() {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, { signal: sineSignal(110 * 2 ** (-12 / 1200)) }); // the A string 12 cents flat
  const mic = new MicrophonePitchProvider(browser.environment, clock);
  const demo = new DemoInput(clock, 'guitar-standard');
  const session = new TuningSession({
    inputs: [
      { id: 'microphone', label: 'Microphone', fusion: new InverseVarianceFusion([mic], clock, { windowMs: 100 }) },
      { id: 'demo', label: 'Demo (recorded / simulated)', fusion: demo },
    ],
    inputId: 'demo',
    catalog: CATALOG,
    policy: DEFAULT_POLICY,
    instrumentId: 'guitar-standard',
  });
  const states: AnyTuneState[] = [];
  session.subscribe((s) => states.push(s));
  return { clock, browser, session, states };
}

test('the inputs are in the state — which exist, in order, and which is active — and in the view, as the options of a selector', () => {
  const { session } = app();
  const state = session.getState();
  assert.equal(state.inputId, 'demo');
  assert.deepEqual(state.inputs, [{ id: 'microphone', label: 'Microphone' }, { id: 'demo', label: 'Demo (recorded / simulated)' }]);
  const view = toView(state, CATALOG);
  assert.equal(view.inputId, 'demo');
  assert.deepEqual(view.inputOptions, [{ id: 'microphone', label: 'Microphone', selected: false }, { id: 'demo', label: 'Demo (recorded / simulated)', selected: true }]);
});

test('choose the microphone, press Start: the microphone is asked for — not the demo — and its pitch is read: A2, 12 cents flat', async () => {
  const { clock, browser, session } = app();
  session.selectInput('microphone');
  assert.equal(session.getState().inputId, 'microphone');
  assert.equal(browser.requests.length, 0, 'choosing the input asks nothing of the browser');
  await session.start();
  clock.advance(200);
  const reading = session.getState().reading;
  assert.ok(reading);
  assert.deepEqual([reading.targetLabel, reading.status, Math.round(reading.cents)], ['A2', 'flat', -12]);
  assert.equal(browser.requests.length, 1);
});

test('switching Recorded → Microphone while listening: the demo stops, the session is idle with no reading, and nothing the demo would still have played arrives', async () => {
  const { clock, browser, session, states } = app();
  await session.start();
  clock.advance(300); // two readings of the acceptance sequence
  assert.equal(session.getState().reading?.detectedFrequencyHz, 109);
  await session.selectInput('microphone');
  assert.deepEqual([session.getState().session, session.getState().reading, session.getState().inputId], ['idle', null, 'microphone']);
  const count = states.length;
  clock.advance(2000); // the rest of the recording would have played now
  assert.equal(states.length, count, 'the stopped demo moves nothing');
  assert.equal(browser.requests.length, 0, 'and the microphone waits for Start');
  await session.start();
  clock.advance(200);
  assert.equal(session.getState().reading?.status, 'flat');
});

test('switching Microphone → Recorded while listening: the microphone is released — its track stopped, its context closed — and the demo plays at the next Start', async () => {
  const { clock, browser, session } = app();
  session.selectInput('microphone');
  await session.start();
  clock.advance(200);
  await session.selectInput('demo');
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
  assert.equal(clock.pending, 0);
  await session.start();
  clock.advance(2000);
  assert.deepEqual([session.getState().reading?.detectedFrequencyHz, session.getState().stable], [110, true]);
});

test('an input the session does not have is an error, and the input does not change; the same input again changes nothing', async () => {
  const { session, states } = app();
  await session.selectInput('bluetooth');
  assert.deepEqual([session.getState().error?.kind, session.getState().error?.detail, session.getState().inputId], ['unsupported-input', 'bluetooth', 'demo']);
  await session.selectInput('microphone');
  assert.equal(session.getState().error, null, 'a valid choice clears it');
  const count = states.length;
  await session.selectInput('microphone');
  assert.equal(states.length, count);
});

test('a session given one fusion, as before: one input, "default" — nothing else about it changes', () => {
  const clock = new ManualScheduler();
  const session = new TuningSession({ fusion: SimulatedPitchFusion(clock).port, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  assert.equal(session.getState().inputId, 'default');
  assert.deepEqual(session.getState().inputs, [{ id: 'default', label: 'Input' }]);
});
