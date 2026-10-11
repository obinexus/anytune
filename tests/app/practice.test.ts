/**
 * The practice session (src/app/practice.ts): Für Elise's melody on guitar, practised as the app does — the loop, the tempo, the count-in, flow and step
 * modes — with a simulated learner whose notes arrive as the live analysis would deliver them (capture-clock times). The attempt is kept by an in-memory store
 * here, an isolated stand-in for the recorder; tests/app/practice-polycall.test.ts saves through the real one, through Polycall.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveEvent } from '../../src/analysis/live.ts';
import { PracticeSession, type AttemptStore, type Playback } from '../../src/app/practice.ts';
import { referenceFromMidi, type Reference } from '../../src/music/reference.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export function furElise(): Reference {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid')));
  const made = referenceFromMidi(bytes, { song: { id: 'fur-elise', title: 'Für Elise', composer: 'Beethoven' }, arrangement: { id: 'fe', version: 1, instrument: 'piano', part: 'full' }, provenance: { kind: 'midi-import', midi: { role: 'midi', fileName: 'fe.mid', mediaType: 'audio/midi', sha256: 'c821', bytes: 495 } } });
  if (!made.ok) throw new Error(made.reason);
  return made.reference;
}

type Event = { t: number; kind: string; [k: string]: unknown };

class MemoryStore implements AttemptStore {
  readonly created: Record<string, unknown>[] = [];
  readonly events: Event[] = [];
  finished = false;
  async create(_kind: 'attempt', meta: Readonly<Record<string, unknown>>) {
    this.created.push({ ...meta });
    return { ok: true as const, value: { recordingId: 'a'.repeat(32) } };
  }
  async append(_id: string, events: readonly Event[]) {
    let last = this.events.at(-1)?.t ?? 0;
    for (const e of events) {
      if (e.t < last) return { ok: false, error: { code: 'recording.order', message: 'time went back' } };
      last = e.t;
    }
    this.events.push(...events);
    return { ok: true };
  }
  async finish() {
    this.finished = true;
    return { ok: true };
  }
}

class Sounds implements Playback {
  notes: { key: number; at: number }[] = [];
  clicks: { at: number; accent: boolean }[] = [];
  cancelled = 0;
  note(key: number, at: number): void {
    this.notes.push({ key, at });
  }
  click(at: number, accent: boolean): void {
    this.clicks.push({ at, accent });
  }
  cancelAll(): void {
    this.cancelled++;
  }
}

const note = (time: number, key: number): LiveEvent => ({ kind: 'note', time, key, cents: 3, confidence: 0.9 });

test('the arrangement: the melody an octave lower, in first position, bar by bar after the pickup — said, and the reference untouched', () => {
  const reference = furElise();
  const before = JSON.stringify(reference);
  const session = new PracticeSession(reference, 1, { pickupTicks: 240 });
  const s = session.getState();
  assert.match(s.arrangementText, /an octave lower than written/);
  assert.equal(s.targets.length, 35);
  assert.ok(s.targets.every((t) => t.position !== null && t.position.fret <= 4));
  assert.deepEqual(s.targets.slice(0, 3).map((t) => [t.key, t.bar]), [[64, 0], [63, 0], [64, 1]]);
  assert.equal(s.attempt.kind, 'unavailable');
  assert.equal(JSON.stringify(reference), before);
});

test('flow mode, bars 1–2 looped at half speed: a count-in on the click, the reference scheduled on the capture clock, each pass judged as it ends', async () => {
  const sounds = new Sounds();
  const store = new MemoryStore();
  const session = new PracticeSession(furElise(), 1, { pickupTicks: 240, playback: sounds, store });
  session.configure({ tempoFactor: 0.5, loop: { fromBar: 1, toBar: 2 }, countInBeats: 3 });
  const loop = session.getState().loopTargets;
  assert.deepEqual(loop.map((t) => t.bar), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  await session.start(500);
  assert.equal(session.getState().phase, 'count-in');
  assert.equal(store.created.length, 1);
  assert.equal(store.created[0]?.['referenceId'], furElise().id);
  // three count-in clicks, an eighth note apart at ♩ = 72, halved: (60 / 72) / 2 / 0.5 = 0.833 s
  assert.deepEqual(sounds.clicks.slice(0, 3).map((c) => Math.round((c.at - 500) * 1000)), [0, 833, 1667]);
  // the reference's first loop note sounds when the count-in ends
  const first = session.due(0, (loop[0] as { time: number }).time) as number;
  assert.ok(Math.abs(first - 502.5) < 1e-5, String(first));
  assert.ok(sounds.notes.some((n) => n.key === 64 && Math.abs(n.at - first) < 1e-9));
  session.tick(501);
  // the file's tempo is 833 333 µs a quarter (♩ = 72 to the microsecond): times agree with the round numbers to a microsecond
  assert.ok(Math.abs((session.getState().secondsToStart as number) - 1.5) < 1e-5);

  // pass 0 played well, 30 ms late each; pass 1 with one wrong note
  for (const pass of [0, 1]) {
    session.hear(loop.map((t, i) => note((session.due(pass, t.time) as number) + 0.03, pass === 1 && i === 4 ? t.key + 1 : t.key)));
  }
  session.tick((session.due(1, (loop[0] as { time: number }).time) as number) + 0.01);
  assert.equal(session.getState().passes.length, 1);
  assert.ok(session.getState().passes[0]?.results.every((r) => r.pitch === 'correct' && r.timing === 'on-time'), 'on time: 30 ms of capture time is 15 ms at half speed');
  await session.stop((session.due(1, (loop[9] as { time: number }).time) as number) + 0.5);
  const s = session.getState();
  assert.equal(s.phase, 'reviewing');
  assert.equal(s.passes.length, 2);
  assert.deepEqual(s.passes[1]?.results.map((r) => r.pitch), ['correct', 'correct', 'correct', 'correct', 'wrong', 'correct', 'correct', 'correct', 'correct', 'correct']);
  assert.match(s.feedback?.sentences.join(' ') ?? '', /Try bar 1 again/);
  await session.settled();
  assert.ok(store.finished);
  assert.equal(session.getState().attempt.kind, 'saved');
  // the attempt keeps every note heard and every judgement, in time order (the store refuses otherwise)
  assert.equal(store.events.filter((e) => e.kind === 'heard-note').length, 20);
  assert.equal(store.events.filter((e) => e.kind === 'assessment').length, 20);
  assert.ok(sounds.cancelled >= 2, 'playback cancelled at start and at stop');
});

test('step mode: the music waits — a wrong note is said and asked again, the right one moves on, and the review counts the retries', async () => {
  const session = new PracticeSession(furElise(), 1, { pickupTicks: 240 });
  session.configure({ mode: 'step', loop: { fromBar: 1, toBar: 1 } });
  await session.start(0);
  assert.equal(session.getState().phase, 'playing');
  const loop = session.getState().loopTargets;
  session.hear([note(1, (loop[0] as { key: number }).key + 2)]);
  assert.equal(session.getState().stepMessage, 'Not that one — try again.');
  assert.equal(session.getState().current?.id, loop[0]?.id);
  session.hear([note(2, (loop[0] as { key: number }).key - 12)]);
  assert.equal(session.getState().stepMessage, 'The right note, in another octave.');
  let t = 3;
  for (const target of loop) session.hear([note(t++, target.key)]);
  await session.settled();
  const s = session.getState();
  assert.equal(s.phase, 'reviewing');
  assert.ok(s.passes[0]?.results.every((r) => r.pitch === 'correct' && r.timing === null));
  assert.match(s.feedback?.sentences.join(' ') ?? '', /1 of them took more than one try/);
});

test('a recorder that fails is said to have failed — the practice goes on, and nothing claims the attempt was saved', async () => {
  const failing: AttemptStore = {
    create: async () => ({ ok: false as const, error: { code: 'transport.unreachable', message: 'the recorder did not start' } }),
    append: async () => ({ ok: true }),
    finish: async () => ({ ok: true }),
  };
  const session = new PracticeSession(furElise(), 1, { pickupTicks: 240, store: failing });
  await session.start(0);
  assert.deepEqual(session.getState().attempt, { kind: 'failed', message: 'the recorder did not start' });
  await session.stop(1);
  assert.equal(session.getState().phase, 'reviewing');
});
