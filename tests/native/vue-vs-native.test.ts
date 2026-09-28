/**
 * Phase 6, N11 — AnyTune on the Vue runtime and on OBIX's native runtime, side by side, from the SAME .obix files: the same application, driven by the same scenario, must
 * show the same page after every step.
 *
 * "The same page" is what a user observes, in a normal form: every element by name AND namespace (an SVG line must be an SVG line), its attributes, the events it listens
 * to, and the text — comments (each runtime's placeholders) and empty texts dropped, adjacent texts run together. A form control's current state is compared as the control
 * holds it — a select's value, an option's `selected`, an input's value and `checked` — not by the attribute that only gives its default: Vue's DOM runtime writes
 * `selected` as a property, the native runtime as the attribute AND the property (D-96); what the user sees is the property.
 *
 * Scenarios: the directive's acceptance sequence recorded (Standard Guitar, A2: 108 → 109 → 110 → 110 Hz, flat / flat / in tune / in tune and holding steady), a
 * simulated source changing instrument to Chromatic (A4 at 440 Hz) and stopping, the details toggle, a disconnect, a refused microphone, and the microphone itself
 * (a fake browser's signal through MicrophonePitchProvider) chosen, started and tuned from 20 cents flat to in tune.
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
import { FakeBrowser } from '../support/fake-audio.ts';
import type { Signal } from '../support/fake-audio.ts';

const { RUNTIMES } = await import('../support/runtimes.ts');
const { composeAnyTune } = await import('../../src/harness/compose.ts');
const ROOT = path.resolve(import.meta.dirname, '..', '..');

// every listener the page adds and takes away, per element: the events an element listens to are part of what is compared
const listening = new WeakMap<EventTarget, Map<string, number>>();
{
  const prototype = window.EventTarget.prototype;
  const add = prototype.addEventListener;
  const remove = prototype.removeEventListener;
  const counts = (target: EventTarget): Map<string, number> => {
    let map = listening.get(target);
    if (map === undefined) listening.set(target, (map = new Map()));
    return map;
  };
  prototype.addEventListener = function (this: EventTarget, type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | AddEventListenerOptions)?]) {
    counts(this).set(type, (counts(this).get(type) ?? 0) + 1);
    return add.call(this, type, ...rest);
  } as typeof prototype.addEventListener;
  prototype.removeEventListener = function (this: EventTarget, type: string, ...rest: [EventListenerOrEventListenerObject | null, (boolean | EventListenerOptions)?]) {
    counts(this).set(type, (counts(this).get(type) ?? 0) - 1);
    return remove.call(this, type, ...rest);
  } as typeof prototype.removeEventListener;
}

type Shown = { text: string } | { tag: string; ns: string | null; attributes: Record<string, string>; state: Record<string, string | boolean>; events: string[]; children: Shown[] };
const LIVE = new Set(['value', 'checked', 'selected']);

/** What a user observes of the nodes, in the normal form above. */
function observable(nodes: NodeListOf<ChildNode> | ChildNode[]): Shown[] {
  const out: Shown[] = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const data = (node as Text).data;
      if (data === '') continue;
      const last = out.at(-1);
      if (last !== undefined && 'text' in last) out[out.length - 1] = { text: last.text + data };
      else out.push({ text: data });
    } else if (node.nodeType === 1) {
      const element = node as Element;
      const tag = element.localName;
      const control = tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'option';
      const attributes = Object.fromEntries([...element.attributes].filter((a) => !(control && LIVE.has(a.name))).map((a): [string, string] => [a.name, a.value]).sort(([a], [b]) => (a < b ? -1 : 1)));
      const state: Record<string, string | boolean> = {};
      if (tag === 'select' || tag === 'input' || tag === 'textarea') state['value'] = (element as HTMLInputElement).value;
      if (tag === 'input') state['checked'] = (element as HTMLInputElement).checked;
      if (tag === 'option') {
        state['selected'] = (element as HTMLOptionElement).selected;
        state['value'] = (element as HTMLOptionElement).value;
      }
      const events = [...(listening.get(element) ?? new Map<string, number>())].filter(([, n]) => n > 0).map(([type]) => type).sort();
      out.push({ tag, ns: element.namespaceURI, attributes, state, events, children: observable([...element.childNodes]) });
    }
  }
  return out;
}

