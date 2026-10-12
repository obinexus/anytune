/**
 * The import pipeline: a job's stages, run and persisted one by one (library/jobs/<id>/job.json is rewritten after every transition, so a crash leaves a job
 * that says where it was). What it keeps, as distinct files in the job's directory:
 *
 *   source.<ext>            the media or MIDI as it came — copied, never changed (its SHA-256 is checked after the copy)
 *   source.info.json        for a URL: what the provider said of it (title, uploader, licence, duration), as yt-dlp wrote it
 *   transcription.mid       the engine's notes, as a Standard MIDI File (a transcription only)
 *   transcription.json      what the engine gave, what AnyTune dropped as octave ghosts, and what MIDI made it round
 *   reference.json          the teaching reference (anytune-reference/1): unreviewed until the learner accepts it
 *
 * and, through Polycall, the timed reference recording (anytune-recording/1) of the accepted reference. Nothing is uploaded anywhere.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { advance, fail, newJob, type Job, type JobSource } from '../../../src/import/job.ts';
import { dropOctaveGhosts } from '../../../src/import/transcription.ts';
import { DEFAULT_LIMITS, decideUrl, isPrivateAddress, ytDlpArguments, type DownloadLimits } from '../../../src/import/url-policy.ts';
import { referenceFromMidi, transcriptionToMidi, type InstrumentProfileId, type Reference, type SourceAsset } from '../../../src/music/reference.ts';
import { ENGINE_SAMPLE_RATE, engineInfo, transcribe } from './basic-pitch.ts';
import { decode, probe } from './media.ts';
import { startPolycallHost, type PolycallHost } from './polycall-host.ts';
import { runTool } from './process.ts';
import type { Tool, ToolName } from './tools.ts';

export interface WorkerConfig {
  readonly library: string;
  readonly tools: Readonly<Record<ToolName, Tool>>;
  readonly limits: DownloadLimits;
  readonly instrument: InstrumentProfileId;
  readonly log: (line: string) => void;
}

const now = (): string => new Date().toISOString();
const MEDIA_TYPES: Readonly<Record<string, string>> = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.mid': 'audio/midi', '.midi': 'audio/midi' };
const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const jobDirectory = (config: WorkerConfig, id: string): string => path.join(config.library, 'jobs', id);

export function saveJob(config: WorkerConfig, job: Job): void {
  const dir = jobDirectory(config, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(job, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file); // never a half-written job
}

export function loadJob(config: WorkerConfig, id: string): Job {
  return JSON.parse(fs.readFileSync(path.join(jobDirectory(config, id), 'job.json'), 'utf8')) as Job;
}

export function createJob(config: WorkerConfig, source: JobSource, permission: string | null): Job {
  const id = `job-${crypto.randomBytes(8).toString('hex')}`;
  const job = newJob(id, source, permission, now());
  saveJob(config, job);
  return job;
}

function assetOf(file: string, role: SourceAsset['role']): SourceAsset {
  return { role, fileName: path.basename(file), mediaType: MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', sha256: sha256(file), bytes: fs.statSync(file).size };
}

type StageOutcome = { readonly ok: true; readonly outputs?: Record<string, string>; readonly diagnostics?: readonly string[] } | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean };

/** Run a job's stages until it waits for review, is ready, fails or is cancelled. */
export async function runJob(config: WorkerConfig, start: Job, signal?: AbortSignal): Promise<Job> {
  let job = start;
  let audio: Float32Array | null = null;
  const dir = jobDirectory(config, job.id);
  for (;;) {
    if (signal?.aborted) {
      const t = { ok: true as const, job: { ...job, stage: 'cancelled' as const, history: [...job.history, { stage: 'cancelled' as const, at: now() }] } };
      saveJob(config, t.job);
      return t.job;
    }
    if (job.stage === 'reviewing' || job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelled') return job;
    config.log(`${job.id}: ${job.stage}`);
    let outcome: StageOutcome;
    switch (job.stage) {
      case 'queued':
        outcome = await queue(job, dir);
        break;
      case 'downloading':
        outcome = await download(config, job, dir, signal);
        break;
      case 'decoding': {
        const decoded = await decodeStage(config, job, dir, signal);
        if (decoded.ok) audio = decoded.audio;
        outcome = decoded.ok ? { ok: true, diagnostics: decoded.diagnostics } : decoded;
        break;
      }
      case 'transcribing': {
        if (audio === null) {
          const again = await decodeStage(config, job, dir, signal); // a retry: decode again, rather than keep raw audio on disk
          if (!again.ok) {
            outcome = again;
            break;
          }
          audio = again.audio;
        }
        outcome = await transcribeStage(config, job, dir, audio);
        break;
      }
      case 'recording':
        outcome = await recordStage(config, job, dir);
        break;
      default:
        outcome = { ok: false, code: 'job.stage', message: `no work for stage ${job.stage}`, retryable: false };
    }
    const t = outcome.ok ? advance(job, now(), outcome.outputs ?? {}, outcome.diagnostics ?? []) : outcome.code === 'cancelled' ? { ok: true as const, job: { ...job, stage: 'cancelled' as const, history: [...job.history, { stage: 'cancelled' as const, at: now() }] } } : fail(job, now(), outcome.code, outcome.message, outcome.retryable);
    if (!t.ok) throw new Error(t.reason);
    job = t.job;
    saveJob(config, job);
    if (job.stage === 'failed') config.log(`${job.id}: failed at ${job.failure?.stage} — ${job.failure?.code}: ${job.failure?.message}${job.failure?.retryable ? ' (retrying may help)' : ''}`);
  }
}

async function queue(job: Job, dir: string): Promise<StageOutcome> {
  if (job.source.kind === 'url') return { ok: true };
  const from = job.source.path;
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return { ok: false, code: 'source.missing', message: `${from} is not a file`, retryable: false };
  const target = path.join(dir, `source${path.extname(from).toLowerCase()}`);
  fs.copyFileSync(from, target);
  const original = sha256(from);
  if (sha256(target) !== original) return { ok: false, code: 'source.copy', message: 'the copy of the source differs from the original', retryable: true };
  return { ok: true, outputs: { source: path.basename(target), originalPath: from, originalSha256: original } };
}

async function download(config: WorkerConfig, job: Job, dir: string, signal?: AbortSignal): Promise<StageOutcome> {
  if (job.source.kind !== 'url') return { ok: true };
  const tool = config.tools['yt-dlp'];
  if (!tool.found) return { ok: false, code: 'tool.missing', message: `yt-dlp is needed for ${tool.neededFor}: ${tool.reason}`, retryable: true };
  const decision = decideUrl(job.source.url, job.source.mode);
  if (!decision.ok) return { ok: false, code: 'url.refused', message: decision.reason, retryable: false };
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(decision.host, { all: true, verbatim: true });
  } catch (error) {
    return { ok: false, code: 'url.dns', message: `${decision.host} could not be resolved: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }
  const private_ = addresses.filter((a) => isPrivateAddress(a.address));
  if (private_.length > 0) return { ok: false, code: 'url.private-network', message: `${decision.host} resolves to a private address (${private_.map((a) => a.address).join(', ')}): not fetched`, retryable: false };
  if (decision.kind !== 'video') return { ok: false, code: 'url.playlist', message: 'a playlist is imported as one job per video: list it first (cli playlist)', retryable: false };
  const r = await runTool(tool.path, ytDlpArguments(decision, dir, config.limits), { timeoutMs: 15 * 60 * 1000, cwd: dir, ...(signal === undefined ? {} : { signal }) });
  if (r.status === 'cancelled') return { ok: false, code: 'cancelled', message: 'cancelled', retryable: true };
  if (r.status !== 'ok') return { ok: false, code: r.status === 'timeout' ? 'download.timeout' : 'download.failed', message: r.message, retryable: true };
  const printed = r.stdout.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
  const file = path.resolve(printed);
  if (printed === '' || path.dirname(file) !== path.resolve(dir) || !fs.existsSync(file)) return { ok: false, code: 'download.nothing', message: 'yt-dlp downloaded nothing (the video may be longer than the limit, live, or unavailable)', retryable: false };
  const info = path.join(dir, 'source.info.json');
  const meta = fs.existsSync(info) ? (JSON.parse(fs.readFileSync(info, 'utf8')) as Record<string, unknown>) : {};
  return { ok: true, outputs: { source: path.basename(file), ...(fs.existsSync(info) ? { info: 'source.info.json' } : {}), title: String(meta['title'] ?? ''), providerLicense: String(meta['license'] ?? 'not stated') }, diagnostics: decision.ignored.map((i) => `left out of the URL: ${i}`) };
}

async function decodeStage(config: WorkerConfig, job: Job, dir: string, signal?: AbortSignal): Promise<({ ok: true; audio: Float32Array; diagnostics: string[] }) | Extract<StageOutcome, { ok: false }>> {
  const ffprobe = config.tools.ffprobe;
  const ffmpeg = config.tools.ffmpeg;
  if (!ffprobe.found || !ffmpeg.found) return { ok: false, code: 'tool.missing', message: `FFmpeg and ffprobe are needed to decode media: ${!ffmpeg.found ? ffmpeg.reason : ''} ${!ffprobe.found ? ffprobe.reason : ''}`.trim(), retryable: true };
  const file = path.join(dir, job.outputs['source'] ?? '');
  const info = await probe(ffprobe.path, file, signal);
  if (!info.ok) return info;
  if (info.value.durationSeconds > config.limits.maxDurationSeconds) return { ok: false, code: 'media.too-long', message: `the media lasts ${Math.round(info.value.durationSeconds)} s; at most ${config.limits.maxDurationSeconds} s is imported`, retryable: false };
  const audio = await decode(ffmpeg.path, file, ENGINE_SAMPLE_RATE, config.limits.maxDurationSeconds, signal);
  if (!audio.ok) return audio;
  return { ok: true, audio: audio.value, diagnostics: [`decoded ${(audio.value.length / ENGINE_SAMPLE_RATE).toFixed(1)} s of ${info.value.audioCodec ?? 'audio'} (${info.value.formatName}) to mono ${ENGINE_SAMPLE_RATE} Hz`] };
}

async function transcribeStage(config: WorkerConfig, job: Job, dir: string, audio: Float32Array): Promise<StageOutcome> {
  let raw;
  try {
    raw = await transcribe(audio);
  } catch (error) {
    return { ok: false, code: 'engine.failed', message: `the transcription engine stopped: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
  }
  const { kept, dropped } = dropOctaveGhosts(raw);
  if (kept.length === 0) return { ok: false, code: 'transcription.empty', message: 'the engine heard no notes in this audio', retryable: false };
  const title = job.outputs['title'] || path.basename(job.source.kind === 'url' ? 'download' : job.source.path).replace(/\.[^.]+$/, '');
  const midi = transcriptionToMidi(kept.map((n) => ({ key: n.key, onsetSeconds: n.onsetSeconds, releaseSeconds: n.onsetSeconds + n.durationSeconds, velocity: Math.round(20 + 100 * Math.min(1, n.strength)), confidence: Math.min(1, n.strength) })), { title: `${title} (transcribed)` });
  const midiFile = path.join(dir, 'transcription.mid');
  fs.writeFileSync(midiFile, midi.bytes);
  const engine = engineInfo();
  const made = referenceFromMidi(midi.bytes, {
    song: { id: slug(title), title, composer: null },
    arrangement: { id: `${slug(title)}-transcribed`, version: 1, instrument: config.instrument, part: 'full' },
    provenance: { kind: 'transcription', source: assetOf(path.join(dir, job.outputs['source'] ?? ''), 'source-media'), engine, midi: assetOf(midiFile, 'midi') },
    confidences: midi.confidences,
  });
  if (!made.ok) return { ok: false, code: 'reference.invalid', message: made.reason, retryable: false };
  writeJson(path.join(dir, 'reference.json'), made.reference);
  writeJson(path.join(dir, 'transcription.json'), {
    engine,
    engineNotes: raw.length,
    droppedAsOctaveGhosts: dropped.map((d) => ({ key: d.note.key, onsetSeconds: d.note.onsetSeconds, strength: d.note.strength, harmonicOf: d.harmonicOf.key })),
    midiAdjustments: midi.adjustments,
    maxRoundingSeconds: midi.maxRoundingSeconds,
    uncertainNotes: made.reference.notes.filter((n) => (n.confidence ?? 1) < 0.5).length,
  });
  return { ok: true, outputs: { midi: 'transcription.mid', reference: 'reference.json', transcriptionReport: 'transcription.json' }, diagnostics: [`${kept.length} notes estimated (${dropped.length} octave ghosts dropped); ${made.reference.notes.filter((n) => (n.confidence ?? 1) < 0.5).length} below 0.5 confidence, flagged for review`] };
}

/** A MIDI import: its notes are stated, so it is a reference at once (reviewed), with no transcription. */
export function midiReference(config: WorkerConfig, job: Job, title: string): StageOutcome {
  const dir = jobDirectory(config, job.id);
  const file = path.join(dir, job.outputs['source'] ?? '');
  const made = referenceFromMidi(new Uint8Array(fs.readFileSync(file)), {
    song: { id: slug(title), title, composer: null },
    arrangement: { id: `${slug(title)}-midi`, version: 1, instrument: config.instrument, part: 'full' },
    provenance: { kind: 'midi-import', midi: assetOf(file, 'midi') },
  });
  if (!made.ok) return { ok: false, code: 'midi.invalid', message: made.reason, retryable: false };
  writeJson(path.join(dir, 'reference.json'), made.reference);
  return { ok: true, outputs: { reference: 'reference.json' } };
}

async function recordStage(config: WorkerConfig, job: Job, dir: string): Promise<StageOutcome> {
  if (job.source.kind === 'midi' && job.outputs['reference'] === undefined) {
    const made = midiReference(config, job, path.basename(job.source.path).replace(/\.[^.]+$/, ''));
    if (!made.ok) return made;
    job = { ...job, outputs: { ...job.outputs, ...(made.outputs ?? {}) } };
  }
  const reference = JSON.parse(fs.readFileSync(path.join(dir, job.outputs['reference'] ?? 'reference.json'), 'utf8')) as Reference;
  if (reference.review.state !== 'reviewed') return { ok: false, code: 'reference.unreviewed', message: 'the transcription has not been accepted: review it first', retryable: true };
  let host: PolycallHost;
  try {
    host = await startPolycallHost(path.join(config.library, 'recordings'));
  } catch (error) {
    return { ok: false, code: 'polycall.unavailable', message: error instanceof Error ? error.message : String(error), retryable: true };
  }
  try {
    const created = await host.recorder.create('reference', { referenceId: reference.id, songId: reference.song.id, title: reference.song.title, arrangementId: reference.arrangement.id, arrangementVersion: reference.arrangement.version, provenance: reference.provenance.kind, clock: { domain: 'reference', unit: 's' } });
    if (!created.ok) return { ok: false, code: created.error.code, message: created.error.message, retryable: true };
    const events = reference.notes.map((n) => ({ t: n.onsetSeconds, kind: 'note', id: n.id, key: n.key, durationSeconds: n.releaseSeconds - n.onsetSeconds, velocity: n.velocity, confidence: n.confidence, estimated: n.estimated }));
    for (let i = 0; i < events.length; i += 1000) {
      const appended = await host.recorder.append(created.value.recordingId, events.slice(i, i + 1000));
      if (!appended.ok) return { ok: false, code: appended.error.code, message: appended.error.message, retryable: true };
    }
    const finished = await host.recorder.finish(created.value.recordingId);
    if (!finished.ok) return { ok: false, code: finished.error.code, message: finished.error.message, retryable: true };
    return { ok: true, outputs: { ...job.outputs, recording: created.value.recordingId }, diagnostics: [`timed reference recording ${created.value.recordingId}: ${finished.value.events} notes, through Polycall`] };
  } finally {
    await host.stop();
  }
}

/** The learner accepts a transcription as a teaching reference: it is marked reviewed (with the corrections made, none here), and the job goes on. */
export async function acceptReview(config: WorkerConfig, job: Job): Promise<Job> {
  if (job.stage !== 'reviewing') throw new Error(`job ${job.id} is ${job.stage}, not waiting for review`);
  const file = path.join(jobDirectory(config, job.id), job.outputs['reference'] ?? 'reference.json');
  const reference = JSON.parse(fs.readFileSync(file, 'utf8')) as Reference;
  writeJson(file, { ...reference, review: { state: 'reviewed', corrections: reference.review.corrections } });
  const t = advance(job, now(), {}, ['the learner accepted the transcription as a teaching reference']);
  if (!t.ok) throw new Error(t.reason);
  saveJob(config, t.job);
  return runJob(config, t.job);
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'untitled';

export { DEFAULT_LIMITS };
