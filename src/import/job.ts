/**
 * An import job and its stages, as the learner sees them:
 *
 *   queued → downloading (a URL only) → decoding → transcribing → reviewing → recording → ready
 *                                                                       ↘ failed, cancelled (from any stage before ready)
 *
 * A MIDI file skips decoding, transcribing and reviewing: its notes are stated, not estimated. "reviewing" waits for the learner: a transcription is an
 * estimate, and it becomes a teaching reference only once it is accepted. "recording" writes the timed reference recording (anytune-recording/1) through
 * Polycall's recorder. A failed job says which stage failed, why, and whether retrying can help; a retry starts again at that stage, keeping what the stages
 * before it made. Pure: the worker (services/import-worker) runs the stages and persists the job.
 */

export const STAGES = ['queued', 'downloading', 'decoding', 'transcribing', 'reviewing', 'recording', 'ready', 'failed', 'cancelled'] as const;
export type Stage = (typeof STAGES)[number];

export type JobSource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'midi'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string; readonly mode: 'single' | 'playlist' };

export interface JobFailure {
  readonly stage: Stage;
  readonly code: string;
  readonly message: string;
  /** whether retrying the same job might succeed (a network timeout) or cannot (an unsupported file) */
  readonly retryable: boolean;
}

export interface Job {
  readonly format: 'anytune-import-job/1';
  readonly id: string;
  readonly source: JobSource;
  /** the learner's declaration that they may use this media, as given; required for a URL */
  readonly permission: string | null;
  readonly stage: Stage;
  /** the stages passed through, in order, with their wall-clock times (metadata only) */
  readonly history: readonly { readonly stage: Stage; readonly at: string }[];
  readonly failure: JobFailure | null;
  /** what the job made, by role: file names inside the job's directory */
  readonly outputs: Readonly<Record<string, string>>;
  /** what was tolerated or adjusted on the way, in words */
  readonly diagnostics: readonly string[];
}

/** The stages a job of this source goes through, in order, before ready. */
export function plannedStages(source: JobSource): Stage[] {
  if (source.kind === 'midi') return ['queued', 'recording', 'ready'];
  if (source.kind === 'file') return ['queued', 'decoding', 'transcribing', 'reviewing', 'recording', 'ready'];
  return ['queued', 'downloading', 'decoding', 'transcribing', 'reviewing', 'recording', 'ready'];
}

export function newJob(id: string, source: JobSource, permission: string | null, at: string): Job {
  if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new RangeError('a job id is 8-64 of a-z, 0-9 and -');
  if (source.kind === 'url' && (permission === null || permission.trim() === '')) throw new RangeError('a URL is imported only with the learner’s declaration that they may use it');
  return { format: 'anytune-import-job/1', id, source, permission, stage: 'queued', history: [{ stage: 'queued', at }], failure: null, outputs: {}, diagnostics: [] };
}

export type Transition = { readonly ok: true; readonly job: Job } | { readonly ok: false; readonly reason: string };

/** The next stage of the plan — and only that: a job never skips a stage, nor goes back except by retrying. */
export function advance(job: Job, at: string, outputs: Readonly<Record<string, string>> = {}, diagnostics: readonly string[] = []): Transition {
  if (job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelled') return { ok: false, reason: `a ${job.stage} job does not advance` };
  const plan = plannedStages(job.source);
  const next = plan[plan.indexOf(job.stage) + 1];
  if (next === undefined) return { ok: false, reason: `no stage after ${job.stage}` };
  return { ok: true, job: { ...job, stage: next, history: [...job.history, { stage: next, at }], outputs: { ...job.outputs, ...outputs }, diagnostics: [...job.diagnostics, ...diagnostics] } };
}

export function fail(job: Job, at: string, code: string, message: string, retryable: boolean): Transition {
  if (job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelled') return { ok: false, reason: `a ${job.stage} job cannot fail` };
  return { ok: true, job: { ...job, stage: 'failed', failure: { stage: job.stage, code, message, retryable }, history: [...job.history, { stage: 'failed', at }] } };
}

export function cancel(job: Job, at: string): Transition {
  if (job.stage === 'ready' || job.stage === 'failed' || job.stage === 'cancelled') return { ok: false, reason: `a ${job.stage} job cannot be cancelled` };
  return { ok: true, job: { ...job, stage: 'cancelled', history: [...job.history, { stage: 'cancelled', at }] } };
}

/** Retry a failed job from the stage that failed, keeping the outputs of the stages before it. A failure that retrying cannot mend is refused. */
export function retry(job: Job, at: string): Transition {
  if (job.stage !== 'failed' || job.failure === null) return { ok: false, reason: 'only a failed job is retried' };
  if (!job.failure.retryable) return { ok: false, reason: `retrying cannot help: ${job.failure.message}` };
  return { ok: true, job: { ...job, stage: job.failure.stage, failure: null, history: [...job.history, { stage: job.failure.stage, at }] } };
}
