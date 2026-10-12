/**
 * The practice session — "Listen → Practise → Review → Repeat" as an application service, framework-neutral: the learner practises an ARRANGEMENT of a
 * reference (a melody, an octave lower on guitar when that is what fits — said), at a tempo, perhaps in an A–B loop, in flow (the music keeps time) or step
 * mode (the music waits). What was heard comes in as timed events from the live analysis (src/analysis/live.ts); the session maps them onto the reference's
 * timeline (the LessonClock), judges them (src/lesson/), keeps the attempt — through the recorder, when there is one — and never changes the reference.
 *
 * Every time here is on ONE clock: the audio clock that stamps the captured samples and schedules the reference's playback and the click (the harness gives
 * it). Wall-clock time is metadata only.
 */
import type { LiveEvent } from '../analysis/live.ts';
import { noteName } from './guitar-view.ts';
import { DEFAULT_POLICY, assessNotes, unassessedWhereUnheard, type HeardNote, type NoteResult } from '../lesson/assessment.ts';
import { feedbackOf, type Feedback } from '../lesson/feedback.ts';
import { LessonClock, StepPractice, barOfTick, targetsIn } from '../lesson/practice.ts';
import type { GuitarTuning } from '../music/guitar.ts';
import { melodyArrangement, type Target } from './arrangement.ts';
import { tempoMapOf, type Reference } from '../music/reference.ts';

/** The recorder, as practice needs it — src/recording/recorder.ts's PolycallRecorder is one. Failures are results. */
export interface AttemptStore {
  create(kind: 'attempt', meta: Readonly<Record<string, unknown>>): Promise<{ readonly ok: true; readonly value: { readonly recordingId: string } } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }>;
  append(recordingId: string, events: readonly { readonly t: number; readonly kind: string; readonly [k: string]: unknown }[]): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }>;
  finish(recordingId: string): Promise<{ readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }>;
}

/** Sound, on the session's clock: the reference's notes and the click. */
export interface Playback {
  note(key: number, at: number, durationSeconds: number, velocity: number): void;
  click(at: number, accent: boolean): void;
  cancelAll(): void;
}

export interface PracticeSettings {
  /** 0.25 … 1.25 of the written tempo */
  readonly tempoFactor: number;
  /** bars, inclusive, or null for the whole piece once */
  readonly loop: { readonly fromBar: number; readonly toBar: number } | null;
  readonly mode: 'flow' | 'step';
  readonly countInBeats: number;
  /** play the reference while practising (headphones advised: the microphone hears the speaker) */
  readonly playReference: boolean;
  readonly metronome: boolean;
  /** measured round trip, or 0 until calibrated */
  readonly inputLatencySeconds: number;
}

export const DEFAULT_SETTINGS: PracticeSettings = Object.freeze({ tempoFactor: 1, loop: null, mode: 'flow', countInBeats: 3, playReference: true, metronome: true, inputLatencySeconds: 0 });

export type { Target };

export type AttemptStatus = { readonly kind: 'unavailable'; readonly why: string } | { readonly kind: 'idle' } | { readonly kind: 'recording'; readonly recordingId: string } | { readonly kind: 'saved'; readonly recordingId: string; readonly events: number } | { readonly kind: 'failed'; readonly message: string };

export interface PracticeState {
  readonly phase: 'ready' | 'count-in' | 'playing' | 'reviewing';
  readonly title: string;
  readonly arrangementText: string;
  readonly octaveShift: number;
  /** the tuning the positions are for, capo included */
  readonly tuning: GuitarTuning;
  readonly settings: PracticeSettings;
  readonly bars: number;
  readonly targets: readonly Target[];
  /** the targets of the loop being practised */
  readonly loopTargets: readonly Target[];
  /** flow: the target due now (or next); step: the one being asked for */
  readonly current: Target | null;
  readonly next: Target | null;
  readonly pass: number;
  readonly secondsToStart: number | null;
  /** the last notes heard, newest last (at most 6) */
  readonly heard: readonly HeardNote[];
  /** step mode: what the last wrong try was */
  readonly stepMessage: string | null;
  /** the results of each finished pass, in order */
  readonly passes: readonly { readonly pass: number; readonly results: readonly NoteResult[]; readonly extra: number }[];
  /** the pass the feedback is about: the last one judged — unless a stop cut the last one short (less than half of it due), when the one before stays */
  readonly reviewPass: number | null;
  readonly feedback: Feedback | null;
  readonly attempt: AttemptStatus;
  /** whether this run listens and judges — false: played along without assessment, no verdict of any kind */
  readonly assessing: boolean;
  /** a brief word on the last note heard, while playing: "On time", "A little late", "Try E3" — the detail waits for the review */
  readonly liveText: string;
  /** counts the starts: one review per run */
  readonly run: number;
}

