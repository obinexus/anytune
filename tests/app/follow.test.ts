/**
 * Follow my playing (src/app/follow.ts), driven as the app drives it: SYNTHETIC plucks and strums, delivered in frames to the real live analyser, its
 * attacks to the session — the acceptance demonstration, step by step:
 *
 *   play nothing → the first target stays · the wrong note → the same target, "Heard F4; try E4 again." · corrected → exactly one target on · the note left
 *   ringing → nothing more · the same note again, a fresh attack → recognised · the microphone gone → the place kept, nothing marked · a phrase retried →
 *   "fewer retries"
 *
 * and the guards: a demonstration never answers itself; the accompaniment queues to the next target, once, and its own notes are no answer; Skip is
 * recorded apart; a chord wants the chord, not its root. No real guitar recording is used: none is in the repository.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveAnalyser } from '../../src/analysis/live.ts';
import { melodyArrangement, type Target } from '../../src/app/arrangement.ts';
import { compareText, FollowSession, noteTargets, passSummary, type FollowTarget } from '../../src/app/follow.ts';
import type { Playback } from '../../src/app/practice.ts';
import { OPEN_VOICINGS, soundingKeys } from '../../src/music/guitar.ts';
import { renderNotes } from '../../src/synthesis/pluck.ts';
import { strum } from '../../tools/analysis/evaluate-guitar.ts';
import { furElise } from '../support/fur-elise.ts';

const SR = 48000;
const FRAME = 1024;

/** A plucked note at 0.1 s into a buffer of `seconds`, with a real microphone's noise floor (never digital silence). */
function pluck(key: number, seconds = 0.8, duration = 0.5): Float32Array {
  const s = renderNotes([{ key, onsetSeconds: 0.1, durationSeconds: duration, velocity: 90 }], SR, 440, 0.2);
  return padded(s, seconds);
}
function padded(s: Float32Array, seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = (s[i] ?? 0) + 0.0004 * Math.sin(i * 1.3);
  return out;
}
const silence = (seconds: number): Float32Array => padded(new Float32Array(0), seconds);

/** The microphone and the live analysis, feeding the session frame by frame on a capture clock. */
class Ear {
  t = 10;
  readonly #analyser: LiveAnalyser;
  constructor(listenFor: 'notes' | 'both' = 'notes') {
    this.#analyser = new LiveAnalyser({ sampleRate: SR, listenFor, chordOffsets: [0.02, 0.09, 0.16] });
  }
  hear(follow: FollowSession, signal: Float32Array, live = true): void {
    for (let i = 0; i + FRAME <= signal.length; i += FRAME) {
      const events = this.#analyser.push(signal.slice(i, i + FRAME), this.t);
      this.t += FRAME / SR;
      if (live) follow.hear(events, this.t);
      follow.tick(this.t);
    }
  }
}

class Sounds implements Playback {
  readonly notes: { key: number; at: number; duration: number }[] = [];
  clicks = 0;
  cancelled = 0;
  note(key: number, at: number, duration: number): void {
    this.notes.push({ key, at, duration });
  }
  click(): void {
    this.clicks++;
  }
  cancelAll(): void {
    this.cancelled++;
  }
}

/** Für Elise's guitar melody, followed. */
function furEliseFollow(sounds: Sounds | null = null, accompaniment: 'parts' | 'none' = 'none') {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const targets = noteTargets(arrangement);
  const follow = new FollowSession(reference, arrangement, targets, { playback: sounds, melodyTrack: 1, pickupTicks: 240, settings: { accompaniment } });
  return { reference, arrangement, targets, follow };
}

