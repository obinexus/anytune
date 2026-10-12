/**
 * Play (src/app/play.ts, src/lesson/play-clock.ts, src/app/play-view.ts): one clock drives the playback and the prompts. Driven here frame by frame on a
 * virtual audio clock, through a pause, a resume, a tempo change and a restart, with a playback that records what it was asked to play and what was
 * cancelled: every note that sounds, sounds once, at the audio time the clock gives its song time — and its prompt is at the "Now" playhead when it does.
 * Feedback: judged against the arrangement, placed on the song by the same clock (nothing heard during a pause counts), only where the capture covered,
 * and none at all without feedback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveEvent } from '../../src/analysis/live.ts';
import { melodyArrangement } from '../../src/app/arrangement.ts';
import { PlaySession } from '../../src/app/play.ts';
import { playTimelineInput, TIMELINE, timelineView } from '../../src/app/play-view.ts';
import type { Playback } from '../../src/app/practice.ts';
import { PlayClock, beatGrid } from '../../src/lesson/play-clock.ts';
import { furElise } from '../support/fur-elise.ts';

const FRAME = 1 / 60;

test('the play clock: a count-in, then the song; a pause holds the position and maps no audio time to the song; a resume and a tempo change continue from where it was', () => {
  const c = new PlayClock();
  c.start(10, 0, 1);
  assert.equal(c.position(9), 0, 'the count-in: the song has not started');
  assert.equal(c.refAt(9), null);
  assert.ok(Math.abs((c.refAt(9.9, 0.15)?.time ?? 0) + 0.1) < 1e-9, 'a first note a little early belongs to the song, just before its start');
  assert.equal(c.refAt(9.8, 0.15), null, 'too early: still the count-in');
  assert.equal(c.position(11), 1);
  assert.equal(c.audioTimeOf(2), 12);
  c.pause(12.5);
  assert.equal(c.position(100), 2.5, 'held');
  assert.equal(c.audioTimeOf(3), null, 'nothing is due while paused');
  assert.equal(c.refAt(14), null, 'a sound during the pause is no part of the song');
  assert.equal(c.refAt(11)?.time, 1, 'the past keeps its mapping');
  c.resume(20);
  assert.equal(c.position(21), 3.5);
  assert.equal(c.refAt(21)?.time, 3.5);
  c.setTempo(22, 0.5);
  assert.equal(c.position(22), 4.5);
  assert.equal(c.position(24), 5.5, 'half speed: a song second takes two');
  assert.equal(c.audioTimeOf(6), 25);
  assert.deepEqual(c.refAt(23), { time: 5, tempo: 0.5 });
  assert.equal(c.refAt(21.5)?.time, 4, 'before the change, the old tempo');
});

test('the beat grid of the score: the pickup is the last beat of bar 0, then bars of three eighths', () => {
  const beats = beatGrid(furElise(), 240);
  assert.deepEqual(beats.slice(0, 5).map((b) => [b.bar, b.beat, b.of]), [[0, 3, 3], [1, 1, 3], [1, 2, 3], [1, 3, 3], [2, 1, 3]]);
  assert.ok(Math.abs((beats[1]?.time ?? 0) - 60 / 72 / 2) < 1e-4, 'an eighth at ♩ = 72');
});

class RecordingPlayback implements Playback {
  now = 0;
  readonly notes: { key: number; at: number; cancelledAt: number | null }[] = [];
  readonly clicks: { at: number; cancelledAt: number | null }[] = [];
  note(key: number, at: number): void {
    this.notes.push({ key, at, cancelledAt: null });
  }
  click(at: number): void {
    this.clicks.push({ at, cancelledAt: null });
  }
  cancelAll(): void {
    for (const n of [...this.notes, ...this.clicks]) if (n.cancelledAt === null && n.at > this.now) n.cancelledAt = this.now;
  }
  /** what was heard: scheduled, and not cancelled before its time */
  sounded(): { key: number; at: number }[] {
    return this.notes.filter((n) => n.cancelledAt === null).map(({ key, at }) => ({ key, at }));
  }
}