/** What a run listens to: the capture's coverage, so that a target it could not hear is unassessed rather than missed (src/app/capture.ts). */
export interface CaptureCoverage {
  healthyBetween(from: number, to: number): boolean;
}

export interface StartOptions {
  /** listen and judge (the default), or play along without assessment */
  readonly assess?: boolean;
  /** the capture's coverage; null when not known (every target is then assessable) */
  readonly capture?: CaptureCoverage | null;
}

/** An onset whose pitch could not be named — heard, but unclear: never a confident verdict. */
const unclearNote = (time: number): HeardNote => ({ time, key: -1, cents: 0, confidence: 0 });

const BUFFER = 64;

/** The capture must cover a target's window — from a little before it is due to the assessment window after — for the target to be assessed. */
const COVER_BEFORE_SECONDS = 0.1;
const COVER_AFTER_SECONDS = 0.25;

/** How long after its onset the live analysis reports a note: once its pitch has settled — 140–160 ms on the synthetic strings, in frames of 1024 samples at
 * 48 kHz (tests/components/shell.test.ts plays bar 1 through it). A pass is judged no sooner than this after its last note can have been captured, so that a
 * note played in time at the end of a pass is not judged missed for being reported late. */
const ANALYSIS_DELAY_SECONDS = 0.25;

export class PracticeSession {
  readonly #reference: Reference;
  readonly #track: number;
  readonly #pickupTicks: number;
  readonly #playback: Playback | null;
  readonly #store: AttemptStore | null;
  readonly #listeners = new Set<(s: PracticeState) => void>();
  #state: PracticeState;
  #clock: LessonClock | null = null;
  #step: StepPractice | null = null;
  #heardByPass = new Map<number, HeardNote[]>();
  #pending: { t: number; kind: string; [k: string]: unknown }[] = [];
  #scheduledPasses = new Set<number>();
  #startedAt = 0;
  /** the first pass not yet judged */
  #nextToJudge = 0;
  /** the recorder's calls, one after another: a recording keeps time order, so two appends may never race */
  #chain: Promise<void> = Promise.resolve();
  /** the latest event time queued: every event's t is at least this, so the attempt's events never go back in time */
  #lastT = 0;

  constructor(reference: Reference, track: number, options: { readonly pickupTicks?: number; readonly playback?: Playback | null; readonly store?: AttemptStore | null; readonly storeUnavailableWhy?: string; readonly tuning?: GuitarTuning } = {}) {
    this.#reference = reference;
    this.#track = track;
    this.#pickupTicks = options.pickupTicks ?? 0;
    this.#playback = options.playback ?? null;
    this.#store = options.store ?? null;
    const arrangement = melodyArrangement(reference, track, this.#pickupTicks, options.tuning);
    const targets = [...arrangement.targets];
    const bars = targets.reduce((m, t) => Math.max(m, t.bar), 0);
    this.#state = {
      phase: 'ready',
      title: reference.song.title,
      arrangementText: arrangement.text,
      tuning: arrangement.tuning,
      octaveShift: arrangement.octaveShift,
      settings: DEFAULT_SETTINGS,
      bars,
      targets,
      loopTargets: targets,
      current: targets[0] ?? null,
      next: targets[1] ?? null,
      pass: 0,
      secondsToStart: null,
      heard: [],
      stepMessage: null,
      passes: [],
      reviewPass: null,
      feedback: null,
      attempt: this.#store === null ? { kind: 'unavailable', why: options.storeUnavailableWhy ?? 'no recorder is connected: this attempt is not saved' } : { kind: 'idle' },
      assessing: true,
      liveText: '',
      run: 0,
    };
    this.#storeUnavailableWhy = options.storeUnavailableWhy ?? 'no recorder is connected: this attempt is not saved';
  }

  readonly #storeUnavailableWhy: string;
  /** the capture's coverage for this run; null: not known */
  #capture: CaptureCoverage | null = null;

