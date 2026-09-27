/**
 * M7 — the microphone through the whole application, as the browser demo composes it (src/harness/compose.ts), on a fake browser in jsdom:
 *
 *   fake microphone signal → MicrophonePitchProvider → PitchFusionPort → tuning domain → session → view → the .obix UI on the Vue runtime
 *
 * The user chooses "Microphone" and presses Start — and from then on turning the peg is all: the note, the frequency, the cents, the status and the
 * confidence follow the string, with no further interaction.
 */
import '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeBrowser, sineSignal } from '../support/fake-audio.ts';
import type { Signal } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const { nextTick } = await import('vue');
// (after the hooks are registered: a static import chain that reaches an .obix file is linked before any module body runs)
const { composeAnyTune } = await import('../../src/harness/compose.ts');
const { mountAnyTune } = await import('../../src/harness/mount.ts');

async function app(signal: Signal = sineSignal(110)) {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, { signal, sampleRate: 48000 });
  const composed = composeAnyTune({ clock, microphone: browser.environment });
  const host = document.createElement('div');
  document.body.append(host);
  const mounted = mountAnyTune(host, { session: composed.session, catalog: composed.catalog, clock, input: composed.input });
  const text = (selector: string): string => (host.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await nextTick();
  };
  return { clock, browser, composed, host, mounted, text, settle };
}

test('the demo composes two inputs — the microphone, and the demo that plays without one — and starts on the demo: nothing asks for the microphone before the user chooses it', async () => {
  const { composed, browser, text, host, mounted } = await app();
  assert.deepEqual(composed.session.getState().inputs, [{ id: 'microphone', label: 'Microphone' }, { id: 'demo', label: 'Demo (recorded / simulated)' }]);
  assert.equal(composed.session.getState().inputId, 'demo');
  assert.match(text('.input-source'), /^Input: Recorded — Standard Guitar/);
  assert.equal(host.querySelector('.privacy'), null);
  assert.equal(browser.requests.length, 0);
  mounted.unmount();
  host.remove();
});

test('choose Microphone, press Start once: the page says it is the microphone, how its audio is treated, and then — turning the peg — flat, then in tune and steady, with no other press', async () => {
  // the A string 20 cents flat, brought up to pitch after a second
  let cents = -20;
  const peg: Signal = (t) => 0.3 * Math.sin(2 * Math.PI * 110 * 2 ** (cents / 1200) * t);
  const { clock, browser, host, text, settle, mounted } = await app(peg);
  const select = host.querySelector('select#input-source') as HTMLSelectElement;
  select.value = 'microphone';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(text('.input-source'), 'Input: Microphone — your microphone, once Start is pressed');
  assert.equal(text('.privacy'), 'Microphone audio is processed locally for pitch detection. AnyTune does not upload or persist raw microphone audio.');
  assert.equal(browser.requests.length, 0, 'choosing asks for nothing');

  (host.querySelector('button.start') as HTMLButtonElement).click();
  await settle();
  clock.advance(300);
  await settle();
  assert.equal(browser.requests.length, 1);
  assert.equal(text('.input-source'), 'Input: Microphone — Fake microphone, 48 kHz');
  assert.equal(text('.session'), 'Listening');
  assert.equal(`${text('.note-name')}${text('.note-octave')}`, 'A2');
  assert.match(text('.frequency'), /^108\.7 Hz$/);
  assert.equal(text('.status-text'), 'Flat');
  assert.match(text('.cents'), /^20\.\d cents flat$/);

  cents = 0; // the peg turned
  clock.advance(300);
  await settle();
  assert.deepEqual([text('.frequency'), text('.status-text'), text('.steady')], ['110.0 Hz', 'In tune', 'Holding steady']);
  // the confidence is shown too, in the details
  (host.querySelector('button.details-toggle') as HTMLButtonElement).click();
  await settle();
  assert.match(text('.confidence-text'), /^\d+% confidence$/);
  mounted.unmount();
  host.remove();
});

test('every open string of the guitar, heard through the microphone, is named and in tune', async () => {
  const strings: [string, number][] = [['E2', 82.41], ['A2', 110], ['D3', 146.83], ['G3', 196], ['B3', 246.94], ['E4', 329.63]];
  let f = 82.41;
  const { clock, composed, settle, mounted, host } = await app((t) => 0.3 * Math.sin(2 * Math.PI * f * t));
  await composed.session.selectInput('microphone');
  await composed.session.start();
  for (const [label, hz] of strings) {
    f = hz;
    clock.advance(300);
    await settle();
    const r = composed.session.getState().reading;
    assert.deepEqual([r?.targetLabel, r?.status], [label, 'in-tune'], `${label} ${hz} Hz`);
  }
  mounted.unmount();
  host.remove();
});

test('the UI is not the audio’s rate: a second of microphone frames (20) renders the UI at most once a frame, and the live region speaks at most once a second', async () => {
  const { clock, composed, settle, mounted, host } = await app(sineSignal(110));
  await composed.session.selectInput('microphone');
  await composed.session.start();
  await settle();
  const before = mounted.renders();
  let spoken = 0;
  const live = host.querySelector('[role="status"]') as HTMLElement;
  let last = live.textContent;
  for (let i = 0; i < 20; i++) {
    clock.advance(50);
    await settle();
    if (live.textContent !== last) {
      spoken++;
      last = live.textContent;
    }
  }
  assert.ok(mounted.renders() - before <= 20, `${mounted.renders() - before} renders`);
  assert.ok(spoken <= 2, `${spoken} announcements in a second`);
  mounted.unmount();
  host.remove();
});

test('the microphone refused: the page says so in words, and the demo can still be chosen and played', async () => {
  const clock = new ManualScheduler();
  clock.advance(1000);
  const browser = new FakeBrowser(clock, { refuse: 'NotAllowedError' });
  const composed = composeAnyTune({ clock, microphone: browser.environment });
  await composed.session.selectInput('microphone');
  await composed.session.start();
  await Promise.resolve();
  assert.deepEqual([composed.session.getState().session, composed.session.getState().error?.kind], ['error', 'permission-denied']);
  await composed.session.selectInput('demo');
  assert.equal(composed.session.getState().error, null);
  await composed.session.start();
  clock.advance(2000);
  assert.deepEqual([composed.session.getState().reading?.detectedFrequencyHz, composed.session.getState().stable], [110, true]);
});
