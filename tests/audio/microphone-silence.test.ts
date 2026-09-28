/**
 * A microphone that sends no sound at all. Found on a real laptop — an AMD microphone array in Firefox, which AnyTune opened and "listened" to while every
 * sample was zero (the owner's measurement: loudest −154 dBFS). A real microphone is never digitally silent: it always has a noise floor, far above −120 dBFS.
 * So two seconds of digital silence mean the audio is not arriving:
 *
 *   - asked for raw audio (no echo cancellation, noise suppression or automatic gain), the provider asks once more with the browser's processing on — some
 *     laptop microphone arrays give sound only through it — and says so: the input is then "browser processing on";
 *   - still silent, it is a failure, `microphone-muted`, said in words — never "Listening" over a microphone that sends nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIGITAL_SILENCE_MS, MICROPHONE_CONSTRAINTS, MicrophonePitchProvider, PROCESSED_MICROPHONE_CONSTRAINTS } from '../../src/audio/microphone-provider.ts';
import type { ProviderEvent } from '../../src/domain/ports.ts';
import { TuningSession } from '../../src/app/session.ts';
import { toView } from '../../src/app/view.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { InverseVarianceFusion } from '../../src/fusion/pitch-fusion.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { FakeBrowser, sineSignal } from '../support/fake-audio.ts';
import type { FakeBrowserOptions, Signal } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

async function listening(options: FakeBrowserOptions) {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, { signal: sineSignal(110), ...options });
  const mic = new MicrophonePitchProvider(browser.environment, clock);
  const events: ProviderEvent[] = [];
  mic.subscribe((e) => events.push(e));
  await mic.start();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { clock, browser, mic, events, settle, states: () => events.flatMap((e) => (e.kind === 'state' ? [e.state] : [])) };
}

test('two seconds is the patience: long enough for a pause between plucks to never count — a pause is not silence, a microphone always has a noise floor', () => {
  assert.equal(DIGITAL_SILENCE_MS, 2000);
  assert.deepEqual(PROCESSED_MICROPHONE_CONSTRAINTS, { audio: true, video: false });
});

test('a microphone silent in raw mode: after two seconds the provider asks again with the browser’s processing on, the pitch is read, and the input says so', async () => {
  const { clock, browser, mic, events, settle, states } = await listening({ silentWhen: 'raw' });
  clock.advance(DIGITAL_SILENCE_MS - 100);
  await settle();
  assert.equal(browser.requests.length, 1, 'not before two seconds');
  clock.advance(200);
  await settle();
  assert.deepEqual(browser.requests, [MICROPHONE_CONSTRAINTS, PROCESSED_MICROPHONE_CONSTRAINTS]);
  assert.deepEqual(browser.held, { tracks: 1, contexts: 1, nodes: 2 }, 'the silent stream was given back; one stream is held');
  assert.equal(mic.info?.mode, 'processed');
  assert.deepEqual(mic.info?.processing, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  clock.advance(300);
  const observations = events.filter((e) => e.kind === 'observation');
  assert.ok(observations.length > 0, 'the pitch is read through the processed stream');
  assert.deepEqual(states(), ['starting', 'listening'], 'listening all along: the retry is not a failure');
  await mic.stop();
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
});

test('a microphone silent even with the browser’s processing: microphone-muted, everything given back, nothing published after', async () => {
  const { clock, browser, settle, states } = await listening({ silentWhen: 'always' });
  clock.advance(DIGITAL_SILENCE_MS + 100);
  await settle();
  clock.advance(DIGITAL_SILENCE_MS + 100);
  await settle();
  assert.deepEqual(states(), ['starting', 'listening', 'microphone-muted']);
  assert.equal(browser.requests.length, 2);
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
  assert.equal(clock.pending, 0);
});

test('a quiet room is not digital silence: a noise floor at −70 dBFS, however long, is heard as no pitch — never as a muted microphone', async () => {
  const floor: Signal = (t) => {
    let h = Math.imul(Math.round(t * 48000) ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return 0.00055 * ((((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1); // RMS ≈ 3.2e-4 ≈ −70 dBFS
  };
  const { clock, browser, settle, states, mic } = await listening({ signal: floor });
  clock.advance(10_000);
  await settle();
  assert.equal(browser.requests.length, 1);
  assert.deepEqual(states(), ['starting', 'listening']);
  await mic.stop();
});

test('a sound between silences resets the patience: silence must last two seconds in a row', async () => {
  let on = false;
  const { clock, browser, settle } = await listening({ signal: (t) => (on ? 0.3 * Math.sin(2 * Math.PI * 110 * t) : 0) });
  for (let i = 0; i < 4; i++) {
    clock.advance(1500);
    on = true;
    clock.advance(100);
    on = false;
    await settle();
  }
  assert.equal(browser.requests.length, 1);
});

test('the session and the page: a microphone that sends no sound is said to be muted, and where to look', async () => {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, { silentWhen: 'always' });
  const mic = new MicrophonePitchProvider(browser.environment, clock);
  const session = new TuningSession({ fusion: new InverseVarianceFusion([mic], clock), catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  await session.start();
  for (let i = 0; i < 2; i++) {
    clock.advance(DIGITAL_SILENCE_MS + 100);
    for (let j = 0; j < 6; j++) await Promise.resolve();
  }
  const view = toView(session.getState(), CATALOG, '', { kind: 'microphone', name: 'Fake microphone, 48 kHz' });
  assert.equal(session.getState().error?.kind, 'microphone-muted');
  assert.equal(view.inputText, 'Microphone sends no sound');
  assert.equal(view.errorText, 'The microphone is sending no sound at all — it may be muted. Check the microphone mute key, and your system’s microphone privacy settings (on Windows: Settings → Privacy & security → Microphone → “Let desktop apps access your microphone”). Then start again.');
});

test('the page says when the browser’s processing is on: the input names the microphone, its rate, and that — as the demo composes it', async () => {
  const { composeAnyTune } = await import('../../src/harness/compose.ts');
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, { signal: sineSignal(110), silentWhen: 'raw' });
  const app = composeAnyTune({ clock, microphone: browser.environment });
  await app.session.selectInput('microphone');
  await app.session.start();
  assert.equal(app.input().name, 'Fake microphone, 48 kHz');
  clock.advance(DIGITAL_SILENCE_MS + 100);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  clock.advance(300);
  assert.equal(app.input().name, 'Fake microphone, 48 kHz, browser processing on');
  assert.equal(app.session.getState().reading?.targetLabel, 'A2');
  await app.session.stop();
});

test('two separate silences: a tone below the musical threshold (−48 dBFS) is valid audio with no useful pitch — "No signal", still listening — never the device failure that only digital silence (−120 dBFS) is', async () => {
  // a real 110 Hz tone at −60 dBFS RMS: below the detector's silence, far above digital silence
  const faint: Signal = (t) => 0.001 * Math.SQRT2 * Math.sin(2 * Math.PI * 110 * t);
  const { clock, browser, events, settle, states, mic } = await listening({ signal: faint });
  clock.advance(10_000);
  await settle();
  assert.equal(events.filter((e) => e.kind === 'observation').length, 0, 'no pitch: below the musical silence threshold');
  assert.equal(browser.requests.length, 1, 'no retry: it is not digital silence');
  assert.deepEqual(states(), ['starting', 'listening'], 'no failure: the device works');
  await mic.stop();
});
