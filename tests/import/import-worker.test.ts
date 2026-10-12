/**
 * The import worker end to end, on owned media — nothing mocked: an MP4 made here from the Für Elise score (tools/fixtures/media.ts) goes through the real
 * FFmpeg, the real Basic Pitch and the real Polycall with AnyTune's recorder: queued → decoding → transcribing → reviewing (it waits for the learner) →
 * accepted → recording → ready. The source is kept unchanged, the MIDI and the reference are separate files, the estimate is marked as one, and the timed
 * reference recording is a valid anytune-recording/1. Skipped, saying why, when FFmpeg, the worker's dependencies or the staged Polycall are missing.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreNotes } from '../../src/import/transcription.ts';
import type { Reference } from '../../src/music/reference.ts';
import { readRecording } from '../../src/recording/format.ts';
import { stagedPolycall } from '../../services/import-worker/src/polycall-host.ts';
import { acceptReview, createJob, jobDirectory, runJob, type WorkerConfig } from '../../services/import-worker/src/pipeline.ts';
import { findTools } from '../../services/import-worker/src/tools.ts';
import { DEFAULT_LIMITS } from '../../src/import/url-policy.ts';
import { FUR_ELISE_MIDI, makeMp4, notesOfMidi } from '../../tools/fixtures/media.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const workerInstalled = fs.existsSync(path.join(ROOT, 'services', 'import-worker', 'node_modules', '@spotify', 'basic-pitch'));
let skip: string | false = false;
let config: WorkerConfig;
let dir = '';
let mp4 = '';
const truth = notesOfMidi(FUR_ELISE_MIDI, [1]).filter((n) => n.onsetSeconds < 5.5); // the melody's first bars: a short test

before(async () => {
  const tools = await findTools();
  if (!workerInstalled) skip = 'the worker’s dependencies are not installed (npm --prefix services/import-worker ci)';
  else if (!tools.ffmpeg.found || !tools.ffprobe.found) skip = 'FFmpeg is not available';
  else if (stagedPolycall() === null) skip = 'Polycall and the recorder plugin are not staged (npm run native:stage && npm run native:recorder)';
  if (skip !== false) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-import-'));
  mp4 = makeMp4((tools.ffmpeg as { path: string }).path, truth, dir, 'furelise');
  config = { library: path.join(dir, 'library'), tools, limits: DEFAULT_LIMITS, instrument: 'acoustic-guitar', log: () => {} };
});

after(() => {
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('furelise.mp4: decoded, transcribed into a reviewable MIDI and reference, kept unchanged — then, accepted, recorded through Polycall and ready', { timeout: 300000 }, async (t) => {
  if (skip !== false) return t.skip(skip);
  const before = sha(mp4);
  const job = await runJob(config, createJob(config, { kind: 'file', path: mp4 }, null));
  assert.equal(job.stage, 'reviewing', JSON.stringify(job.failure));
  assert.deepEqual(job.history.map((h) => h.stage), ['queued', 'decoding', 'transcribing', 'reviewing']);
  const jobDir = jobDirectory(config, job.id);
  // the original is untouched, and the job's copy is byte for byte the same
  assert.equal(sha(mp4), before);
  assert.equal(sha(path.join(jobDir, job.outputs['source'] as string)), before);
  // distinct assets: the source, the MIDI, the reference, the engine's report
  for (const file of ['source.mp4', 'transcription.mid', 'reference.json', 'transcription.json']) assert.ok(fs.existsSync(path.join(jobDir, file)), file);
  const reference = JSON.parse(fs.readFileSync(path.join(jobDir, 'reference.json'), 'utf8')) as Reference;
  assert.equal(reference.review.state, 'unreviewed');
  assert.ok(reference.notes.every((n) => n.estimated && n.confidence !== null));
  assert.equal(reference.provenance.kind, 'transcription');
  if (reference.provenance.kind === 'transcription') {
    assert.equal(reference.provenance.engine.name, '@spotify/basic-pitch');
    assert.equal(reference.provenance.source.sha256, before);
    assert.equal(reference.provenance.midi.sha256, sha(path.join(jobDir, 'transcription.mid')));
  }
  // what it heard, against the score it was made from: measured, not assumed
  const score = scoreNotes(truth.map((n) => ({ key: n.key, onsetSeconds: n.onsetSeconds })), reference.notes.map((n) => ({ key: n.key, onsetSeconds: n.onsetSeconds })));
  assert.ok(score.recall >= 0.9 && score.f1 >= 0.85, JSON.stringify(score));

  const ready = await acceptReview(config, job);
  assert.equal(ready.stage, 'ready', JSON.stringify(ready.failure));
  assert.match(ready.outputs['recording'] ?? '', /^[0-9a-f]{32}$/);
  const accepted = JSON.parse(fs.readFileSync(path.join(jobDir, 'reference.json'), 'utf8')) as Reference;
  assert.equal(accepted.review.state, 'reviewed');
  const recording = readRecording(new Uint8Array(fs.readFileSync(path.join(config.library, 'recordings', `${ready.outputs['recording']}.atrec`))));
  assert.ok(recording.ok && recording.complete && recording.intact);
  assert.equal(recording.header.kind, 'reference');
  assert.equal(recording.header.meta['referenceId'], accepted.id);
  assert.equal(recording.events.length, accepted.notes.length);
  assert.deepEqual(recording.events.map((e) => e['key']), accepted.notes.map((n) => n.key));
});

test('a MIDI file is a reference at once — stated, not estimated, no review — recorded through Polycall and ready', { timeout: 120000 }, async (t) => {
  if (skip !== false) return t.skip(skip);
  const job = await runJob(config, createJob(config, { kind: 'midi', path: FUR_ELISE_MIDI }, null));
  assert.equal(job.stage, 'ready', JSON.stringify(job.failure));
  assert.deepEqual(job.history.map((h) => h.stage), ['queued', 'recording', 'ready']);
  const reference = JSON.parse(fs.readFileSync(path.join(jobDirectory(config, job.id), 'reference.json'), 'utf8')) as Reference;
  assert.equal(reference.review.state, 'reviewed');
  assert.ok(reference.notes.every((n) => !n.estimated));
  assert.equal(reference.notes.length, 48);
});

test('a file that is not media fails where it fails — at decoding, not retryable, said in words — and is left as it was', { timeout: 60000 }, async (t) => {
  if (skip !== false) return t.skip(skip);
  const fake = path.join(dir, 'not-a-video.mp4');
  fs.writeFileSync(fake, 'this is text, renamed .mp4');
  const job = await runJob(config, createJob(config, { kind: 'file', path: fake }, null));
  assert.equal(job.stage, 'failed');
  assert.deepEqual([job.failure?.stage, job.failure?.code, job.failure?.retryable], ['decoding', 'media.unreadable', false]);
  assert.equal(fs.readFileSync(fake, 'utf8'), 'this is text, renamed .mp4');
});

test('without FFmpeg the job fails at decoding with what is missing and why — retryable once it is installed', { timeout: 60000 }, async (t) => {
  if (skip !== false) return t.skip(skip);
  const missing = { ...config, tools: { ...config.tools, ffmpeg: { name: 'ffmpeg' as const, found: false as const, reason: 'not on PATH', neededFor: 'decoding any media file to audio' } } };
  const job = await runJob(missing, createJob(missing, { kind: 'file', path: mp4 }, null));
  assert.deepEqual([job.stage, job.failure?.code, job.failure?.retryable], ['failed', 'tool.missing', true]);
});
