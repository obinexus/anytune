/**
 * Accessibility, on the rendered UI (the official Vue runtime in jsdom, the demo's execution path): the tuning status is text, not colour; a polite live region
 * carries the announcement policy's words — and only it, so a screen reader is not flooded by the visual refresh; outputs and the meter are semantic; every
 * control is a native, labelled control reachable by keyboard; an error is an alert. And axe-core finds no violation in any state.
 *
 * AUTOMATED ONLY. Manual testing with a screen reader and a keyboard has NOT been performed, and jsdom has no layout, so the rules that need one (colour
 * contrast among them) are reported by axe as incomplete, not as passed.
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
const { mountAnyTune } = await import('../../src/harness/mount.ts');
const axe = (await import('axe-core')).default;
const ROOT = path.resolve(import.meta.dirname, '..', '..');

async function app(fusion: PitchFusionPort, clock: ManualScheduler) {
  const host = document.createElement('div');
  document.body.append(host);
  const session = new TuningSession({ fusion, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  const mounted = mountAnyTune(host, { session, catalog: CATALOG, clock });
  const $ = (selector: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(selector);
    assert.ok(el, selector);
    return el;
  };
  // the one interaction: start
  $('button.start').click();
  await Promise.resolve();
  await nextTick();
  return { host, $, mounted, text: (s: string) => ($(s).textContent ?? '').replace(/\s+/g, ' ').trim() };
}

async function violations(host: Element): Promise<string[]> {
  const result = await axe.run(host, { resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('the live region: one polite status region, present and empty from the first render, that says only what the announcement policy says', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const ui = await app(fusion.port, clock);
  const live = ui.host.querySelectorAll('[aria-live]');
  assert.equal(live.length, 1, 'one live region');
  const region = live[0] as HTMLElement;
  assert.deepEqual([region.getAttribute('role'), region.getAttribute('aria-live'), region.getAttribute('aria-atomic')], ['status', 'polite', 'true']);
  assert.ok(region.classList.contains('visually-hidden'), 'read by assistive technology, not shown twice');
  assert.equal(region.textContent, 'Listening. Play a note.');
  const mic = fusion.providers[0];
  assert.ok(mic);
  clock.advance(1000);
  mic.hear(108);
  await nextTick();
  assert.equal(region.textContent, 'A2, 32 cents flat');
  // the cents move, the visual text changes — the announcement does not
  clock.advance(1500);
  mic.hear(108.6);
  await nextTick();
  assert.equal(ui.text('.cents'), '22.2 cents flat');
  assert.equal(region.textContent, 'A2, 32 cents flat');
  // the visual status is not itself live: nothing else is announced
  assert.equal(ui.$('.status-text').closest('[aria-live]'), null);
  ui.mounted.unmount();
});

test('hands-free announcements of the acceptance sequence played live: "Listening", then — the string in tune within the second — "A2, in tune and steady"', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const ui = await app(fusion.port, clock);
  const mic = fusion.providers[0];
  assert.ok(mic);
  const region = ui.$('[aria-live]');
  const heard: string[] = [region.textContent ?? ''];
  for (const [i, hz] of [108, 109, 110, 110].entries()) {
    if (i > 0) clock.advance(250);
    mic.hear(hz);
    await nextTick();
    if (region.textContent !== heard.at(-1)) heard.push(region.textContent ?? '');
  }
  clock.advance(1000);
  await nextTick();
  if (region.textContent !== heard.at(-1)) heard.push(region.textContent ?? '');
  assert.deepEqual(heard, ['Listening. Play a note.', 'A2, in tune and steady']);
  ui.mounted.unmount();
});

test('the acceptance recording replayed to its end: the last thing said is that the recording ended — not that the user stopped', async () => {
  const clock = new ManualScheduler();
  const parsed = parseRecording(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pitch', 'guitar-a2-acceptance.json'), 'utf8')));
  assert.ok(parsed.ok);
  const ui = await app(RecordedPitchFusion(parsed.recording, clock), clock);
  clock.advance(5000);
  await nextTick();
  assert.equal(ui.$('[aria-live]').textContent, 'Recording ended');
  assert.equal(ui.text('.status-text'), 'In tune', 'the last reading stays on the screen');
  ui.mounted.unmount();
});

test('semantics: a main landmark with its heading, the frequency an output, the tuning meter a meter with its value in cents and in words', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const ui = await app(fusion.port, clock);
  fusion.providers[0]?.hear(111.5);
  await nextTick();
  assert.equal(ui.$('main h1').textContent, 'AnyTune');
  assert.equal(ui.$('output.frequency').textContent, '111.5 Hz');
  const meter = ui.$('[role="meter"]');
  assert.deepEqual(
    ['aria-label', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map((a) => meter.getAttribute(a)),
    ['Tuning', '-50', '50', '23', '23.4 cents sharp'],
  );
  assert.equal(ui.$('section.tuner-display').getAttribute('aria-label'), 'Tuner');
  ui.mounted.unmount();
});

test('not colour alone: every tuning status is also a word on the page, and the status element carries it as data for the stylesheet', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const ui = await app(fusion.port, clock);
  const mic = fusion.providers[0];
  assert.ok(mic);
  const words: string[] = [];
  for (const [hz, confidence] of [[108, 0.95], [110, 0.95], [111.5, 0.95], [110, 0.2]] as const) {
    mic.hear(hz, { confidence });
    await nextTick();
    words.push(`${ui.$('.tuning-status').dataset['status']}=${ui.text('.status-text')}`);
  }
  assert.deepEqual(words, ['flat=Flat', 'in-tune=In tune', 'sharp=Sharp', 'uncertain=Signal uncertain']);
  ui.mounted.unmount();
});

test('keyboard: every control is a native, focusable, labelled control; nothing has a positive tabindex; the details toggle says whether it is open', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const ui = await app(fusion.port, clock);
  const controls = [...ui.host.querySelectorAll<HTMLElement>('button, select, input, a[href], [tabindex]')];
  assert.deepEqual(controls.map((c) => `${c.tagName.toLowerCase()}.${c.className}`), ['select.', 'select.', 'button.stop', 'button.details-toggle']);
  assert.ok(controls.every((c) => !c.hasAttribute('tabindex') || Number(c.getAttribute('tabindex')) <= 0));
  assert.ok(controls.filter((c) => c.tagName === 'BUTTON').every((b) => b.getAttribute('type') === 'button' && (b.textContent ?? '').trim() !== ''));
  assert.equal(ui.$('label[for="instrument"]').textContent, 'Instrument');
  assert.equal(ui.$('label[for="input-source"]').textContent, 'Input');
  const toggle = ui.$('button.details-toggle');
  toggle.focus();
  assert.equal(document.activeElement, toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  await nextTick();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  ui.mounted.unmount();
});

test('an error is an alert, in words', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock, { startOutcome: 'permission-denied' });
  const ui = await app(fusion.port, clock);
  assert.equal(ui.$('.error').getAttribute('role'), 'alert');
  assert.equal(ui.text('.error'), 'Microphone permission was denied. Allow the microphone to tune.');
  ui.mounted.unmount();
});

test('axe-core (automated) finds no violation: idle, listening flat, in tune and steady with the details open, and in error', async () => {
  // a document with AnyTune alone in it: landmarks are checked across the whole document
  document.body.replaceChildren();
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const host = document.createElement('div');
  document.body.append(host);
  const session = new TuningSession({ fusion: fusion.port, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
  const mounted = mountAnyTune(host, { session, catalog: CATALOG, clock });
  const found: Record<string, string[]> = {};
  found['idle'] = await violations(host);
  await session.start();
  fusion.providers[0]?.hear(108);
  await nextTick();
  found['flat'] = await violations(host);
  fusion.providers[0]?.hear(110);
  fusion.providers[0]?.hear(110);
  (host.querySelector('button.details-toggle') as HTMLButtonElement).click();
  await nextTick();
  found['steady, details open'] = await violations(host);
  fusion.providers[0]?.disconnect();
  await nextTick();
  found['error'] = await violations(host);
  assert.deepEqual(found, { idle: [], flat: [], 'steady, details open': [], error: [] });
  mounted.unmount();
});
