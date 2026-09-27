/**
 * M4 — a microphone's failures in the application's state and in words: each is an error of the session with its own kind, and the view says it plainly —
 * never a browser's exception text. And the two states that are not failures: no signal (silence) and low confidence (a noisy room).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrophonePitchProvider } from '../../src/audio/microphone-provider.ts';
import { TuningSession } from '../../src/app/session.ts';
import { toView } from '../../src/app/view.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { SOURCE_FAILURES } from '../../src/domain/ports.ts';
import { InverseVarianceFusion } from '../../src/fusion/pitch-fusion.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { FakeBrowser, sineSignal } from '../support/fake-audio.ts';
import type { FakeBrowserOptions, Signal } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

function session(options: FakeBrowserOptions) {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, options);
  const mic = new MicrophonePitchProvider(browser.environment, clock);
  const fusion = new InverseVarianceFusion([mic], clock, { windowMs: 100 });
  const s = new TuningSession({ fusion, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  return { clock, browser, s, view: () => toView(s.getState(), CATALOG, '', { kind: 'microphone', name: 'Fake microphone' }) };
}

test('the input failures are one list, the domain’s: permission, device, disconnection — and what a microphone adds: an insecure page, an unsupported browser, a microphone that cannot be opened, audio that cannot start', () => {
  assert.deepEqual([...SOURCE_FAILURES], ['permission-denied', 'no-device', 'disconnected', 'insecure-context', 'unsupported', 'microphone-unavailable', 'audio-failed']);
});

test('each failure is an error of the session, said in words — the browser’s own exception text never reaches the page', async () => {
  const cases: [FakeBrowserOptions, string, string, string][] = [
    [{ secureContext: false }, 'insecure-context', 'Microphone needs a secure page', 'The microphone works only on a secure page: https, or localhost. Open AnyTune over https to tune with it.'],
    [{ noMediaDevices: true }, 'unsupported', 'Microphone not supported', 'This browser cannot give AnyTune the microphone. Use a current Edge, Chrome, Firefox or Safari — or the demo input.'],
    [{ refuse: 'NotAllowedError' }, 'permission-denied', 'Microphone permission denied', 'Microphone permission was denied. Allow the microphone to tune.'],
    [{ refuse: 'NotFoundError' }, 'no-device', 'No microphone', 'No microphone was found. Connect one to tune.'],
    [{ refuse: 'NotReadableError' }, 'microphone-unavailable', 'Microphone unavailable', 'The microphone could not be opened — another application may be using it. Close it, then start again.'],
    [{ audioContextThrows: true }, 'audio-failed', 'Audio could not start', 'The browser could not start its audio processing. Start again, or reload the page.'],
  ];
  for (const [options, kind, inputText, errorText] of cases) {
    const { s, view } = session(options);
    await s.start();
    await Promise.resolve();
    assert.equal(s.getState().session, 'error', kind);
    assert.equal(s.getState().error?.kind, kind);
    assert.deepEqual([view().inputText, view().errorText, view().hasError], [inputText, errorText, true], kind);
    assert.doesNotMatch(view().errorText, /fake|Error|DOMException/, kind);
  }
});

test('the microphone unplugged while tuning: the session says the input was disconnected, and clears the reading', async () => {
  const { clock, browser, s, view } = session({ signal: sineSignal(110) });
  await s.start();
  clock.advance(200);
  assert.equal(s.getState().reading?.status, 'in-tune');
  browser.tracks[0]?.unplug();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.getState().error?.kind, 'disconnected');
  assert.equal(s.getState().reading, null);
  assert.equal(view().errorText, 'The input was disconnected. Start again to tune.');
});

test('silence is no signal, not a failure; a noisy room is a low-confidence, uncertain reading — both said in words', async () => {
  const { clock, browser, s, view } = session({});
  await s.start();
  clock.advance(200);
  assert.deepEqual([s.getState().session, s.getState().signal, view().statusText], ['listening', 'none', 'No signal']);
  // a noisy room: white noise well above silence — a hash of the sample's index, so the same noise every run
  const noisy: Signal = (t) => {
    let h = Math.imul(Math.round(t * 48000) ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return 0.2 * (((h ^ (h >>> 16)) >>> 0) / 4294967296 * 2 - 1);
  };
  browser.signal = noisy;
  clock.advance(300);
  assert.equal(s.getState().signal, 'uncertain');
  assert.equal(view().statusText, 'Signal uncertain');
  assert.ok(s.getState().input.confidence < 0.6)
  // a clean A2 again: a confident reading
  browser.signal = sineSignal(110);
  clock.advance(300);
  assert.deepEqual([s.getState().signal, view().statusText], ['present', 'In tune']);
});
