/**
 * The UI, on the official Vue runtime (the demo's execution path) in a jsdom document: the components compiled by the OBIX Vue frontend show the view they are
 * given, in words as well as in form, and turn the user's intents into events. They never touch a provider, the fusion or Obicall — they only receive a view.
 */
import '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TunerView } from '../../src/app/view.ts';
import { toView } from '../../src/app/view.ts';
import type { AnyTuneState } from '../../src/app/session.ts';
import type { TuningReading } from '../../src/domain/tuning.ts';
import type { InputSource } from '../../src/domain/ports.ts';
import { DEFAULT_POLICY, findTuning, readPitch } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';

const { createApp, h, nextTick, shallowRef } = await import('vue');
const { default: AnyTuneApp } = await import('../../src/components/AnyTuneApp.obix');

const guitar = findTuning(CATALOG, 'guitar-standard');
assert.ok(guitar);
const IDLE: AnyTuneState = { session: 'idle', instrumentId: 'guitar-standard', reading: null, stable: false, signal: 'none', input: { state: 'idle', connected: false, confidence: 0 }, error: null };
const hearing = (hz: number, confidence = 0.95, extra: Partial<AnyTuneState> = {}): AnyTuneState => {
  const reading = readPitch({ frequencyHz: hz, confidence }, guitar, DEFAULT_POLICY) as TuningReading;
  return { ...IDLE, session: 'listening', reading, signal: reading.status === 'uncertain' ? 'uncertain' : 'present', input: { state: 'listening', connected: true, confidence }, ...extra };
};

function mount(state: AnyTuneState, source: InputSource | null = null) {
  const host = document.createElement('div');
  document.body.append(host);
  const view = shallowRef<TunerView>(toView(state, CATALOG, '', source));
  const intents: string[] = [];
  const app = createApp({
    render: () =>
      h(AnyTuneApp, {
        ...view.value,
        onSelectInstrument: (id: string) => intents.push(`select ${id}`),
        onStart: () => intents.push('start'),
        onStop: () => intents.push('stop'),
      }),
  });
  app.config.warnHandler = (message: string) => intents.push(`WARN ${message}`);
  app.mount(host);
  const $ = (selector: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(selector);
    assert.ok(el, `${selector} is not in the page`);
    return el;
  };
  return {
    host,
    $,
    text: (selector: string): string => ($(selector).textContent ?? '').replace(/\s+/g, ' ').trim(),
    intents,
    async show(next: AnyTuneState): Promise<void> {
      view.value = toView(next, CATALOG);
      await nextTick();
    },
    unmount(): void {
      app.unmount();
      host.remove();
    },
  };
}

test('the initial idle state: the title, the instrument, a start button, no note — and "No signal", in words', () => {
  const ui = mount(IDLE);
  assert.equal(ui.text('h1'), 'AnyTune');
  assert.equal(ui.text('.tagline'), 'Tune any instrument');
  assert.equal(ui.text('.note-name'), '–');
  assert.equal(ui.text('.frequency'), '— Hz');
  assert.equal(ui.text('.status-text'), 'No signal');
  assert.equal(ui.text('button.start'), 'Start tuning');
  assert.equal(ui.host.querySelector('button.stop'), null);
  assert.equal(ui.text('.session'), 'Not listening');
  assert.deepEqual(ui.intents.filter((i) => i.startsWith('WARN')), [], 'Vue has nothing to warn about');
  ui.unmount();
});

test('starting and listening: the session is said, and the start button becomes stop', async () => {
  const ui = mount(IDLE);
  await ui.show({ ...IDLE, session: 'starting', input: { state: 'starting', connected: false, confidence: 0 } });
  assert.equal(ui.text('.session'), 'Starting…');
  await ui.show({ ...IDLE, session: 'listening', input: { state: 'listening', connected: true, confidence: 0 } });
  assert.equal(ui.text('.session'), 'Listening');
  assert.equal(ui.text('button.stop'), 'Stop');
  assert.equal(ui.host.querySelector('button.start'), null);
  assert.equal(ui.text('.input-status'), 'Input connected');
  ui.unmount();
});