  getState(): PracticeState {
    return this.#state;
  }

  subscribe(listener: (s: PracticeState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<PracticeState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }

  /** The loop's span on the reference's timeline: from its first bar's first target to the next bar's first target (or the end). */
  #span(settings: PracticeSettings): { from: number; to: number | null; targets: Target[] } {
    const all = this.#state.targets;
    if (settings.loop === null) return { from: Math.min(0, all[0]?.time ?? 0), to: null, targets: [...all] };
    const startOf = (bar: number): number | null => all.find((t) => t.bar >= bar)?.time ?? null;
    const from = startOf(settings.loop.fromBar) ?? 0;
    const to = startOf(settings.loop.toBar + 1) ?? this.#reference.timing.endSeconds;
    return { from, to, targets: targetsIn(all, from, to) };
  }

  configure(settings: Partial<PracticeSettings>): void {
    if (this.#state.phase === 'count-in' || this.#state.phase === 'playing') return;
    const next = { ...this.#state.settings, ...settings };
    const tempoFactor = Math.min(1.25, Math.max(0.25, next.tempoFactor));
    let loop = next.loop;
    if (loop !== null) {
      const fromBar = Math.max(0, Math.min(this.#state.bars, Math.round(loop.fromBar)));
      loop = { fromBar, toBar: Math.max(fromBar, Math.min(this.#state.bars, Math.round(loop.toBar))) };
    }
    const settled = { ...next, tempoFactor, loop };
    const span = this.#span(settled);
    this.#set({ settings: settled, loopTargets: span.targets, current: span.targets[0] ?? null, next: span.targets[1] ?? null });
  }

  /** The beat (the time signature's note value) at the loop's start, in reference seconds. */
  #beatSeconds(from: number): number {
    const map = tempoMapOf(this.#reference);
    const tick = map.tickAt(Math.max(0, from));
    const sig = [...this.#reference.timing.timeSignatures].reverse().find((s) => s.tick <= tick);
    const denominator = sig?.denominator ?? 4;
    return (map.microsecondsPerQuarterAt(tick) / 1e6) * (4 / denominator);
  }

  /**
   * Start: a count-in on the click, then the loop, on the clock that stamps the captured audio. Assessed (the default), what is heard is judged — and a
   * target the capture did not cover is unassessed, never missed; or played along WITHOUT assessment: nothing is listened to, and no verdict is given.
   */
  async start(now: number, options: StartOptions = {}): Promise<void> {
    if (this.#state.phase === 'count-in' || this.#state.phase === 'playing') return;
    const assessing = options.assess ?? true;
    this.#capture = options.capture ?? null;
    const s = this.#state.settings;
    const span = this.#span(s);
    const beat = this.#beatSeconds(span.from) / s.tempoFactor;
    const countIn = s.mode === 'step' ? 0 : s.countInBeats * beat;
    this.#startedAt = now;
    this.#nextToJudge = 0;
    this.#clock = new LessonClock({ startedAt: now, countInSeconds: countIn, tempoFactor: s.tempoFactor, from: span.from, to: s.loop === null ? null : span.to, inputLatencySeconds: s.inputLatencySeconds, earlyAllowanceSeconds: 0.15 });
    this.#step = s.mode === 'step' ? new StepPractice(span.targets) : null;
    this.#heardByPass = new Map();
    this.#scheduledPasses = new Set();
    this.#pending = [];
    this.#lastT = 0;
    this.#saved = 0;
    this.#playback?.cancelAll();
    if (s.mode === 'flow' && s.metronome) for (let b = 0; b < s.countInBeats; b++) this.#playback?.click(now + b * beat, b === 0);
    this.#set({
      phase: s.mode === 'step' ? 'playing' : 'count-in',
      pass: 0,
      heard: [],
      passes: [],
      reviewPass: null,
      feedback: null,
      stepMessage: null,
      secondsToStart: countIn,
      current: span.targets[0] ?? null,
      next: span.targets[1] ?? null,
      assessing,
      liveText: '',
      run: this.#state.run + 1,
      attempt: !assessing ? { kind: 'unavailable', why: 'played along without assessment: the microphone was not used' } : this.#store === null ? { kind: 'unavailable', why: this.#storeUnavailableWhy } : { kind: 'idle' },
    });
    if (s.mode === 'flow') this.#schedulePass(0);
    if (this.#store !== null && assessing) {
      const meta = {
        referenceId: this.#reference.id,
        songId: this.#reference.song.id,
        arrangement: { track: this.#track, octaveShift: this.#state.octaveShift, part: 'melody', instrument: 'acoustic-guitar' },
        settings: s,
        clock: { domain: 'audio-context', unit: 's', origin: now },
        sources: [{ id: 'microphone', kind: 'microphone', units: 'MIDI key and cents; confidence 0-1', uncertainty: 'YIN aperiodicity' }],
        scoring: DEFAULT_POLICY,
      };
      const created = await this.#store.create('attempt', meta);
      this.#set({ attempt: created.ok ? { kind: 'recording', recordingId: created.value.recordingId } : { kind: 'failed', message: created.error.message } });
    }
  }

  /** The reference's notes and the clicks of one pass, scheduled on the clock (flow mode). */
  #schedulePass(pass: number): void {
    if (this.#clock === null || this.#scheduledPasses.has(pass)) return;
    this.#scheduledPasses.add(pass);
    const s = this.#state.settings;
    const span = this.#span(s);
    if (s.playReference) {
      for (const t of span.targets) {
        const note = this.#reference.notes.find((n) => n.id === t.id);
        const duration = note === undefined ? 0.3 : (note.releaseSeconds - note.onsetSeconds) / s.tempoFactor;
        this.#playback?.note(t.key, this.#clock.due(pass, t.time), duration, note?.velocity ?? 80);
      }
    }
    if (s.metronome) {
      const beat = this.#beatSeconds(span.from);
      const end = span.to ?? this.#reference.timing.endSeconds;
      for (let t = span.from, b = 0; t < end - 1e-9; t += beat, b++) this.#playback?.click(this.#clock.due(pass, t), b === 0);
    }
  }

  /**
   * What the live analysis heard. Notes are judged here (the melody arrangement), and so are onsets whose pitch could not be named — as UNCLEAR, never as
   * a wrong note or a silence; every one is kept in the attempt. While playing, a brief word on each: the detail waits for the review.
   */
  hear(events: readonly LiveEvent[]): void {
    if (this.#clock === null || !this.#state.assessing || (this.#state.phase !== 'playing' && this.#state.phase !== 'count-in')) return;
    let heard = this.#state.heard;
    let stepMessage = this.#state.stepMessage;
    let current = this.#state.current;
    let next = this.#state.next;
    let liveText = this.#state.liveText;
    for (const e of events) {
      if (e.kind !== 'note' && e.kind !== 'unclear') continue;
      const reading = this.#clock.read(e.time);
      const at = reading.phase === 'playing' ? reading.time : Number.NaN;
      const note: HeardNote = e.kind === 'note' ? { time: at, key: e.key, cents: e.cents, confidence: e.confidence } : unclearNote(at);
      if (e.kind === 'note') heard = [...heard, note].slice(-6);
      this.#queue(e.kind === 'note'
        ? { t: e.time - this.#startedAt, kind: 'heard-note', key: e.key, cents: e.cents, confidence: e.confidence, pass: reading.phase === 'playing' ? reading.pass : null, referenceTime: reading.phase === 'playing' ? reading.time : null }
        : { t: e.time - this.#startedAt, kind: 'heard-unclear', strength: e.strength, pass: reading.phase === 'playing' ? reading.pass : null, referenceTime: reading.phase === 'playing' ? reading.time : null });
      if (this.#step !== null) {
        const outcome = this.#step.hear(note);
        if (outcome.kind === 'advanced') {
          stepMessage = null;
          current = this.#state.loopTargets.find((t) => t.id === outcome.next?.id) ?? null;
          next = current === null ? null : (this.#state.loopTargets[this.#state.loopTargets.indexOf(current) + 1] ?? null);
        } else stepMessage = outcome.heard === 'uncertain' ? 'I could not hear that clearly — play it again.' : outcome.heard === 'octave' ? 'The right note, in another octave.' : 'Not that one — try again.';
      } else if (reading.phase === 'playing') {
        this.#heardByPass.set(reading.pass, [...(this.#heardByPass.get(reading.pass) ?? []), note]);
        liveText = this.#liveWord(note) ?? liveText;
      }
    }
    this.#set({ heard, stepMessage, current, next, liveText });
    if (this.#step?.done === true) void this.stop(Number.NaN);
    void this.#flush(false);
  }

  /** A brief word on one heard note, against the nearest target of the loop (reference time): null when no target is near enough to say. */
  #liveWord(note: HeardNote): string | null {
    if (!Number.isFinite(note.time)) return null;
    const window = DEFAULT_POLICY.windowSeconds;
    let nearest: Target | null = null;
    for (const t of this.#state.loopTargets) if (Math.abs(t.time - note.time) <= window && (nearest === null || Math.abs(t.time - note.time) < Math.abs(nearest.time - note.time))) nearest = t;
    if (nearest === null) return null;
    if (!(note.confidence >= DEFAULT_POLICY.minConfidence)) return 'I could not hear that one clearly';
    const label = noteName(nearest.key);
    if (note.key !== nearest.key) return (note.key - nearest.key) % 12 === 0 ? `Right note, other octave — try ${label}` : `Try ${label}`;
    const dt = note.time - nearest.time;
    return Math.abs(dt) <= DEFAULT_POLICY.onTimeSeconds ? 'On time' : dt < 0 ? 'A little early' : 'A little late';
  }

  /** Time passes: the count-in ends, the target due now moves on, a loop pass ends and is judged, the next is scheduled. For display and passes only:
   * nothing is judged from this time — judgement uses the times the audio was captured at. */
  tick(now: number): void {
    if (this.#clock === null || this.#step !== null || (this.#state.phase !== 'playing' && this.#state.phase !== 'count-in')) return;
    const reading = this.#clock.read(now);
    if (reading.phase === 'count-in') {
      this.#set({ secondsToStart: reading.secondsLeft });
      return;
    }
    const s = this.#state.settings;
    const span = this.#span(s);
    if (span.to === null && reading.time > (span.targets[span.targets.length - 1]?.time ?? 0) + 1.5) {
      void this.stop(now);
      return;
    }
    // the clock reads the next pass a little early (a first note played early belongs to it); the pass before is judged once its notes can all have been heard
    while (this.#nextToJudge < reading.pass && now >= this.#clock.due(this.#nextToJudge + 1, span.from) + s.inputLatencySeconds + ANALYSIS_DELAY_SECONDS) this.#judgePass(this.#nextToJudge++);
    this.#schedulePass(reading.pass + 1);
    const upcoming = span.targets.find((t) => t.time >= reading.time - 0.05) ?? null;
    const after = upcoming === null ? null : (span.targets[span.targets.indexOf(upcoming) + 1] ?? null);
    this.#set({ phase: 'playing', secondsToStart: null, pass: reading.pass, current: upcoming, next: after });
  }

  /** Judge a pass — whole, or (when it is stopped part-way) on the targets already due by `dueBy` (reference time). A pass with none due is not judged. */
  #judgePass(pass: number, dueBy = Number.POSITIVE_INFINITY): void {
    if (!this.#state.assessing) return;
    const span = this.#span(this.#state.settings);
    const clock = this.#clock as LessonClock;
    const targets = span.targets.filter((t) => t.time <= dueBy);
    if (targets.length === 0) return;
    const assessed = assessNotes(targets, this.#heardByPass.get(pass) ?? []);
    // a target whose window the capture did not cover — the microphone stopped, or sent zeros — is unassessed: whatever was heard there, no verdict
    const latency = this.#state.settings.inputLatencySeconds;
    const capture = this.#capture;
    const results = capture === null ? assessed.results : unassessedWhereUnheard(assessed.results, (e) => {
      const due = clock.due(pass, e.time) + latency;
      return capture.healthyBetween(due - COVER_BEFORE_SECONDS, due + COVER_AFTER_SECONDS);
    });
    // the judgement is made when the pass ends; each target's own due time is a field of its event
    const judgedAt = clock.due(pass + 1, span.from) - this.#startedAt;
    for (const r of results) this.#queue({ t: judgedAt, kind: 'assessment', target: r.expected.id, pass, dueAt: clock.due(pass, r.expected.time) - this.#startedAt, pitch: r.pitch, timing: r.timing, offsetSeconds: r.offsetSeconds });
    const passes = [...this.#state.passes, { pass, results, extra: assessed.extra.length }];
    // a pass cut short by Stop — less than half of it due — is kept in the attempt, but the review stays on the last full one
    const fragment = dueBy !== Number.POSITIVE_INFINITY && targets.length < span.targets.length / 2 && this.#state.feedback !== null;
    this.#set(fragment ? { passes } : { passes, reviewPass: pass, feedback: feedbackOf(results, [], assessed.extra.length) });
  }

  /** Stop: the pass under way is judged (flow), the attempt is finished and saved — or said not to be — and the session reviews. */
  async stop(now: number): Promise<void> {
    if (this.#state.phase !== 'playing' && this.#state.phase !== 'count-in') return;
    this.#playback?.cancelAll();
    if (this.#step !== null && this.#state.assessing) {
      // step mode: a target reached is right (the music waited for it); one not reached yet was never asked for — not a mistake, so not assessed;
      // how many tries each took is said apart
      const step = this.#step;
      const targets = this.#state.loopTargets;
      const reached = step.done ? targets.length : Math.max(0, targets.findIndex((t) => t.id === this.#state.current?.id));
      const results: NoteResult[] = targets.map((t, i) => ({ expected: t, heard: null, pitch: i < reached ? 'correct' : 'unassessed', timing: null, offsetSeconds: null }));
      const retried = step.tries.slice(0, reached).filter((n) => n > 1).length;
      const feedback = feedbackOf(results, [], 0);
      const sentences = [
        reached === 0 ? 'You stopped before the first note.' : `You played ${reached} of the ${targets.length} notes${reached === targets.length ? ', every one' : ''}.`,
        ...(retried > 0 ? [`${retried} of them took more than one try: play those bars again, slowly.`] : []),
      ];
      this.#set({ passes: [{ pass: 0, results, extra: 0 }], reviewPass: 0, feedback: { ...feedback, repeatBar: null, sentences } });
    } else if (this.#clock !== null && Number.isFinite(now)) {
      const reading = this.#clock.read(now);
      if (reading.phase === 'playing') {
        // the passes before the one under way, whole; the one under way, on what had fallen due (a note gets the assessment window to be played)
        for (let p = this.#nextToJudge; p <= reading.pass; p++) this.#judgePass(p, p < reading.pass ? Number.POSITIVE_INFINITY : reading.time - DEFAULT_POLICY.windowSeconds);
        this.#nextToJudge = reading.pass + 1;
      }
    }
    this.#set({ phase: 'reviewing', secondsToStart: null });
    await this.#flush(true);
  }

  /** An event for the attempt, its time clamped so that the attempt never goes back in time. */
  #queue(event: { t: number; kind: string; [k: string]: unknown }): void {
    const t = Math.max(this.#lastT, event.t, 0);
    this.#lastT = t;
    this.#pending.push({ ...event, t });
  }

  /** Save what is queued — in order, one call at a time — and, at the end, finish the attempt. */
  #flush(final: boolean): Promise<void> {
    this.#chain = this.#chain.then(async () => {
      const attempt = this.#state.attempt;
      if (this.#store === null || attempt.kind !== 'recording') return;
      if (this.#pending.length >= BUFFER || final) {
        const batch = this.#pending;
        this.#pending = [];
        if (batch.length > 0) {
          const r = await this.#store.append(attempt.recordingId, batch);
          if (!r.ok) {
            this.#set({ attempt: { kind: 'failed', message: r.error?.message ?? 'the recorder refused the events' } });
            return;
          }
          this.#saved += batch.length;
        }
      }
      if (final) {
        const r = await this.#store.finish(attempt.recordingId);
        this.#set({ attempt: r.ok ? { kind: 'saved', recordingId: attempt.recordingId, events: this.#saved } : { kind: 'failed', message: r.error?.message ?? 'the recorder could not finish the attempt' } });
      }
    });
    return this.#chain;
  }

  #saved = 0;

  /** Resolves when every save queued so far is done. */
  settled(): Promise<void> {
    return this.#chain;
  }

  /** The capture-clock time a reference time falls due in a pass — for prompts, and for a simulated learner in the tests. Null before start. */
  due(pass: number, referenceTime: number): number | null {
    return this.#clock === null ? null : this.#clock.due(pass, referenceTime);
  }

  /** The bar of a reference-time, for display. */
  barAt(time: number): number {
    const map = tempoMapOf(this.#reference);
    return barOfTick(Math.round(map.tickAt(Math.max(0, time))), this.#reference.timing, this.#pickupTicks);
  }
}