test('pause, resume, a tempo change and a restart: every note sounds once, when the clock says its song time is due — and its prompt is at "Now" as it sounds', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const playback = new RecordingPlayback();
  const play = new PlaySession(reference, arrangement, { playback, pickupTicks: 240 });
  const promptChecks: number[] = [];
  let now = 0;
  const run = (until: number, at?: (t: number) => void): void => {
    for (; now < until && play.getState().phase !== 'finished'; now += FRAME) {
      playback.now = now;
      at?.(now);
      const before = playback.sounded().length;
      play.tick(now);
      // a note that has just sounded: its prompt is where "Now" is, less the real time since it sounded (the timeline runs at a fixed real speed)
      const view = timelineView(playTimelineInput(play.getState()), 360);
      for (const n of playback.sounded().slice(0, before)) {
        if (n.at > now - FRAME && n.at <= now) {
          const target = arrangement.targets.find((t) => t.key === n.key && Math.abs((play.getState().position - t.time) - (now - n.at) * play.getState().settings.tempoFactor) < 1e-6);
          const prompt = view.prompts.find((p) => p.key === `prompt-${target?.id}`);
          if (prompt !== undefined) promptChecks.push(Math.abs(prompt.textX - (view.playheadX - (now - n.at) * TIMELINE.pixelsPerSecond)));
        }
      }
    }
  };
  play.start(0);
  run(3);
  play.pause(now);
  playback.now = now;
  run(5);
  assert.equal(play.getState().phase, 'paused');
  const heldAt = play.getState().position;
  play.resume(now);
  run(9);
  play.configure(now, { tempoFactor: 0.5 });
  run(60);
  assert.equal(play.getState().phase, 'finished');
  assert.ok(heldAt > 1, 'paused part-way');

  // every target sounded exactly once, at the audio time whose song time is the target's — through the pause and the tempo change
  const sounded = playback.sounded();
  assert.equal(sounded.length, arrangement.targets.length);
  arrangement.targets.forEach((t, i) => assert.equal(sounded[i]?.key, t.key, `note ${i}`));
  const cancelled = playback.notes.filter((n) => n.cancelledAt !== null);
  assert.ok(cancelled.length > 0, 'the pause and the tempo change cancelled what was scheduled ahead');
  assert.ok(cancelled.every((n) => n.at > (n.cancelledAt as number)), 'only what had not sounded yet');
  // the prompts: at "Now" when their notes sounded
  assert.ok(promptChecks.length >= arrangement.targets.length - 2, `${promptChecks.length} checks`);
  assert.ok(promptChecks.every((d) => d < 0.2), `the largest gap was ${Math.max(...promptChecks)} px`);

  // a restart: the song again from its start, each note once more, on the new run's clock
  const firstRun = playback.notes.length;
  play.start(now);
  run(now + 50);
  const second = playback.notes.slice(firstRun).filter((n) => n.cancelledAt === null);
  assert.deepEqual(second.map((n) => n.key), arrangement.targets.map((t) => t.key));
  assert.equal(play.getState().run, 2);
});

test('the song times of the sounded notes are exactly their targets\' times, read back through the clock — whatever the pauses and tempo changes', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const playback = new RecordingPlayback();
  const play = new PlaySession(reference, arrangement, { playback, pickupTicks: 240 });
  const songTimeAt: { at: number; song: number }[] = [];
  let now = 0;
  play.start(0);
  for (; play.getState().phase !== 'finished'; now += FRAME) {
    playback.now = now;
    if (Math.abs(now - 2.5) < FRAME / 2) play.pause(now);
    if (Math.abs(now - 4) < FRAME / 2) play.resume(now);
    if (Math.abs(now - 7) < FRAME / 2) play.configure(now, { tempoFactor: 0.75 });
    play.tick(now);
    // record the clock's own mapping for every note scheduled so far that has not been cancelled
    for (const n of playback.notes) if (n.cancelledAt === null && !songTimeAt.some((s) => s.at === n.at)) songTimeAt.push({ at: n.at, song: play.positionAt(n.at) });
  }
  const sounded = playback.sounded();
  sounded.forEach((n, i) => {
    const t = arrangement.targets[i];
    const mapped = songTimeAt.find((s) => s.at === n.at);
    assert.ok(t !== undefined && mapped !== undefined && Math.abs(mapped.song - t.time) < 1e-9, `note ${i}: ${mapped?.song} vs ${t?.time}`);
  });
});

/** A learner, heard: each note as the live analysis would report it, at its capture time. */
const heard = (time: number, key: number): LiveEvent => ({ kind: 'note', time, key, cents: 2, confidence: 0.9, observations: [] });

