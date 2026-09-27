/**
 * M4 — what can go wrong with a microphone, as STATES of the provider, never exceptions: `start()` resolves whatever happens, and every failure leaves
 * nothing held. The browser's errors are read by their DOMException names (https://w3c.github.io/mediacapture-main/#dom-mediadevices-getusermedia).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrophonePitchProvider } from '../../src/audio/microphone-provider.ts';
import type { ProviderEvent } from '../../src/domain/ports.ts';
import { FakeBrowser, sineSignal } from '../support/fake-audio.ts';
import type { FakeBrowserOptions } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

async function started(options: FakeBrowserOptions) {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, options);
  const mic = new MicrophonePitchProvider(browser.environment, clock);
  const states: string[] = [];
  mic.subscribe((e: ProviderEvent) => {
    if (e.kind === 'state') states.push(e.state);
  });
  await mic.start(); // never rejects
  return { clock, browser, mic, states };
}

test('an insecure page: the microphone is not asked for at all — getUserMedia exists only on https and localhost', async () => {
  const { browser, states } = await started({ secureContext: false });
  assert.deepEqual(states, ['starting', 'insecure-context']);
  assert.equal(browser.requests.length, 0);
});

test('a browser without getUserMedia, or without Web Audio: unsupported', async () => {
  assert.deepEqual((await started({ noMediaDevices: true })).states, ['starting', 'unsupported']);
  const noAudio = await started({ noAudioContext: true });
  assert.deepEqual(noAudio.states, ['starting', 'unsupported']);
  assert.equal(noAudio.browser.requests.length, 0, 'the permission is not asked for what cannot be used');
});

test('the browser’s refusals, by name: permission denied, no device, and a microphone that cannot be opened', async () => {
  const cases: [string, string][] = [
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-device'],
    ['OverconstrainedError', 'no-device'],
    ['NotReadableError', 'microphone-unavailable'],
    ['AbortError', 'microphone-unavailable'],
    ['TypeError', 'microphone-unavailable'],
    ['SomethingNew', 'microphone-unavailable'],
  ];
  for (const [name, state] of cases) {
    const { states, browser } = await started({ refuse: name });
    assert.deepEqual(states, ['starting', state], name);
    assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 }, name);
  }
});

test('the audio cannot start — the AudioContext cannot be made, or will not resume: audio-failed, and the microphone given back', async () => {
  const cannotMake = await started({ audioContextThrows: true });
  assert.deepEqual(cannotMake.states, ['starting', 'audio-failed']);
  assert.deepEqual(cannotMake.browser.held, { tracks: 0, contexts: 0, nodes: 0 });

  const clock = new ManualScheduler();
  const browser = new FakeBrowser(clock, { startSuspended: true });
  const environment = browser.environment;
  const make = environment.createAudioContext;
  assert.ok(make);
  const refusing = {
    ...environment,
    createAudioContext: () => {
      const context = make();
      context.resume = () => Promise.reject(Object.assign(new Error('fake: not allowed to start'), { name: 'NotAllowedError' }));
      return context;
    },
  };
  const mic = new MicrophonePitchProvider(refusing, clock);
  const states: string[] = [];
  mic.subscribe((e) => e.kind === 'state' && states.push(e.state));
  await mic.start();
  assert.deepEqual(states, ['starting', 'audio-failed']);
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
});

test('the microphone unplugged while listening: disconnected, everything released, nothing published after', async () => {
  const { clock, browser, mic, states } = await started({ signal: sineSignal(110) });
  const events: ProviderEvent[] = [];
  mic.subscribe((e) => events.push(e));
  clock.advance(100);
  browser.tracks[0]?.unplug();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(states.at(-1), 'disconnected');
  assert.deepEqual(browser.held, { tracks: 0, contexts: 0, nodes: 0 });
  assert.equal(clock.pending, 0);
  const count = events.length;
  clock.advance(500);
  assert.equal(events.length, count);
  // and it can be started again
  await mic.start();
  assert.equal(states.at(-1), 'listening');
  await mic.stop();
});

test('stop after a failure is quiet: there is nothing to stop, and nothing is said', async () => {
  const { mic, states } = await started({ refuse: 'NotAllowedError' });
  await mic.stop();
  assert.deepEqual(states, ['starting', 'permission-denied']);
});