test('a detected note and its frequency are shown: A, octave 2, 108.0 Hz, 31.8 cents flat — Flat, in words', async () => {
  const ui = mount(IDLE);
  await ui.show(hearing(108));
  assert.deepEqual([ui.text('.note-name'), ui.text('.note-octave'), ui.text('.frequency')], ['A', '2', '108.0 Hz']);
  assert.equal(ui.text('.status-text'), 'Flat');
  assert.equal(ui.text('.cents'), '31.8 cents flat');
  assert.equal(ui.text('.summary'), 'Standard Guitar · A2');
  assert.equal(ui.$('.tuning-status').dataset['status'], 'flat');
  ui.unmount();
});

test('in tune and sharp are said in words, not only in colour; the meter’s needle moves with the cents', async () => {
  const ui = mount(IDLE);
  await ui.show(hearing(110));
  assert.deepEqual([ui.text('.status-text'), ui.$('.tuning-status').dataset['status'], ui.$('.needle').getAttribute('x1')], ['In tune', 'in-tune', '50']);
  await ui.show(hearing(111.5));
  assert.deepEqual([ui.text('.status-text'), ui.text('.cents'), ui.$('.tuning-status').dataset['status'], ui.$('.needle').getAttribute('x1')], ['Sharp', '23.4 cents sharp', 'sharp', '73.4']);
  assert.equal(ui.$('.pitch-meter').getAttribute('aria-valuenow'), '23');
  ui.unmount();
});

test('low confidence: "Signal uncertain", and the confidence is shown as a number', async () => {
  const ui = mount(IDLE);
  await ui.show(hearing(108, 0.3));
  assert.equal(ui.text('.status-text'), 'Signal uncertain');
  ui.$('button.details-toggle').click();
  await nextTick();
  assert.equal(ui.text('.confidence-text'), '30% confidence');
  assert.equal(ui.$('.confidence meter').getAttribute('value'), '30');
  ui.unmount();
});

test('instrument selection: every instrument of the catalog is offered, the current one selected, and choosing one is an intent for the app', async () => {
  const ui = mount(IDLE);
  const select = ui.$('select#instrument') as HTMLSelectElement;
  assert.deepEqual([...select.options].map((o) => [o.value, o.textContent, o.selected]), CATALOG.map((t) => [t.id, t.name, t.id === 'guitar-standard']));
  assert.equal(ui.text('label[for="instrument"]'), 'Instrument');
  select.value = 'violin';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  ui.$('button.start').click();
  assert.deepEqual(ui.intents, ['select violin', 'start']);
  await ui.show({ ...IDLE, instrumentId: 'violin' });
  assert.equal((ui.$('select#instrument') as HTMLSelectElement).value, 'violin');
  ui.unmount();
});

test('an error is shown in words, with the input status', async () => {
  const ui = mount(IDLE);
  await ui.show({ ...IDLE, session: 'error', error: { kind: 'permission-denied' }, input: { state: 'permission-denied', connected: false, confidence: 0 } });
  assert.equal(ui.text('.error'), 'Microphone permission was denied. Allow the microphone to tune.');
  assert.equal(ui.text('.input-status'), 'Microphone permission denied');
  await ui.show(IDLE);
  assert.equal(ui.host.querySelector('.error'), null);
  ui.unmount();
});

test('the details of the reading can be shown and hidden — a local UI state of the display (ref), with aria-expanded', async () => {
  const ui = mount(IDLE);
  await ui.show(hearing(110));
  const toggle = ui.$('button.details-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.host.querySelector('.confidence'), null);
  toggle.click();
  await (await import('vue')).nextTick();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.text('.confidence-text'), '95% confidence');
  ui.unmount();
});

test('what supplies the measurements is said on the page, in words: a simulation or a recording never passes for a real instrument being heard', async () => {
  const recorded = mount(hearing(110), { kind: 'recorded', name: 'Standard Guitar, the A string rising to pitch: 108, 109, 110, 110 Hz (simulated data)' });
  assert.equal(recorded.$('.input-source').textContent?.trim(), 'Input: Recorded — Standard Guitar, the A string rising to pitch: 108, 109, 110, 110 Hz (simulated data)');
  const simulated = mount(IDLE, { kind: 'simulated', name: 'Violin, the G3 string rising to pitch' });
  assert.equal(simulated.$('.input-source').textContent?.trim(), 'Input: Simulated — Violin, the G3 string rising to pitch');
});