const recording = (name: string) => {
  const parsed = parseRecording(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'pitch', `${name}.json`), 'utf8')));
  assert.ok(parsed.ok);
  return parsed.recording;
};

interface Side {
  readonly host: HTMLElement;
  readonly settle: () => Promise<void>;
  readonly unmount: () => void;
}

/** Each runtime, mounted on its own application made by `make` — the same scenario drives both, and the page is compared after every step. */
async function sideBySide(make: () => { fusion: PitchFusionPort; clock: ManualScheduler }, steps: readonly ((host: HTMLElement, clock: ManualScheduler) => void | Promise<void>)[]) {
  const sides: (Side & { clock: ManualScheduler })[] = [];
  for (const runtime of RUNTIMES) {
    const { fusion, clock } = make();
    const host = document.createElement('div');
    document.body.append(host);
    const session = new TuningSession({ fusion, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' });
    const mounted = runtime.mount(host, { session, catalog: CATALOG, clock });
    await mounted.settled();
    sides.push({ host, clock, settle: () => mounted.settled(), unmount: () => mounted.unmount() });
  }
  const frames: string[] = [];
  const compare = (label: string): void => {
    const [vue, native] = sides.map((side) => observable([...side.host.childNodes]));
    assert.deepEqual(native, vue, `${label}: the native page is the Vue page`);
    frames.push((sides[0]!.host.querySelector('.summary')?.textContent ?? '').trim());
  };
  compare('at the start');
  for (const [i, step] of steps.entries()) {
    for (const side of sides) {
      await step(side.host, side.clock);
      for (let k = 0; k < 4; k++) await Promise.resolve();
      await side.settle();
    }
    compare(`after step ${i + 1}`);
  }
  for (const side of sides) {
    side.unmount();
    side.host.remove();
  }
  return frames;
}

const click = (selector: string) => (host: HTMLElement): void => {
  const element = host.querySelector(selector) as HTMLElement | null;
  assert.ok(element, `${selector} is on the page`);
  element.click();
};
const choose = (selector: string, value: string) => (host: HTMLElement): void => {
  const select = host.querySelector(selector) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const advance = (ms: number) => (_: HTMLElement, clock: ManualScheduler): void => clock.advance(ms);

test('the acceptance sequence recorded — Standard Guitar, A2: 108, 109, 110, 110 Hz — shows the same page on Vue and on the native runtime at every step', async () => {
  const frames = await sideBySide(() => {
    const clock = new ManualScheduler();
    return { clock, fusion: RecordedPitchFusion(recording('guitar-a2-acceptance'), clock) };
  }, [
    click('button.start'),
    advance(0),
    advance(250),
    advance(250),
    advance(250),
    click('button.details-toggle'),
    advance(5000),
  ]);
  assert.equal(frames.length, 8);
});

test('a simulated source, the instrument changed to Chromatic and A4 played at 440 Hz, then stopped: the same page on both at every step', async () => {
  // each step is taken on the Vue side, then on the native side: `turn` says which side's source hears it
  const fusions: ReturnType<typeof SimulatedPitchFusion>[] = [];
  let turn = 0;
  const hear = (hz: number) => (): void => { fusions[turn++ % 2]?.providers[0]?.hear(hz); };
  await sideBySide(() => {
    const clock = new ManualScheduler();
    const fusion = SimulatedPitchFusion(clock);
    fusions.push(fusion);
    return { clock, fusion: fusion.port };
  }, [click('button.start'), hear(108), choose('select#instrument', 'chromatic'), hear(440), click('button.stop')]);
});

test('uncertain, sharp, disconnected: the same page on both', async () => {
  const fusions: ReturnType<typeof SimulatedPitchFusion>[] = [];
  let turn = 0;
  const hear = (hz: number, confidence = 0.95) => () => { fusions[turn++ % 2]?.providers[0]?.hear(hz, { confidence }); };
  await sideBySide(() => {
    const clock = new ManualScheduler();
    const fusion = SimulatedPitchFusion(clock);
    fusions.push(fusion);
    return { clock, fusion: fusion.port };
  }, [click('button.start'), hear(110, 0.2), hear(111.5), () => { fusions[turn++ % 2]?.providers[0]?.disconnect(); }]);
});

test('a refused microphone: the same alert on both', async () => {
  await sideBySide(() => {
    const clock = new ManualScheduler();
    return { clock, fusion: SimulatedPitchFusion(clock, { startOutcome: 'permission-denied' }).port };
  }, [click('button.start')]);
});

test('the microphone — a fake browser\'s signal through MicrophonePitchProvider — chosen, started, and tuned from 20 cents flat to in tune: the same page on both', async () => {
  const pages: Side[] = [];
  const pegs: { cents: number }[] = [];
  const clocks: ManualScheduler[] = [];
  for (const runtime of RUNTIMES) {
    const peg = { cents: -20 };
    pegs.push(peg);
    const signal: Signal = (t) => 0.3 * Math.sin(2 * Math.PI * 110 * 2 ** (peg.cents / 1200) * t);
    const clock = new ManualScheduler();
    clock.advance(1000);
    clocks.push(clock);
    const browser = new FakeBrowser(clock, { signal, sampleRate: 48000 });
    const composed = composeAnyTune({ clock, microphone: browser.environment });
    const host = document.createElement('div');
    document.body.append(host);
    const mounted = runtime.mount(host, { session: composed.session, catalog: composed.catalog, clock, input: composed.input });
    await mounted.settled();
    pages.push({ host, settle: () => mounted.settled(), unmount: () => mounted.unmount() });
  }
  const settleAll = async (): Promise<void> => {
    for (const page of pages) {
      for (let k = 0; k < 8; k++) await Promise.resolve();
      await page.settle();
    }
  };
  const same = (label: string): void => {
    const [vue, native] = pages.map((page) => observable([...page.host.childNodes]));
    assert.deepEqual(native, vue, `${label}: the native page is the Vue page`);
  };
  same('at the start');
  for (const page of pages) choose('select#input-source', 'microphone')(page.host);
  await settleAll();
  same('microphone chosen');
  for (const page of pages) click('button.start')(page.host);
  await settleAll();
  same('started');
  for (const clock of clocks) clock.advance(600);
  await settleAll();
  same('20 cents flat');
  for (const peg of pegs) peg.cents = 0;
  for (const clock of clocks) clock.advance(1500);
  await settleAll();
  same('in tune');
  assert.match((pages[1]!.host.querySelector('.status-text')?.textContent ?? '').trim(), /In tune/);
  for (const page of pages) {
    page.unmount();
    page.host.remove();
  }
});

test('the normal form can fail: a page that differs in a namespace, an attribute, a listener or a control\'s state is told apart', () => {
  const a = document.createElement('div');
  a.innerHTML = '<svg><line x1="1"></line></svg><select><option value="x">x</option><option value="y">y</option></select>';
  const b = a.cloneNode(true) as HTMLElement;
  assert.deepEqual(observable([...b.childNodes]), observable([...a.childNodes]));
  const html = document.createElement('div');
  html.append(document.createElement('svg'));
  assert.notDeepEqual(observable([...html.childNodes]), observable([document.createElementNS('http://www.w3.org/2000/svg', 'svg')]));
  (b.querySelector('select') as HTMLSelectElement).value = 'y';
  assert.notDeepEqual(observable([...b.childNodes]), observable([...a.childNodes]));
  const c = a.cloneNode(true) as HTMLElement;
  c.querySelector('line')?.setAttribute('x1', '2');
  assert.notDeepEqual(observable([...c.childNodes]), observable([...a.childNodes]));
  const d = a.cloneNode(true) as HTMLElement;
  d.querySelector('select')?.addEventListener('change', () => {});
  assert.notDeepEqual(observable([...d.childNodes]), observable([...a.childNodes]));
});