/** Targets written out: notes (or chords) at successive beats. */
function written(...items: ({ key: number } | { chord: string })[]): FollowTarget[] {
  return items.map((it, i): FollowTarget => {
    if ('chord' in it) return { kind: 'chord', id: `t${i}`, time: i * 0.5, bar: 1, symbol: it.chord, voicing: OPEN_VOICINGS[it.chord] as NonNullable<(typeof OPEN_VOICINGS)[string]>, label: it.chord };
    const target: Target = { id: `t${i}`, key: it.key, time: i * 0.5, bar: 1, position: null };
    return { kind: 'note', id: `t${i}`, time: i * 0.5, bar: 1, key: it.key, label: '', target };
  }).map((t): FollowTarget => (t.kind === 'note' ? { ...t, label: ['E3', 'E3', 'G3'][Number(t.id.slice(1))] ?? '' } : t));
}

test('the acceptance demonstration: nothing played — the target stays; the wrong note — the same target, said; corrected — exactly one on', () => {
  const { follow, targets } = furEliseFollow();
  const ear = new Ear();
  follow.start(ear.t);
  const first = targets[0] as Extract<FollowTarget, { kind: 'note' }>;
  assert.equal(first.label, 'E4');
  assert.equal(follow.getState().message.text, 'Play E4');
  ear.hear(follow, silence(3));
  assert.equal(follow.getState().index, 0, 'three seconds of nothing: elapsed time never advances');
  assert.equal(follow.getState().pass.records.length, 0, 'and nothing is marked');
  ear.hear(follow, pluck(65));
  assert.equal(follow.getState().index, 0, 'the wrong note: the same target');
  assert.deepEqual(follow.getState().message, { text: 'Heard F4; try E4 again.', tone: 'wrong' });
  ear.hear(follow, pluck(65));
  assert.equal(follow.getState().index, 0, 'and again: no timeout, no skip');
  ear.hear(follow, pluck(64));
  assert.equal(follow.getState().index, 1, 'corrected: exactly one target on');
  assert.deepEqual(follow.getState().message, { text: 'Correct — after two retries', tone: 'correct' });
  const record = follow.getState().pass.records[0];
  assert.deepEqual([record?.outcome, record?.wrong], ['corrected', ['F4', 'F4']]);
  ear.hear(follow, silence(1));
  assert.equal(follow.getState().message.text, 'Play D♯4', '"Correct", briefly — then the next target');
});

test('a note left ringing satisfies nothing more — not even the same note repeated; a fresh attack on it does', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const targets = written({ key: 52 }, { key: 52 }, { key: 55 });
  const follow = new FollowSession(reference, arrangement, targets, { melodyTrack: 1 });
  const ear = new Ear();
  follow.start(ear.t);
  ear.hear(follow, pluck(52, 3.5, 3.2)); // E3, ringing for three seconds
  assert.equal(follow.getState().index, 1, 'one pluck: one target');
  assert.equal(follow.getState().pass.records.filter((r) => r.outcome === 'first-try').length, 1);
  ear.hear(follow, pluck(52)); // the same E3, plucked again
  assert.equal(follow.getState().index, 2, 'a fresh attack: the repeated target recognised');
  ear.hear(follow, pluck(55));
  assert.equal(follow.getState().phase, 'finished');
  assert.deepEqual(passSummary(follow.getState().pass), { firstTry: 3, corrected: 0, retries: 0, skipped: 0, unassessed: 0, reached: 3, medianResponse: passSummary(follow.getState().pass).medianResponse });
});

test('the microphone gone: assessment pauses, the place is kept, nothing is marked — and it listens again when the sound is back', () => {
  const { follow } = furEliseFollow();
  const ear = new Ear();
  follow.start(ear.t);
  ear.hear(follow, pluck(64));
  assert.equal(follow.getState().index, 1);
  follow.inputAvailable(false, ear.t);
  assert.equal(follow.getState().phase, 'input-paused');
  assert.match(follow.getState().message.text, /^The microphone stopped delivering sound\. Your place is kept and nothing is marked/);
  ear.hear(follow, pluck(70)); // something arrives anyway: not a verdict
  ear.hear(follow, pluck(63));
  assert.equal(follow.getState().index, 1, 'nothing advanced while paused');
  assert.equal(follow.getState().pass.records.length, 1, 'and nothing was marked');
  follow.inputAvailable(true, ear.t);
  assert.equal(follow.getState().phase, 'listening');
  ear.hear(follow, pluck(63));
  assert.equal(follow.getState().index, 2, 'the same place, continued');
  assert.equal(follow.getState().pass.records[1]?.outcome, 'first-try');
});

