/**
 * The announcement policy: what assistive technology is told, and when — held apart from the visual refresh, which may change many times a second. A tuner
 * that announced every reading would flood a screen reader; this one says:
 *
 *   - when the note or the tuning status changes ("A2, 32 cents flat", "A2, in tune");
 *   - when a reading becomes steady ("A2, in tune and steady");
 *   - when the signal is lost or becomes uncertain, and when listening starts or stops;
 *   - never the same words twice in a row, and at most one announcement a second — a change inside that second is announced when the second ends, as its
 *     latest state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Announcer, DEFAULT_ANNOUNCE_POLICY, announcementOf } from '../../src/app/announcer.ts';
import type { AnyTuneState } from '../../src/app/session.ts';
import type { TuningReading } from '../../src/domain/tuning.ts';
import { DEFAULT_POLICY, findTuning, readPitch } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const guitar = findTuning(CATALOG, 'guitar-standard');
assert.ok(guitar);
const IDLE: AnyTuneState = { session: 'idle', instrumentId: 'guitar-standard', reading: null, stable: false, signal: 'none', input: { state: 'idle', connected: false, confidence: 0 }, error: null };
const LISTENING: AnyTuneState = { ...IDLE, session: 'listening', input: { state: 'listening', connected: true, confidence: 0 } };
const at = (hz: number, stable = false, confidence = 0.95): AnyTuneState => {
  const reading = readPitch({ frequencyHz: hz, confidence }, guitar, DEFAULT_POLICY) as TuningReading;
  return { ...LISTENING, reading, stable, signal: reading.status === 'uncertain' ? 'uncertain' : 'present', input: { ...LISTENING.input, confidence } };
};

test('the policy: at most one announcement a second', () => {
  assert.deepEqual({ ...DEFAULT_ANNOUNCE_POLICY }, { minIntervalMs: 1000 });
  assert.ok(Object.isFrozen(DEFAULT_ANNOUNCE_POLICY));
});

test('the words: the note, then the cents in whole numbers and flat or sharp — or in tune, steady, uncertain, no signal, listening, stopped', () => {
  assert.equal(announcementOf(at(108)), 'A2, 32 cents flat');
  assert.equal(announcementOf(at(111.5)), 'A2, 23 cents sharp');
  assert.equal(announcementOf(at(110)), 'A2, in tune');
  assert.equal(announcementOf(at(110, true)), 'A2, in tune and steady');
  assert.equal(announcementOf(at(108.1, true)), 'A2, 30 cents flat and steady');
  assert.equal(announcementOf(at(108, false, 0.2)), 'Signal uncertain');
  assert.equal(announcementOf(LISTENING), 'Listening. Play a note.');
  assert.equal(announcementOf(IDLE), 'Stopped');
  assert.equal(announcementOf({ ...IDLE, input: { state: 'ended', connected: false, confidence: 0 } }), 'Recording ended', 'a replay that ends is not the user stopping');
  assert.equal(announcementOf({ ...IDLE, session: 'error', error: { kind: 'disconnected' } }), '', 'an error is an alert of its own, not a status announcement');
});

test('the acceptance sequence, 250 ms apart: four readings, two announcements — flat at once, then "in tune and steady" when the second is over', () => {
  const clock = new ManualScheduler();
  const announcer = new Announcer(clock);
  const said: string[] = [];
  announcer.subscribe((text) => said.push(`${clock.now()} ${text}`));
  announcer.observe(LISTENING);
  clock.advance(1000);
  said.length = 0;
  for (const [i, state] of [at(108), at(109), at(110), at(110, true)].entries()) {
    if (i > 0) clock.advance(250);
    announcer.observe(state);
  }
  clock.advance(1000);
  assert.deepEqual(said, ['1000 A2, 32 cents flat', '2000 A2, in tune and steady']);
  assert.equal(announcer.current(), 'A2, in tune and steady');
});

test('the cents moving within one status say nothing new; the same words are never said twice in a row', () => {
  const clock = new ManualScheduler();
  const announcer = new Announcer(clock);
  const said: string[] = [];
  announcer.subscribe((text) => said.push(text));
  announcer.observe(at(108));
  for (const hz of [107.5, 107.9, 108.2, 108.4]) {
    clock.advance(1500);
    announcer.observe(at(hz));
  }
  assert.deepEqual(said, ['A2, 32 cents flat']);
});

test('a change inside the interval is announced when it ends — its latest state, and only if that differs from what was said', () => {
  const clock = new ManualScheduler();
  const announcer = new Announcer(clock);
  const said: string[] = [];
  announcer.subscribe((text) => said.push(`${clock.now()} ${text}`));
  announcer.observe(at(108));
  clock.advance(200);
  announcer.observe(at(111.5));
  clock.advance(200);
  announcer.observe(at(108));
  clock.advance(2000);
  assert.deepEqual(said, ['0 A2, 32 cents flat'], 'flat, sharp, flat within the second: back to what was said, so nothing more');
  announcer.observe(at(82.41));
  clock.advance(100);
  announcer.observe(at(110));
  clock.advance(2000);
  assert.deepEqual(said, ['0 A2, 32 cents flat', '2400 E2, in tune', '3400 A2, in tune']);
});

test('losing the signal, and becoming uncertain, are said once; stopping cancels what was waiting', () => {
  const clock = new ManualScheduler();
  const announcer = new Announcer(clock);
  const said: string[] = [];
  announcer.subscribe((text) => said.push(text));
  announcer.observe(at(110));
  clock.advance(1000);
  announcer.observe(LISTENING);
  clock.advance(1000);
  announcer.observe(at(110, false, 0.2));
  clock.advance(500);
  announcer.observe(at(108)); // inside the interval: waiting…
  clock.advance(100);
  announcer.observe(IDLE); // …and replaced by stopping, said when the interval ends
  clock.advance(5000);
  assert.deepEqual(said, ['A2, in tune', 'Listening. Play a note.', 'Signal uncertain', 'Stopped']);
  assert.equal(clock.pending, 0);
});
