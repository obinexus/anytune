/**
 * Hands-free tuning, end to end: start once, put the device down, play — every fused pitch updates the UI by itself.
 *
 *   pitch observations → PitchFusionPort → tuning domain → application state → the harness's reactive bridge → the .obix UI on the Vue runtime
 *
 * No button is pressed after start; nothing writes innerHTML or re-attaches listeners: the DOM nodes stay the same nodes and are patched by the runtime; and
 * the UI renders at most once per tick however many pitches arrive in it (the visual refresh is not the fusion's rate).
 */
import '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TuningSession } from '../../src/app/session.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { RecordedPitchFusion, SimulatedPitchFusion } from '../../src/fusion/pitch-fusion.ts';
import type { PitchFusionPort } from '../../src/domain/ports.ts';
import { parseRecording } from '../../src/audio/recording.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const { nextTick } = await import('vue');
// (after the hooks are registered: a static import chain that reaches an .obix file is linked before any module body runs)
const { mountAnyTune } = await import('../../src/harness/mount.ts');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const recording = (name: string) => {
  const parsed = parseRecording(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pitch', `${name}.json`), 'utf8')));
  assert.ok(parsed.ok);
  return parsed.recording;
};

async function app(fusion: PitchFusionPort) {
  const host = document.createElement('div');
  document.body.append(host);
  const session = new TuningSession({ fusion, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  const mounted = mountAnyTune(host, { session, catalog: CATALOG });
  const text = (selector: string): string => (host.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  // the one interaction: start
  (host.querySelector('button.start') as HTMLButtonElement).click();
  await Promise.resolve();
  await nextTick();
  return { host, session, mounted, text };
}

test('fake stream → domain → UI: after one press of start, each pitch played updates the note, the frequency and flat / in tune / sharp — with no further interaction', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const { host, text, mounted } = await app(fusion.port);
  const mic = fusion.providers[0];
  assert.ok(mic);
  assert.equal(text('.session'), 'Listening');
  const noteNode = host.querySelector('.note-name');
  const seen: string[] = [];
  for (const hz of [108, 110, 111.5]) {
    mic.hear(hz);
    await nextTick();
    seen.push(`${text('.note-name')}${text('.note-octave')} ${text('.frequency')} ${text('.status-text')}`);
  }
  assert.deepEqual(seen, ['A2 108.0 Hz Flat', 'A2 110.0 Hz In tune', 'A2 111.5 Hz Sharp']);
  assert.equal(host.querySelector('.note-name'), noteNode, 'the same DOM node, patched by the runtime — never re-created by an innerHTML write');
  mounted.unmount();
});

test('the directive’s acceptance scenario, replayed hands-free: Standard Guitar, A2 — 108, 109, 110, 110 Hz show flat, flat, in tune, in tune and holding steady', async () => {
  const clock = new ManualScheduler();
  const { text, mounted } = await app(RecordedPitchFusion(recording('guitar-a2-acceptance'), clock));
  const frames: string[] = [];
  for (let i = 0; i < 4; i++) {
    clock.advance(i === 0 ? 0 : 250);
    await nextTick();
    frames.push(`${text('.summary')} | ${text('.frequency')} | ${text('.status-text')} | ${text('.cents')}${text('.steady') ? ' | ' + text('.steady') : ''}`);
  }
  assert.deepEqual(frames, [
    'Standard Guitar · A2 | 108.0 Hz | Flat | 31.8 cents flat',
    'Standard Guitar · A2 | 109.0 Hz | Flat | 15.8 cents flat',
    'Standard Guitar · A2 | 110.0 Hz | In tune | 0.0 cents',
    'Standard Guitar · A2 | 110.0 Hz | In tune | 0.0 cents | Holding steady',
  ]);
  mounted.unmount();
});

test('multiple pitch observations → a stable reading: two simulated sources fused, the reading holds steady', async () => {
  const clock = new ManualScheduler();
  const { text, mounted } = await app(RecordedPitchFusion(recording('guitar-a2-two-sources'), clock));
  clock.advance(1000);
  await nextTick();
  assert.deepEqual([text('.frequency'), text('.status-text'), text('.steady')], ['110.0 Hz', 'In tune', 'Holding steady']);
  mounted.unmount();
});

test('a stream that disconnects: the UI says so — the error, the input state, the start button back — with no interaction', async () => {
  const clock = new ManualScheduler();
  const { host, text, mounted } = await app(RecordedPitchFusion(recording('guitar-a2-disconnect'), clock));
  clock.advance(300);
  await nextTick();
  assert.equal(text('.status-text'), 'In tune');
  clock.advance(1000);
  await nextTick();
  assert.deepEqual([text('.error'), text('.input-status'), text('.status-text')], ['The input was disconnected. Start again to tune.', 'Input disconnected', 'No signal']);
  assert.ok(host.querySelector('button.start'));
  mounted.unmount();
});

test('the visual refresh is not the fusion’s rate: fifty pitches in one tick render the UI once, and show the last', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const { text, mounted } = await app(fusion.port);
  const mic = fusion.providers[0];
  assert.ok(mic);
  const before = mounted.renders();
  for (let i = 0; i < 50; i++) mic.hear(100 + i * 0.2);
  await nextTick();
  assert.equal(mounted.renders() - before, 1);
  assert.equal(text('.frequency'), '109.8 Hz');
  mounted.unmount();
});

test('the intents of the UI reach the application service: choosing an instrument and stopping', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const { host, session, text, mounted } = await app(fusion.port);
  const select = host.querySelector('select#instrument') as HTMLSelectElement;
  select.value = 'chromatic';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  fusion.providers[0]?.hear(440);
  await nextTick();
  assert.deepEqual([session.getState().instrumentId, text('.summary'), text('.status-text')], ['chromatic', 'Chromatic (voice, flute, any pitched instrument) · A4', 'In tune']);
  (host.querySelector('button.stop') as HTMLButtonElement).click();
  await Promise.resolve();
  await nextTick();
  assert.deepEqual([session.getState().session, text('.session')], ['idle', 'Not listening']);
  mounted.unmount();
});

test('nothing in AnyTune writes markup by hand: no innerHTML, outerHTML, insertAdjacentHTML or document.write anywhere in src/', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = walk(path.join(ROOT, 'src')).filter((f) => /(innerHTML|outerHTML|insertAdjacentHTML|document\.write)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