test('Hear this target: the reference plays it and listening is suspended until it has died away — the app never answers itself', () => {
  const sounds = new Sounds();
  const { follow } = furEliseFollow(sounds);
  const ear = new Ear();
  follow.start(ear.t);
  follow.demonstrate(ear.t);
  assert.equal(follow.getState().phase, 'demonstrating');
  assert.deepEqual(sounds.notes.map((n) => n.key), [64]);
  ear.hear(follow, pluck(64, 1.2)); // the speaker's E4, on the microphone
  assert.equal(follow.getState().index, 0, 'its own note is not an answer');
  ear.hear(follow, silence(0.6));
  assert.equal(follow.getState().phase, 'listening');
  ear.hear(follow, pluck(64));
  assert.equal(follow.getState().index, 1, 'the learner\'s own E4, after: accepted');
});

test('the accompaniment: on each target, the other part plays up to the next one — once, clipped there — and its own notes are never an answer', () => {
  const sounds = new Sounds();
  const { follow, targets, reference } = furEliseFollow(sounds, 'parts');
  assert.equal(follow.getState().hasParts, true, 'Für Elise: the left hand is a part of its own');
  const leftHand = reference.notes.filter((n) => n.track === 2);
  // the first target whose time slot holds left-hand notes
  const k = targets.findIndex((t, i) => leftHand.some((n) => n.onsetSeconds >= t.time && n.onsetSeconds < (targets[i + 1]?.time ?? Infinity)));
  assert.ok(k > 0, 'the left hand enters after the melody has begun');
  const ear = new Ear();
  follow.start(ear.t);
  for (const t of targets.slice(0, k)) ear.hear(follow, pluck((t as { key: number }).key));
  assert.equal(sounds.notes.length, 0, 'no accompaniment before its time');
  ear.hear(follow, pluck((targets[k] as { key: number }).key, 0.45)); // target k, accepted near the end of this buffer
  const tk = (targets[k] as FollowTarget).time;
  const tk1 = (targets[k + 1] as FollowTarget).time;
  const due = leftHand.filter((n) => n.onsetSeconds >= tk && n.onsetSeconds < tk1);
  assert.deepEqual(sounds.notes.map((n) => n.key), due.map((n) => n.key), 'exactly the left hand between this target and the next — nothing beyond');
  assert.ok(sounds.notes.every((n) => n.duration <= tk1 - tk + 1e-9), 'clipped at the next target: nothing hangs while the learner works');
  // the accompaniment's own note reaches the microphone: no verdict, no mistake
  const own = sounds.notes[0] as { key: number };
  ear.hear(follow, pluck(own.key, 0.6));
  assert.equal(follow.getState().index, k + 1);
  assert.equal(follow.getState().pass.records.find((r) => r.index === k + 1)?.wrong.length ?? 0, 0, 'AnyTune\'s own note is not counted against the learner');
  assert.match(follow.getState().message.text, /AnyTune's own note/);
  // the learner is slow: nothing more plays, however long
  ear.hear(follow, silence(3));
  assert.equal(sounds.notes.length, due.length, 'the accompaniment waits with the learner');
  // the next target accepted: its own slot plays, and the earlier notes are not played again
  ear.hear(follow, pluck((targets[k + 1] as { key: number }).key));
  const after = leftHand.filter((n) => n.onsetSeconds >= tk1 && n.onsetSeconds < ((targets[k + 2] as FollowTarget | undefined)?.time ?? Infinity));
  assert.equal(sounds.notes.length, due.length + after.length, 'no note scheduled twice');
});

test('Skip: the target is recorded as skipped — never as a success — and the next one follows; while the microphone is out, it is unassessed', () => {
  const { follow } = furEliseFollow();
  const ear = new Ear();
  follow.start(ear.t);
  follow.skip(ear.t);
  assert.equal(follow.getState().index, 1);
  assert.equal(follow.getState().pass.records[0]?.outcome, 'skipped');
  follow.inputAvailable(false, ear.t);
  follow.skip(ear.t);
  assert.equal(follow.getState().index, 2);
  assert.equal(follow.getState().pass.records[1]?.outcome, 'unassessed');
  assert.equal(follow.getState().phase, 'input-paused', 'still paused: the microphone is still out');
});

test('a phrase retried: compared with its last pass — "You corrected this passage with two fewer retries"', () => {
  const { follow, targets } = furEliseFollow();
  const ear = new Ear();
  follow.start(ear.t);
  follow.repeatBar(ear.t); // bar 0: the pickup, E4 D♯4
  const pass = follow.getState().pass;
  const phrase = targets.slice(pass.from, pass.to + 1) as Extract<FollowTarget, { kind: 'note' }>[];
  assert.deepEqual(phrase.map((t) => t.label), ['E4', 'D♯4']);
  // first time: two wrong tries on the first target, then right
  ear.hear(follow, pluck(65));
  ear.hear(follow, pluck(62));
  for (const t of phrase) ear.hear(follow, pluck(t.key));
  assert.equal(follow.getState().phase, 'phrase-done');
  assert.equal(follow.getState().comparison, '', 'nothing to compare yet');
  // again: no wrong tries
  follow.repeatPhrase(ear.t);
  for (const t of phrase) ear.hear(follow, pluck(t.key));
  assert.equal(follow.getState().phase, 'phrase-done');
  assert.match(follow.getState().comparison, /^You corrected this passage with two fewer retries \(0; last time 2\)\. First try: 2 of 2 \(last time 1\)\./);
  const [first, second] = follow.getState().history.filter((p) => p.done);
  assert.ok(first !== undefined && second !== undefined);
  assert.deepEqual(first.records[0]?.wrong, ['F4', 'D4'], 'the corrected target keeps its retry history');
  assert.equal(compareText(second, first).startsWith('Two more retries than last time'), true);
});

test('chords: a strum of the target chord is accepted; another chord is said by name; the root alone is not the chord; one strum, one target', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const follow = new FollowSession(reference, arrangement, written({ chord: 'E' }, { chord: 'Am' }), { melodyTrack: 1 });
  const ear = new Ear('both');
  const chord = (symbol: string, seed: number): Float32Array => strum(soundingKeys(OPEN_VOICINGS[symbol] as NonNullable<(typeof OPEN_VOICINGS)[string]>), seed, 30, 1.4);
  follow.start(ear.t);
  assert.equal(follow.getState().message.text, 'Play the E chord');
  ear.hear(follow, chord('E', 1001));
  assert.equal(follow.getState().index, 1, 'one strum — its strings spread over ~100 ms — one target');
  ear.hear(follow, chord('E', 1003));
  assert.deepEqual(follow.getState().message, { text: 'Heard E; try Am again.', tone: 'wrong' });
  ear.hear(follow, pluck(45, 1.2));
  assert.deepEqual(follow.getState().message, { text: 'Heard only A2 — strum all the strings of Am.', tone: 'wrong' });
  assert.equal(follow.getState().index, 1, 'the root alone did not count');
  ear.hear(follow, chord('Am', 1002));
  assert.equal(follow.getState().phase, 'finished');
  assert.deepEqual(follow.getState().pass.records.map((r) => [r.outcome, r.wrong]), [['first-try', []], ['corrected', ['E', 'A2']]]);
});
