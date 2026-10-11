/**
 * The whole app on the page — the journey's shell (src/harness/shell-app.ts, the .obix screens) on the official Vue runtime and on OBIX's native runtime, from
 * the same .obix files, in jsdom: Home, the navigation, the Library (a MIDI file opened, an .obr refused, the import explained), the tuner inside the shell,
 * and a practice played through — Start, a count-in, the learner's notes as captured audio, the pass judged, Stop, the review — listed in Progress.
 *
 * What is faked, and only here: the practice audio (a test clock that delivers rendered plucked strings in frames of 1024 samples, as the AudioWorklet does,
 * and records what playback was asked for), the files the learner chose, and the display's frames. The analysis, the practice session, the views and the
 * components are the real ones. Nothing here shows that a browser's microphone or speaker works: that is the device's to show (docs/ANDROID.md).
 */
import { window } from '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AttemptStore, Playback } from '../../src/app/practice.ts';
import type { CaptureOutcome, PracticeAudio } from '../../src/harness/practice-audio.ts';
import { composeAnyTune } from '../../src/harness/compose.ts';
import { ShellApp, IMPORT_NOTE } from '../../src/harness/shell-app.ts';
import { renderNotes } from '../../src/synthesis/pluck.ts';
import { FakeBrowser } from '../support/fake-audio.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const { RUNTIMES } = await import('../support/runtimes.ts');
const axe = (await import('axe-core')).default;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURE = (...p: string[]): Uint8Array => new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', ...p)));

/** The practice audio, faked: one clock for capture and playback, moved by the audio the test delivers. */
class TestAudio implements PracticeAudio {
  readonly sampleRate = 48000;
  t = 5;
  outcome: CaptureOutcome = 'on';
  capture: ((samples: Float32Array, at: number) => void) | null = null;
  stops = 0;
  readonly notes: { key: number; at: number }[] = [];
  readonly clicks: { at: number; accent: boolean }[] = [];
  cancelled = 0;
  readonly playback: Playback = {
    note: (key, at) => void this.notes.push({ key, at }),
    click: (at, accent) => void this.clicks.push({ at, accent }),
    cancelAll: () => void this.cancelled++,
  };
  now(): number {
    return this.t;
  }
  async startCapture(onFrames: (samples: Float32Array, at: number) => void): Promise<CaptureOutcome> {
    if (this.outcome === 'on') this.capture = onFrames;
    return this.outcome;
  }
  stopCapture(): void {
    this.stops++;
    this.capture = null;
  }
  inputLatencySeconds(): number {
    return 0;
  }
  latencyText(): string {
    return 'Speaker-to-microphone delay: none (a test clock).';
  }
  dropped(): number {
    return 0;
  }
  /** The learner's sound, beginning now: delivered in frames of 1024 samples, each stamped with its first sample's time; `after` runs after each frame. */
  deliver(samples: Float32Array, after: () => void): void {
    const from = this.t;
    for (let i = 0; i + 1024 <= samples.length; i += 1024) {
      this.t = from + (i + 1024) / this.sampleRate;
      this.capture?.(samples.slice(i, i + 1024), from + i / this.sampleRate);
      after();
    }
  }
}

/** A recorder kept in memory — an isolated stand-in, here only to show what the page says of a saved attempt (the real one: tests/app/practice-polycall). */
class MemoryStore implements AttemptStore {
  events = 0;
  async create() {
    return { ok: true as const, value: { recordingId: 'b'.repeat(32) } };
  }
  async append(_id: string, events: readonly unknown[]) {
    this.events += events.length;
    return { ok: true };
  }
  async finish() {
    return { ok: true };
  }
}

