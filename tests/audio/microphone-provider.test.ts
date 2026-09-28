/**
 * M3 — the lifecycle of MicrophonePitchProvider, on a faked browser (tests/support/fake-audio.ts): no microphone is needed, and none is used.
 *
 *   start   asks for the microphone (with as little of the browser's voice processing as it will allow), builds an analyser on it, says it listens, and from
 *           then on reads a frame every 50 ms, detects its pitch and publishes it as a PitchObservation
 *   stop    stops reading, disconnects the nodes, stops the tracks, closes the context — and publishes nothing after
 *
 * Starting and stopping, however often, leaks nothing: no track, context, node, timer or listener is left behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MICROPHONE_CONSTRAINTS, MicrophonePitchProvider, microphoneVarianceHz2 } from '../../src/audio/microphone-provider.ts';
import { DETECTOR_FRAME_SIZE } from '../../src/audio/pitch-detector.ts';
import type { ProviderEvent } from '../../src/domain/ports.ts';
import { FakeBrowser, silentSignal, sineSignal } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

function setup(options: ConstructorParameters<typeof FakeBrowser>[1] = {}) {
  const clock = new ManualScheduler();
  clock.advance(1000); // the analyser holds the last frame before now: give it a past
  const browser = new FakeBrowser(clock, options);
  const mic = new MicrophonePitchProvider(browser.environment, clock);
  const events: ProviderEvent[] = [];
  mic.subscribe((e) => events.push(e));
  const states = () => events.filter((e) => e.kind === 'state').map((e) => (e.kind === 'state' ? e.state : ''));
  const observations = () => events.flatMap((e) => (e.kind === 'observation' ? [e.observation] : []));
  return { clock, browser, mic, events, states, observations };
}
const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);

test('start asks for the microphone with the browser’s voice processing off where it can be — echo cancellation, noise suppression, automatic gain — as preferences, never requirements', async () => {
  const { browser, mic, states } = setup();
  await mic.start();
  assert.deepEqual(browser.requests, [MICROPHONE_CONSTRAINTS]);
  assert.deepEqual(MICROPHONE_CONSTRAINTS, { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  assert.deepEqual(states(), ['starting', 'listening']);
  // one context, the microphone's source feeding an analyser of the detector's frame — and nothing to the speakers
  const [context] = browser.contexts;
  assert.ok(context);
  assert.equal(context.analysers[0]?.fftSize, DETECTOR_FRAME_SIZE);
  assert.deepEqual(context.sources[0]?.connectedTo, [context.analysers[0]]);
});

test('listening: a frame every 50 ms, its pitch published as an observation of the source "microphone" — the frequency, the detector’s confidence, the time', async () => {
  const { clock, browser, mic, observations } = setup();
  browser.signal = sineSignal(110);
  await mic.start();
  clock.advance(200);
  const seen = observations();
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((o) => o.timestampMs), [1050, 1100, 1150, 1200]);
  for (const o of seen) {
    assert.equal(o.sourceId, 'microphone');
    assert.ok(Math.abs(cents(o.frequencyHz, 110)) <= 1, String(o.frequencyHz));
    assert.ok(o.confidence >= 0.9);
    assert.equal(o.varianceHz2, microphoneVarianceHz2(o.frequencyHz, 48000));
  }
});

test('the variance of a microphone pitch: what a period known to one sample implies — (f² / rate)² / 12 Hz² — documented, positive, and the same model at every rate', () => {
  // a period of P samples known to ±½ sample, uniformly: σ_P² = 1/12; f = rate / P, so σ_f = f² / rate · σ_P
  assert.equal(microphoneVarianceHz2(110, 48000), (110 ** 2 / 48000) ** 2 / 12);
  assert.ok(microphoneVarianceHz2(440, 44100) > microphoneVarianceHz2(110, 44100), 'a higher note spans fewer samples a period');
  assert.ok(microphoneVarianceHz2(110, 44100) > microphoneVarianceHz2(110, 48000), 'a lower rate resolves a period less finely');
});

test('silence publishes nothing — and when a pitch fades out, one silence event says so, not one a frame', async () => {
  const { clock, browser, mic, events } = setup();
  await mic.start();
  clock.advance(200);
  assert.deepEqual(events.filter((e) => e.kind !== 'state'), []);
  browser.signal = sineSignal(196);
  clock.advance(100);
  browser.signal = silentSignal;
  clock.advance(500);
  assert.deepEqual(events.filter((e) => e.kind !== 'state').map((e) => e.kind), ['observation', 'observation', 'silence']);
});

test('stop: no more frames read, the nodes disconnected, the tracks stopped, the context closed, no timer left — and nothing published after it', async () => {
  const { clock, browser, mic, events, states } = setup();
  browser.signal = sineSignal(110);
  await mic.start();
  clock.advance(100);
  await mic.stop();
  const count = events.length;
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
  assert.equal(clock.pending, 0);
  assert.equal(browser.tracks[0]?.listeners, 0, 'the listener for the end of the track is removed');
  clock.advance(1000);
  assert.equal(events.length, count);
  assert.equal(states().at(-1), 'stopped');
});

test('start and stop are idempotent, and any number of rounds of them leaks nothing', async () => {
  const { clock, browser, mic, states } = setup();
  await Promise.all([mic.start(), mic.start()]);
  await mic.start();
  assert.equal(browser.requests.length, 1, 'one request for the microphone');
  assert.equal(browser.contexts.length, 1);
  await mic.stop();
  await mic.stop();
  assert.deepEqual(states(), ['starting', 'listening', 'stopped']);
  for (let round = 0; round < 5; round++) {
    await mic.start();
    clock.advance(120);
    await mic.stop();
  }
  assert.equal(browser.contexts.length, 6);
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
  assert.equal(clock.pending, 0);
  await mic.stop();
  assert.equal(new MicrophonePitchProvider(browser.environment, clock).id, 'microphone');
});

test('stopped while the permission is asked: the stream granted afterwards is released at once, and nothing listens', async () => {
  const { browser, mic, states } = setup({ manualGrant: true });
  const starting = mic.start();
  await mic.stop();
  browser.grant();
  await starting;
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
  assert.equal(browser.contexts.length, 0, 'no context was made for a stream nobody wants');
  assert.deepEqual(states(), ['starting', 'stopped']);
});

test('a context the browser starts suspended is resumed; what is recorded of the input: the sample rate used, the device, and the processing the browser reports', async () => {
  const { browser, mic } = setup({ startSuspended: true, sampleRate: 44100 });
  assert.equal(mic.info, null, 'nothing is known before start');
  await mic.start();
  assert.equal(browser.contexts[0]?.resumed, 1);
  assert.deepEqual(mic.info, { sampleRate: 44100, device: 'Fake microphone', processing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, mode: 'raw' });
  await mic.stop();
});

test('a browser that does not report its processing is not an error: what is unknown is said to be unknown', async () => {
  const { mic } = setup({ settings: {} });
  await mic.start();
  assert.deepEqual(mic.info?.processing, { echoCancellation: null, noiseSuppression: null, autoGainControl: null });
  await mic.stop();
});

test('an observer that unsubscribes hears nothing more; the others go on hearing', async () => {
  const { clock, browser, mic } = setup();
  browser.signal = sineSignal(110);
  const a: ProviderEvent[] = [];
  const b: ProviderEvent[] = [];
  const offA = mic.subscribe((e) => a.push(e));
  mic.subscribe((e) => b.push(e));
  await mic.start();
  clock.advance(100);
  offA();
  const before = a.length;
  clock.advance(100);
  assert.equal(a.length, before);
  assert.ok(b.length > before);
  await mic.stop();
});
