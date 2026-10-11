/**
 * The whole app mounted for a UI test, on a runtime of tests/support/runtimes.ts: the real ShellApp, views and .obix components, with what a browser would
 * supply faked — and only that:
 *
 *   TestAudio   one clock for capture and playback, moved by the audio the test delivers in frames of 1024 samples (as the AudioWorklet does); it records
 *               what playback was asked for, can refuse the microphone, end the device, or send zeros. Its latencies are made-up numbers, named as such.
 *   files       the files the learner chose
 *   frame       the display's frames, run when the test says
 *
 * Import after tests/support/dom.ts and tests/support/obix-loader.ts.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CaptureInfo, ReportedLatency } from '../../src/app/input-view.ts';
import type { AttemptStore, Playback } from '../../src/app/practice.ts';
import { composeAnyTune } from '../../src/harness/compose.ts';
import type { CaptureOutcome, CaptureRequest, PracticeAudio } from '../../src/harness/practice-audio.ts';
import { ShellApp } from '../../src/harness/shell-app.ts';
import { renderNotes } from '../../src/synthesis/pluck.ts';
import { window } from './dom.ts';
import { FakeBrowser } from './fake-audio.ts';
import { ManualScheduler } from './manual-scheduler.ts';
import type { Runtime } from './runtimes.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FIXTURE = (...p: string[]): Uint8Array => new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', ...p)));
export const SR = 48000;
export const FRAME = 1024;

/** The practice audio, faked: one clock for capture and playback, moved by the audio the test delivers. */
export class TestAudio implements PracticeAudio {
  readonly sampleRate = SR;
  t = 5;
  /** what startCapture answers */
  outcome: CaptureOutcome = 'on';
  readonly requests: { processing: boolean }[] = [];
  request: CaptureRequest | null = null;
  stops = 0;
  readonly notes: { key: number; at: number }[] = [];
  readonly clicks: { at: number; accent: boolean }[] = [];
  levels = { reference: 0.8, click: 0.6 };
  cancelled = 0;
  readonly playback: Playback = {
    note: (key, at) => void this.notes.push({ key, at }),
    click: (at, accent) => void this.clicks.push({ at, accent }),
    cancelAll: () => void this.cancelled++,
  };
  now(): number {
    return this.t;
  }
  async startCapture(request: CaptureRequest): Promise<CaptureOutcome> {
    this.requests.push({ processing: request.processing });
    if (this.outcome === 'on') this.request = request;
    return this.outcome;
  }
  stopCapture(): void {
    this.stops++;
    this.request = null;
  }
  captureInfo(): CaptureInfo | null {
    return this.request === null ? null : { device: 'Test microphone', sampleRate: SR, processing: this.requests[this.requests.length - 1]?.processing ?? false };
  }
  setLevels(reference: number, click: number): void {
    this.levels = { reference, click };
  }
  /** made-up numbers for the test, in the shape the browser gives them */
  latency(): ReportedLatency {
    return { baseSeconds: 0.006, outputSeconds: 0.045, inputSeconds: this.request === null ? null : 0.01 };
  }
  dropped(): number {
    return 0;
  }
  /** The learner's sound, beginning now: delivered in frames, each stamped with its first sample's time; `after` runs after each frame. */
  deliver(samples: Float32Array, after: () => void): void {
    const from = this.t;
    for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
      this.t = from + (i + FRAME) / SR;
      this.request?.onFrames(samples.slice(i, i + FRAME), from + i / SR);
      after();
    }
  }
  /** Time passes with no frames at all — the capture stalled; `after` runs every ~20 ms. */
  stall(seconds: number, after: () => void): void {
    const end = this.t + seconds;
    while (this.t < end) {
      this.t = Math.min(end, this.t + FRAME / SR);
      after();
    }
  }
  /** The device ends: unplugged, or the permission withdrawn. */
  end(): void {
    this.request?.onEnded();
  }
}

/** A recorder kept in memory — an isolated stand-in, here only to show what the page says of a saved attempt (the real one: tests/app/practice-polycall). */
export class MemoryStore implements AttemptStore {
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

/** Plucked notes, as a learner plays them: [key, onset seconds from now] — padded with silence-free room noise to `seconds`. */
export function performance(notes: readonly (readonly [number, number])[], seconds: number, level = 1): Float32Array {
  const played = renderNotes(notes.map(([key, onset], i) => ({ key, onsetSeconds: onset, durationSeconds: Math.min(0.3, (notes[i + 1]?.[1] ?? Infinity) - onset), velocity: 90 })), SR);
  const out = new Float32Array(Math.ceil(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = (played[i] ?? 0) * level + 0.0004 * Math.sin(i * 1.3); // a real microphone's noise floor: never digital silence
  return out;
}

export const roomNoise = (seconds: number): Float32Array => performance([], seconds);

export interface ShellUiOptions {
  readonly store?: AttemptStore;
  readonly files?: Record<string, { name: string; bytes: Uint8Array }>;
  readonly audio?: TestAudio;
}

export function shellUi(runtime: Runtime, options: ShellUiOptions = {}) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const clock = new ManualScheduler();
  const tuning = composeAnyTune({ clock, microphone: new FakeBrowser(clock).environment });
  const audio = options.audio ?? new TestAudio();
  const frames = new Set<() => void>();
  const app = new ShellApp({
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
  const mounted = runtime.mountShell(host, { app });
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
  const hasButton = (label: string): boolean => $$('button').some((b) => (b.textContent ?? '').trim() === label);
  const choose = async (select: HTMLElement, value: string): Promise<void> => {
    (select as HTMLSelectElement).value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
  };
  /** the display's next frame: the sessions' ticks and the coalesced renders */
  const frame = (): void => {
    const due = [...frames];
    frames.clear();
    for (const run of due) run();
  };
  /** Start, then pluck A2 for the microphone check: the input is ready */
  const checkInput = async (): Promise<void> => {
    await click(button('Start'));
    audio.deliver(performance([[45, 0.2]], 1), frame);
    await settle();
  };
  return { host, app, audio, tuning, mounted, $, $$, text, texts, settle, click, button, hasButton, choose, frame, checkInput };
}

export async function violations(host: Element): Promise<string[]> {
  const axe = (await import('axe-core')).default;
  const result = await axe.run(host, { resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