for (const runtime of RUNTIMES) {
  function app(options: { store?: AttemptStore; files?: Record<string, { name: string; bytes: Uint8Array }>; audio?: TestAudio } = {}) {
    document.body.replaceChildren();
    const host = document.createElement('div');
    document.body.append(host);
    const clock = new ManualScheduler();
    const tuning = composeAnyTune({ clock, microphone: new FakeBrowser(clock).environment });
    const audio = options.audio ?? new TestAudio();
    const frames = new Set<() => void>();
    const shellApp = new ShellApp({
      tuning,
      clock,
      audio,
      recorder: options.store === undefined ? { store: null, why: 'no recorder in this test' } : { store: options.store },
      readFile: async (id) => options.files?.[id] ?? null,
      sha256: async (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'),
      frame(run) {
        frames.add(run);
        return () => frames.delete(run);
      },
      now: () => '2026-10-11T09:30:00.000Z',
    });
    const mounted = runtime.mountShell(host, { app: shellApp });
    const $ = (selector: string): HTMLElement => {
      const el = host.querySelector<HTMLElement>(selector);
      assert.ok(el, `no ${selector}`);
      return el;
    };
    const $$ = (selector: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(selector)];
    const text = (selector: string): string => ($(selector).textContent ?? '').replace(/\s+/g, ' ').trim();
    const texts = (selector: string): string[] => $$(selector).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
    /** every promise the click started, then the page */
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
      await runtime.settle();
    };
    const click = async (selector: string | HTMLElement): Promise<void> => {
      (typeof selector === 'string' ? $(selector) : selector).click();
      await settle();
    };
    const button = (label: string): HTMLElement => {
      const found = $$('button').find((b) => (b.textContent ?? '').trim() === label);
      assert.ok(found, `no button "${label}" among ${texts('button').join(' | ')}`);
      return found;
    };
    const choose = async (select: HTMLElement, value: string): Promise<void> => {
      (select as HTMLSelectElement).value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settle();
    };
    /** the display's next frame: the practice session's tick */
    const frame = (): void => {
      const due = [...frames];
      frames.clear();
      for (const run of due) run();
    };
    return { host, app: shellApp, audio, tuning, mounted, $, $$, text, texts, settle, click, button, choose, frame };
  }

  async function violations(host: Element): Promise<string[]> {
    const result = await axe.run(host, { resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }

  test(`[${runtime.name}] Home: the motto, the journey, and the way in — one navigation, the screen shown marked as the current page`, async () => {
    const ui = app();
    assert.equal(ui.text('main h1'), 'Groove to any tune.');
    assert.deepEqual(ui.texts('.journey li'), ['Choose a song', 'Tune your guitar', 'Listen to it', 'Practise, slowly at first', 'Review what to repeat', 'Repeat']);
    assert.equal(ui.text('button.primary'), 'Practise Für Elise (opening)');
    assert.equal(ui.$$('nav').length, 1);
    const current = (): string[] => ui.$$('.nav-item').filter((b) => b.getAttribute('aria-current') === 'page').map((b) => (b.textContent ?? '').trim());
    assert.deepEqual(ui.texts('.nav-item'), ['Home', 'Library', 'Tune', 'Practise', 'Progress']);
    assert.deepEqual(current(), ['Home']);
    await ui.click(ui.button('Library'));
    assert.equal(ui.text('main h1'), 'Library');
    assert.deepEqual(current(), ['Library']);
    await ui.click(ui.button('Progress'));
    assert.equal(ui.text('main h1'), 'Progress');
    assert.equal(ui.text('.empty'), 'No attempts yet: practise a song, and each attempt is listed here.');
    await ui.click(ui.button('Practise'));
    assert.equal(ui.text('.arrangement'), 'Choose a song in the Library to practise it.', 'nothing chosen yet: said, not an empty screen');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Library: a MIDI file opened becomes a song (its melody said); an .obr is read and refused, in words; a recording or a link is explained`, async () => {
    const midi = FIXTURE('midi', 'fur-elise-opening.mid');
    const ui = app({ files: { 'midi-file': { name: 'my-song.mid', bytes: midi }, 'obr-file': { name: 'demo.obr', bytes: FIXTURE('obr', 'demo.obr') } } });
    await ui.click(ui.button('Library'));
    assert.deepEqual(ui.texts('.song-title'), ['Für Elise (opening)']);
    ui.$('#midi-file').dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.settle();
    assert.deepEqual(ui.texts('.song-title'), ['Für Elise (opening)', 'my-song']);
    assert.match(ui.texts('.song-detail')[1] ?? '', /^MIDI file my-song\.mid; melody from track 1 \(C4–E5\), the highest of its 2 parts$/);
    assert.match(ui.text('.message'), /^my-song added: 35 melody notes\./);
    assert.equal(ui.$('.message').getAttribute('role'), 'status');
    ui.$('#obr-file').dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.settle();
    assert.match(ui.text('.message'), /^demo\.obr: /);
    assert.doesNotMatch(ui.text('.message'), /added/);
    assert.equal(ui.$$('.song').length, 2, 'the .obr added nothing');
    await ui.click(ui.button('Import a recording or a link'));
    assert.equal(ui.text('.message'), IMPORT_NOTE);
    // the song opened is practised like the bundled one
    await ui.click(ui.$$('.song button')[1] as HTMLElement);
    assert.equal(ui.text('main h1'), 'Practise');
    assert.equal(ui.text('.title'), 'my-song');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the tuner, inside the shell: shown on Tune, and stopped when the learner goes elsewhere`, async () => {
    const ui = app();
    await ui.click(ui.button('Tune your guitar first'));
    assert.equal(ui.$('section.tuner-display').getAttribute('aria-label'), 'Tuner');
    await ui.click('button.start');
    assert.equal(ui.tuning.session.getState().session, 'listening');
    await ui.click(ui.button('Home'));
    assert.notEqual(ui.tuning.session.getState().session, 'listening', 'nothing keeps listening off the Tune screen');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Practise, before Start: the first note and where to play it — a suggestion — on the diagram, and the settings`, async () => {
    const ui = app();
    await ui.click('button.primary');
    assert.equal(ui.text('main h1'), 'Practise');
    assert.equal(ui.text('.title'), 'Für Elise (opening)');
    assert.equal(ui.text('.arrangement'), 'Melody on guitar, an octave lower than written');
    assert.equal(ui.text('.phase'), 'Ready. Press Start: a count-in, then play along.');
    assert.equal(ui.text('.current'), 'First: E4');
    assert.match(ui.text('.position'), /^high E string, open — a suggestion$/);
    assert.equal(ui.text('.next'), 'Then: D#4');
    // the enlarged fretboard: the first note is the open high e (○ before the nut), the next D#4 a dashed preview at fret 4 with its finger, at one unit per px
    const diagram = ui.$('svg.diagram');
    assert.deepEqual(ui.$$('svg.diagram circle.marker').map((m) => m.dataset['kind']), ['next']);
    assert.deepEqual(ui.$$('svg.diagram .string-mark').map((m) => [m.dataset['kind'], m.dataset['state'], m.textContent]), [['now', 'open', '○']]);
    assert.deepEqual(ui.$$('svg.diagram .finger').map((m) => m.textContent), ['4']);
    assert.deepEqual(ui.$$('svg.diagram .string-name').map((m) => m.textContent), ['e', 'B', 'G', 'D', 'A', 'E']);
    assert.deepEqual(ui.$$('svg.diagram .fret-number').map((m) => m.textContent), ['', '1', '2', '3', '4']);
    assert.equal(diagram.getAttribute('viewBox'), `0 0 ${diagram.getAttribute('width')} ${diagram.getAttribute('height')}`, 'one unit per CSS pixel');
    assert.match(diagram.getAttribute('aria-label') ?? '', /Now: E4, high E string, open — a suggestion\. Next: D#4, B string, fret 4, little finger \(4\) — a suggestion\./);
    // the artwork, horizontal: the image and the markers under one transformation, the whole drawing decorative (the words and the fretboard carry it)
    const artwork = ui.$('.artwork-svg');
    assert.equal(artwork.getAttribute('aria-hidden'), 'true');
    assert.equal(artwork.getAttribute('viewBox'), '0 0 1997.1 774.83');
    const turned = ui.$('.artwork-svg > g');
    assert.equal(turned.getAttribute('transform'), 'matrix(0 -1 1 0 0 774.83)');
    assert.equal(turned.querySelectorAll('image').length, 1);
    assert.equal(turned.querySelectorAll('circle.marker').length, 2, 'the markers are inside the same transformation as the image');
    assert.equal(ui.$('.fretboard').dataset['hand'], 'right');
    await ui.choose(ui.$$('.settings select')[4] as HTMLElement, 'left');
    assert.equal(ui.$('.fretboard').dataset['hand'], 'left');
    assert.equal(ui.$('.artwork-svg > g').getAttribute('transform'), 'matrix(0 -1 -1 0 1997.1 774.83)');
    assert.equal(ui.text('.microphone'), 'Microphone off.');
    assert.equal(ui.$$('.review').length, 0, 'no review before a practice');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Listen first: the loop's notes are played on the audio clock, slower at a slower tempo`, async () => {
    const ui = app();
    await ui.click('button.primary');
    await ui.choose(ui.$$('.settings select')[1] as HTMLElement, '1');
    await ui.choose(ui.$$('.settings select')[2] as HTMLElement, '1');
    await ui.choose(ui.$$('.settings select')[0] as HTMLElement, '0.5');
    const targets = ui.app.shell.practice?.getState().loopTargets ?? [];
    assert.ok(targets.length > 0);
    await ui.click(ui.button('Listen first'));
    assert.deepEqual(ui.audio.notes.map((n) => n.key), targets.map((t) => t.key));
    const first = targets[0]?.time ?? 0;
    for (const [i, n] of ui.audio.notes.entries()) assert.ok(Math.abs(n.at - (ui.audio.t + 0.3 + ((targets[i]?.time ?? 0) - first) / 0.5)) < 1e-9);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a practice played through: Start, the count-in, bar 1 played in time as captured audio, the pass judged, Stop — reviewed, and listed in Progress as not saved`, async () => {
    const ui = app();
    await ui.click('button.primary');
    await ui.choose(ui.$$('.settings select')[1] as HTMLElement, '1');
    await ui.choose(ui.$$('.settings select')[2] as HTMLElement, '1');
    const practice = ui.app.shell.practice;
    assert.ok(practice);
    const targets = practice.getState().loopTargets;
    await ui.click(ui.button('Start'));
    assert.equal(ui.text('.microphone'), 'Microphone on — what it hears is analysed on this device and never uploaded.');
    assert.match(ui.text('.phase'), /^Get ready… \d$/);
    assert.equal(ui.$('fieldset.settings').hasAttribute('disabled'), true, 'no settings change while playing');
    assert.equal(ui.audio.clicks.filter((c) => c.at < (practice.due(0, targets[0]?.time ?? 0) ?? 0) - 1e-9).length, 3, 'a count-in of three clicks');
    assert.deepEqual(ui.audio.notes.slice(0, targets.length).map((n) => n.key), targets.map((t) => t.key), 'the reference, scheduled for the first pass');
    // the learner plays bar 1, each note when it falls due — and the pass is judged once its last note can have been reported (a quarter second after its end)
    const start = ui.audio.t;
    const passEnd = practice.due(1, targets[0]?.time ?? 0) ?? 0;
    const onsets = targets.map((t) => (practice.due(0, t.time) ?? 0) - start);
    const played = renderNotes(targets.map((t, i) => ({ key: t.key, onsetSeconds: onsets[i] ?? 0, durationSeconds: Math.min(0.3, (onsets[i + 1] ?? Infinity) - (onsets[i] ?? 0)), velocity: 90 })), 48000);
    const sound = new Float32Array(Math.ceil((passEnd - start + 0.2) * 48000));
    sound.set(played.subarray(0, sound.length));
    ui.audio.deliver(sound, ui.frame);
    await ui.settle();
    assert.equal(ui.$$('.review').length, 0, 'the last note of the pass may still be on its way: not judged yet');
    ui.audio.deliver(new Float32Array(Math.ceil(0.1 * 48000)), ui.frame); // silence: the learner waits
    await ui.settle();
    assert.equal(ui.text('.phase'), 'Playing — pass 2');
    assert.equal(ui.texts('.review .bars li').length, 1);
    assert.match(ui.texts('.review .bars li')[0] ?? '', /^Bar 1: /);
    await ui.click(ui.button('Stop'));
    assert.equal(ui.text('.phase'), 'Review');
    assert.equal(ui.text('.microphone'), 'Microphone off.');
    assert.equal(ui.audio.stops, 1, 'the microphone released');
    assert.ok(ui.texts('.review .sentences li').length > 0);
    assert.equal(ui.text('.attempt'), 'This attempt is not saved: no recorder in this test.');
    const right = practice.getState().feedback;
    assert.ok(right);
    assert.deepEqual([right.pitch.right, right.pitch.of, right.timing.onTime], [targets.length, targets.length, targets.length], 'every note of bar 1 heard, right and on time');
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), [`${targets.length} of ${targets.length} right, ${targets.length} on time — not saved`]);
    assert.equal(ui.$$('.empty').length, 0);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a recorder connected: the attempt is said to be saved, apart from the reference`, async () => {
    const store = new MemoryStore();
    const ui = app({ store });
    await ui.click('button.primary');
    await ui.click(ui.button('Start'));
    await ui.click(ui.button('Stop'));
    assert.equal(ui.text('.attempt'), `This attempt is saved (${store.events} events), apart from the reference.`);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the microphone refused: said, with what to do — and practice does not start`, async () => {
    const audio = new TestAudio();
    audio.outcome = 'denied';
    const ui = app({ audio });
    await ui.click('button.primary');
    await ui.click(ui.button('Start'));
    assert.equal(ui.text('.microphone'), 'The microphone was not allowed: practice needs it to hear you. Allow it and press Start again.');
    assert.equal(ui.app.shell.practice?.getState().phase, 'ready');
    assert.equal(ui.button('Start').tagName, 'BUTTON');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the page hidden: practice stops and the microphone is released`, async () => {
    const ui = app();
    await ui.click('button.primary');
    await ui.click(ui.button('Start'));
    ui.app.pause();
    await ui.settle();
    assert.equal(ui.app.shell.practice?.getState().phase, 'reviewing');
    assert.equal(ui.audio.stops, 1);
    assert.equal(ui.text('.microphone'), 'Microphone off.');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] axe-core (automated) finds no violation on any screen: Home, Library with a message, Tune, Practise ready and reviewed, Progress`, async () => {
    const ui = app({ files: { 'obr-file': { name: 'demo.obr', bytes: FIXTURE('obr', 'demo.obr') } } });
    const found: Record<string, string[]> = {};
    found['home'] = await violations(ui.host);
    await ui.click(ui.button('Library'));
    ui.$('#obr-file').dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.settle();
    found['library'] = await violations(ui.host);
    await ui.click(ui.button('Tune'));
    found['tune'] = await violations(ui.host);
    await ui.click(ui.button('Library'));
    await ui.click(ui.$$('.song button')[0] as HTMLElement);
    found['practise'] = await violations(ui.host);
    await ui.click(ui.button('Start'));
    found['practising'] = await violations(ui.host);
    await ui.click(ui.button('Stop'));
    found['reviewed'] = await violations(ui.host);
    await ui.click(ui.button('Progress'));
    found['progress'] = await violations(ui.host);
    assert.deepEqual(found, { home: [], library: [], tune: [], practise: [], practising: [], reviewed: [], progress: [] });
    ui.mounted.unmount();
  });
}
