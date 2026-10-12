/**
 * A practice's attempt saved through Polycall: the practice session (src/app/practice.ts) with AnyTune's recorder module as its store — the staged
 * polycall.exe serving the recorder plugin on loopback, reached by PolycallRecorder over polycall_rpc v1 (tests/support/polycall-recorder.ts). The attempt is
 * replayed from the module and must hold what the session said it saved: the reference it was played against, every note heard and every judgement, in time
 * order, finished. The learner's notes are given as the live analysis delivers them (tests/components/shell.test.ts plays them as audio). Skipped — saying
 * so — when the native artifacts are not staged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveEvent } from '../../src/analysis/live.ts';
import { PracticeSession } from '../../src/app/practice.ts';
import { SKIP, startRecorder, type RunningRecorder } from '../support/polycall-recorder.ts';
import { furElise } from '../support/fur-elise.ts';

let running: RunningRecorder | null = null;
before(async () => {
  if (SKIP === false) running = await startRecorder();
});
after(async () => {
  await running?.stop();
});

const note = (time: number, key: number): LiveEvent => ({ kind: 'note', time, key, cents: -4, confidence: 0.92, observations: [] });

test('an attempt at bar 1, looped twice, is saved through Polycall and replayed whole: its reference named, every note and judgement in order, finished', { skip: SKIP }, async () => {
  assert.ok(running);
  const reference = furElise();
  const session = new PracticeSession(reference, 1, { pickupTicks: 240, store: running.recorder });
  session.configure({ loop: { fromBar: 1, toBar: 1 }, tempoFactor: 0.75 });
  const loop = session.getState().loopTargets;
  await session.start(100);
  await session.settled();
  const attempt = session.getState().attempt;
  assert.equal(attempt.kind, 'recording');
  // two passes: the first right, the second with its third note a semitone high
  for (const pass of [0, 1]) {
    session.hear(loop.map((t, i) => note((session.due(pass, t.time) as number) + 0.02, pass === 1 && i === 2 ? t.key + 1 : t.key)));
    session.tick((session.due(pass + 1, (loop[0] as { time: number }).time) as number) + 0.3);
  }
  await session.stop((session.due(2, (loop[0] as { time: number }).time) as number) + 0.05);
  await session.settled();
  const saved = session.getState().attempt;
  assert.equal(saved.kind, 'saved', JSON.stringify(saved));
  assert.ok(saved.kind === 'saved');

  const replay = await running.recorder.replay(saved.recordingId);
  assert.ok(replay.ok, JSON.stringify(replay));
  const { header, events, complete, intact } = replay.value;
  assert.deepEqual([header.format, header.kind, complete, intact], ['anytune-recording', 'attempt', true, true]);
  assert.equal(header.meta['referenceId'], reference.id, 'the attempt names the reference it was played against');
  assert.deepEqual((header.meta['settings'] as { loop: unknown; tempoFactor: number }).loop, { fromBar: 1, toBar: 1 });
  assert.equal(events.length, saved.events, 'every event the session said it saved');
  assert.ok(events.every((e, i) => i === 0 || e.t >= (events[i - 1] as { t: number }).t), 'in time order');
  assert.equal(events.filter((e) => e.kind === 'heard-note').length, loop.length * 2);
  const judged = events.filter((e) => e.kind === 'assessment');
  assert.equal(judged.length, loop.length * 2);
  assert.deepEqual(judged.filter((e) => e['pass'] === 1).map((e) => e['pitch']), loop.map((_, i) => (i === 2 ? 'wrong' : 'correct')));

  const listed = await running.recorder.list(reference.id);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.recordings.map((r) => [r.recordingId, r.kind, r.complete, r.events]), [[saved.recordingId, 'attempt', true, saved.events]]);
});