test('feedback in Play: judged against the arrangement as the song passes; a note heard during a pause is no part of it; only what the capture covered counts', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const LAG = 0.05;
  const coverageEnds = 6; // the microphone stops delivering at audio time 6
  const play = new PlaySession(reference, arrangement, { pickupTicks: 240 });
  play.configure(0, { inputLatencySeconds: LAG });
  play.start(0, { assess: true, capture: { healthyBetween: (_from, to) => to <= coverageEnds } });
  let now = 0;
  let paused = false;
  const played = new Set<string>();
  for (; play.getState().phase !== 'finished'; now += FRAME) {
    if (!paused && now >= 3) {
      play.pause(now);
      play.hear([heard(now + 0.2, 40)]); // a note while paused: ignored
      paused = true;
      now += 1;
      play.resume(now);
    }
    play.tick(now);
    // the learner plays each target as it arrives: every one right — except the fourth, a semitone high
    arrangement.targets.forEach((t, i) => {
      const due = play.dueAt(t.time);
      if (due === null || played.has(t.id) || now < due + LAG) return;
      played.add(t.id);
      play.hear([heard(due + LAG, i === 3 ? t.key + 1 : t.key)]);
    });
  }
  const results = play.getState().results;
  assert.equal(results.length, arrangement.targets.length, 'every target judged');
  const by = (p: string) => results.filter((r) => r.pitch === p).length;
  const unassessed = by('unassessed');
  assert.ok(unassessed > 0 && unassessed < arrangement.targets.length, `${unassessed} unassessed: those after the microphone stopped`);
  assert.equal(by('wrong'), 1, 'the semitone slip');
  assert.equal(by('missed'), 0, 'nothing heard during the pause stood in for a note, and nothing unheard is called missed');
  assert.equal(by('correct'), arrangement.targets.length - unassessed - 1);
  const fb = play.getState().feedback;
  assert.ok(fb !== null && fb.pitch.assessed === arrangement.targets.length - unassessed);
  assert.match(fb.sentences.join(' '), new RegExp(`Assessed: ${fb.pitch.assessed} of ${arrangement.targets.length} notes`));
});

test('Play without feedback: nothing is listened to — no results, no score — even when sound arrives', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const play = new PlaySession(reference, arrangement, { pickupTicks: 240 });
  play.start(0);
  let now = 0;
  for (; play.getState().phase !== 'finished'; now += FRAME) {
    play.tick(now);
    play.hear([heard(now, 64)]);
  }
  assert.equal(play.getState().assessing, false);
  assert.deepEqual(play.getState().results, []);
  assert.equal(play.getState().feedback, null);
});

test('what is "now": the note at the playhead while it sounds; in a rest, nothing is at "Now" and the note coming is shown as next', () => {
  const reference = furElise();
  const arrangement = melodyArrangement(reference, 1, 240);
  const release = (id: string): number => reference.notes.find((n) => n.id === id)?.releaseSeconds ?? 0;
  // a rest in the melody: a note that ends well before the next begins
  const i = arrangement.targets.findIndex((t, k) => k + 1 < arrangement.targets.length && (arrangement.targets[k + 1] as { time: number }).time - release(t.id) > 0.15);
  assert.ok(i >= 0, 'the opening has a rest');
  const note = arrangement.targets[i] as (typeof arrangement.targets)[number];
  const coming = arrangement.targets[i + 1] as (typeof arrangement.targets)[number];
  const play = new PlaySession(reference, arrangement, { pickupTicks: 240 });
  play.start(0);
  const audioAt = (song: number): number => play.dueAt(song) as number;
  play.tick(audioAt(note.time) + 0.01);
  assert.deepEqual([play.getState().current?.id, play.getState().atPlayhead], [note.id, true]);
  const rest = (release(note.id) + coming.time) / 2;
  play.tick(audioAt(rest));
  assert.deepEqual([play.getState().current?.id, play.getState().atPlayhead], [coming.id, false]);
  const view = timelineView(playTimelineInput(play.getState()), 360);
  assert.equal(view.prompts.find((p) => p.key === `prompt-${coming.id}`)?.kind, 'next');
  assert.equal(view.prompts.filter((p) => p.kind === 'now').length, 0, 'nothing filled at "Now" in a rest');
});
