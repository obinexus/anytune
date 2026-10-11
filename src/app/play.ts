/**
 * Play — instrument karaoke: the song runs from start to end, the prompts arrive in time, and the learner plays their own instrument along with it. Not
 * practice: no loops and no waiting; the tempo can be set, and the song paused, resumed and restarted.
 *
 * ONE timing source drives everything: the play clock (src/lesson/play-clock.ts) on the audio clock. Each note of the reference and each click is
 * scheduled at the audio time the clock gives for its song time, a short way ahead (LOOKAHEAD); the prompts are placed by the same clock; a captured note
 * is placed on the song by the same clock. A pause cancels what was scheduled and holds the position; a resume, a tempo change and a restart re-anchor the
 * clock and schedule again from where the song is — so the playback and the prompts never drift apart.
 *
 * Feedback is optional. With it, the microphone has been checked first (the shell's listener), what is heard is judged against the ARRANGEMENT (its keys:
 * an octave lower than written, when it is) as the song passes, and the review counts only what the microphone covered. Without it, nothing is listened
 * to and no score of any kind is given.
 */
import type { LiveEvent } from '../analysis/live.ts';
import { noteOf } from '../domain/pitch.ts';
import { DEFAULT_POLICY, assessNotes, unassessedWhereUnheard, type HeardNote, type NoteResult } from '../lesson/assessment.ts';
import { feedbackOf, type Feedback } from '../lesson/feedback.ts';
import { PlayClock, beatGrid, type Beat } from '../lesson/play-clock.ts';
import type { Reference } from '../music/reference.ts';
import type { Arrangement, Target } from './arrangement.ts';
import type { CaptureCoverage, Playback } from './practice.ts';

/** how far ahead of the audio clock the notes and clicks are scheduled, seconds */
export const LOOKAHEAD_SECONDS = 1;
/** the song ends this long after its last note */
const TAIL_SECONDS = 1.5;
/** a note this much before the song starts (or resumes) belongs to it, played early — as in practice */
const EARLY_SECONDS = 0.15;
/** a target is judged once the analysis can have reported a note played in time for it — and its window has passed */
const JUDGE_AFTER_SECONDS = DEFAULT_POLICY.windowSeconds + 0.25;

export interface PlaySettings {
  /** 0.5 … 1.25 of the written tempo */
  readonly tempoFactor: number;
  readonly countInBeats: number;
  readonly metronome: boolean;
  readonly playReference: boolean;
  /** the correction for the capture's delay, seconds (the browser-reported total) */
  readonly inputLatencySeconds: number;
}

export const DEFAULT_PLAY_SETTINGS: PlaySettings = Object.freeze({ tempoFactor: 1, countInBeats: 3, metronome: true, playReference: true, inputLatencySeconds: 0 });

export type PlayPhase = 'ready' | 'count-in' | 'playing' | 'paused' | 'finished';

export interface PlayState {
  readonly phase: PlayPhase;
  readonly title: string;
  readonly arrangement: Arrangement;
  readonly settings: PlaySettings;
  /** song seconds: where the song is now (for the display) */
  readonly position: number;
  /** song seconds: the length */
  readonly duration: number;
  readonly beats: readonly Beat[];
  /** the beat the song is in now, or null before the first */
  readonly beat: Beat | null;
  /** the target to play now — the one at the playhead, or the next to arrive — and the one after */
  readonly current: Target | null;
  readonly next: Target | null;
  /** count-in seconds left */
  readonly secondsToStart: number | null;
  readonly assessing: boolean;
  /** a brief word on the last note heard: "On time", "Try E3" */
  readonly liveText: string;
  /** judged so far, in song order */
  readonly results: readonly NoteResult[];
  readonly feedback: Feedback | null;
  /** counts the starts and restarts: one listing per run */
  readonly run: number;
}

export interface PlayStartOptions {
  readonly assess?: boolean;
  readonly capture?: CaptureCoverage | null;
}

export class PlaySession {
  readonly #targets: readonly Target[];
  readonly #playback: Playback | null;
  readonly #clock = new PlayClock();
  readonly #listeners = new Set<(s: PlayState) => void>();
  #state: PlayState;
  #capture: CaptureCoverage | null = null;
  /** song time up to which notes and clicks are scheduled */
  #scheduledTo = 0;
  /** each target reached in this run: the audio time it was due */
  readonly #due = new Map<string, number>();
  #heard: HeardNote[] = [];
  #extra = 0;
  /** the targets judged so far, by id */
  readonly #judged = new Map<string, NoteResult>();
  readonly #reference: Reference;

  constructor(reference: Reference, arrangement: Arrangement, options: { readonly playback?: Playback | null; readonly pickupTicks?: number } = {}) {
    this.#reference = reference;
    this.#targets = arrangement.targets;
    this.#playback = options.playback ?? null;
    const last = arrangement.targets[arrangement.targets.length - 1];
    const lastNote = last === undefined ? undefined : reference.notes.find((n) => n.id === last.id);
    const duration = Math.max(last?.time ?? 0, lastNote?.releaseSeconds ?? 0) + 0.5;
    this.#state = {
      phase: 'ready',
      title: reference.song.title,
      arrangement,
      settings: DEFAULT_PLAY_SETTINGS,
      position: 0,
      duration,
      beats: beatGrid(reference, options.pickupTicks ?? 0).filter((b) => b.time <= duration),
      beat: null,
      current: arrangement.targets[0] ?? null,
      next: arrangement.targets[1] ?? null,
      secondsToStart: null,
      assessing: false,
      liveText: '',
      results: [],
      feedback: null,
      run: 0,
    };
  }

  getState(): PlayState {
    return this.#state;
  }

  subscribe(listener: (s: PlayState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<PlayState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }

  /** The audio time a song time is due — the clock's, the same one the playback and the prompts use. */
  dueAt(songTime: number): number | null {
    return this.#clock.audioTimeOf(songTime);
  }

  /** The song position at audio time `t`. */
  positionAt(t: number): number {
    return this.#clock.position(t);
  }

  #beatSeconds(): number {
    const b = this.#state.beats;
    const gap = b.length > 1 ? (b[1] as Beat).time - (b[0] as Beat).time : 0.5;
    return gap / this.#state.settings.tempoFactor;
  }

  /** Change settings; the tempo may change while playing — the clock is re-anchored at the current position and what follows is scheduled again. */
  configure(now: number, patch: Partial<PlaySettings>): void {
    const settings = { ...this.#state.settings, ...patch, tempoFactor: Math.min(1.25, Math.max(0.5, patch.tempoFactor ?? this.#state.settings.tempoFactor)) };
    const tempoChanged = settings.tempoFactor !== this.#state.settings.tempoFactor;
    this.#set({ settings });
    if (tempoChanged && (this.#state.phase === 'playing' || this.#state.phase === 'count-in' || this.#state.phase === 'paused')) {
      if (this.#state.phase === 'paused') {
        this.#clock.setTempo(now, settings.tempoFactor);
        return;
      }
      this.#playback?.cancelAll();
      this.#clock.setTempo(now, settings.tempoFactor);
      this.#unschedule(this.#clock.position(now));
      this.#schedule(now);
    }
  }

  /** Start the song from its beginning: a count-in, then the song, on the audio clock. Assessed only when asked — after the microphone was checked. */
  start(now: number, options: PlayStartOptions = {}): void {
    if (this.#state.phase === 'count-in' || this.#state.phase === 'playing') return;
    const s = this.#state.settings;
    const beat = this.#beatSeconds();
    const countIn = s.countInBeats * beat;
    this.#capture = options.capture ?? null;
    this.#due.clear();
    this.#judged.clear();
    this.#heard = [];
    this.#extra = 0;
    this.#scheduledTo = 0;
    this.#playback?.cancelAll();
    this.#clock.start(now + countIn, 0, s.tempoFactor);
    for (let b = 0; b < s.countInBeats; b++) this.#playback?.click(now + b * beat, b === 0);
    this.#set({ phase: 'count-in', position: 0, beat: null, secondsToStart: countIn, assessing: options.assess ?? false, liveText: '', results: [], feedback: null, run: this.#state.run + 1, current: this.#targets[0] ?? null, next: this.#targets[1] ?? null });
    this.#schedule(now);
  }

  /** Restart: the run so far is set aside and the song starts again from its beginning, with the same choice of feedback. */
  restart(now: number): void {
    const assess = this.#state.assessing;
    this.#clock.stop(now);
    this.#playback?.cancelAll();
    this.#set({ phase: 'ready' });
    this.start(now, { assess, capture: this.#capture });
  }

  pause(now: number): void {
    if (this.#state.phase !== 'playing' && this.#state.phase !== 'count-in') return;
    this.#playback?.cancelAll();
    this.#clock.pause(now);
    this.#unschedule(this.#clock.position(now));
    this.#set({ phase: 'paused', position: this.#clock.position(now), secondsToStart: null, liveText: '' });
  }

  /** Resume where the song was paused, after a count-in. */
  resume(now: number): void {
    if (this.#state.phase !== 'paused') return;
    const s = this.#state.settings;
    const beat = this.#beatSeconds();
    const countIn = s.countInBeats * beat;
    for (let b = 0; b < s.countInBeats; b++) this.#playback?.click(now + b * beat, b === 0);
    this.#clock.resume(now + countIn, s.tempoFactor);
    this.#set({ phase: 'count-in', secondsToStart: countIn });
    this.#schedule(now);
  }

  /** Stop before the end: what was reached is judged, and the run reviewed. */
  stop(now: number): void {
    if (this.#state.phase === 'ready' || this.#state.phase === 'finished') return;
    this.#playback?.cancelAll();
    this.#clock.stop(now);
    this.#unschedule(this.#clock.position(now));
    this.#finish(now, true);
  }

  /**
   * The display's frame: the count-in ends, the position moves, notes and clicks are scheduled ahead, targets whose time has passed are judged, the song
   * ends. `displayDelay`: how long after its scheduled time a sound is heard (the output latency) — the prompts are placed where the sound is.
   */
  tick(now: number, displayDelay = 0): void {
    const phase = this.#state.phase;
    if (phase !== 'count-in' && phase !== 'playing') return;
    const startsAt = this.#clock.audioTimeOf(this.#clock.position(now)) ?? now;
    if (phase === 'count-in' && now < startsAt - 1e-9) {
      this.#set({ secondsToStart: startsAt - now });
      this.#schedule(now);
      return;
    }
    const position = this.#clock.position(now - displayDelay);
    this.#schedule(now);
    this.#judgeDue(now);
    if (this.#clock.position(now) > this.#state.duration + TAIL_SECONDS) {
      this.#clock.stop(now);
      this.#finish(now, false);
      return;
    }
    const upcoming = this.#targets.find((t) => t.time >= position - 0.08) ?? null;
    const after = upcoming === null ? null : (this.#targets[this.#targets.indexOf(upcoming) + 1] ?? null);
    const beat = [...this.#state.beats].reverse().find((b) => b.time <= position + 1e-9) ?? null;
    this.#set({ phase: 'playing', secondsToStart: null, position, current: upcoming, next: after, beat });
  }

  /** Schedule the notes and clicks due within the lookahead, at the clock's audio times. */
  #schedule(now: number): void {
    if (this.#clock.state !== 'running') return;
    const s = this.#state.settings;
    const until = this.#clock.position(now + LOOKAHEAD_SECONDS);
    for (const t of this.#targets) {
      if (t.time < this.#scheduledTo || t.time >= until) continue;
      const at = this.#clock.audioTimeOf(t.time);
      if (at === null) continue;
      this.#due.set(t.id, at);
      if (s.playReference) {
        const note = this.#reference.notes.find((n) => n.id === t.id);
        const duration = note === undefined ? 0.3 : (note.releaseSeconds - note.onsetSeconds) / s.tempoFactor;
        this.#playback?.note(t.key, at, duration, note?.velocity ?? 80);
      }
    }
    if (s.metronome) {
      for (const b of this.#state.beats) {
        if (b.time < this.#scheduledTo || b.time >= until) continue;
        const at = this.#clock.audioTimeOf(b.time);
        if (at !== null) this.#playback?.click(at, b.beat === 1);
      }
    }
    this.#scheduledTo = Math.max(this.#scheduledTo, until);
  }

  /** What was scheduled at or after song time `from` was cancelled: it is no longer due. */
  #unschedule(from: number): void {
    for (const t of this.#targets) if (t.time >= from - 1e-9 && !this.#judged.has(t.id)) this.#due.delete(t.id);
    this.#scheduledTo = from;
  }

  /**
   * What the live analysis heard, placed on the song by the clock — a note in a count-in or a pause is no part of the song. Notes and unclear onsets are
   * kept for judging; each gets a brief word against the nearest target.
   */
  hear(events: readonly LiveEvent[]): void {
    if (!this.#state.assessing || (this.#state.phase !== 'playing' && this.#state.phase !== 'count-in')) return;
    let liveText = this.#state.liveText;
    for (const e of events) {
      if (e.kind !== 'note' && e.kind !== 'unclear') continue;
      const at = this.#clock.refAt(e.time - this.#state.settings.inputLatencySeconds, EARLY_SECONDS);
      if (at === null) continue;
      const note: HeardNote = e.kind === 'note' ? { time: at.time, key: e.key, cents: e.cents, confidence: e.confidence } : { time: at.time, key: -1, cents: 0, confidence: 0 };
      this.#heard.push(note);
      liveText = this.#liveWord(note) ?? liveText;
    }
    this.#set({ liveText });
  }

  #liveWord(note: HeardNote): string | null {
    let nearest: Target | null = null;
    for (const t of this.#targets) if (Math.abs(t.time - note.time) <= DEFAULT_POLICY.windowSeconds && (nearest === null || Math.abs(t.time - note.time) < Math.abs(nearest.time - note.time))) nearest = t;
    if (nearest === null) return null;
    if (!(note.confidence >= DEFAULT_POLICY.minConfidence)) return 'I could not hear that one clearly';
    const label = noteOf(nearest.key).label;
    if (note.key !== nearest.key) return (note.key - nearest.key) % 12 === 0 ? `Right note, other octave — try ${label}` : `Try ${label}`;
    const dt = note.time - nearest.time;
    return Math.abs(dt) <= DEFAULT_POLICY.onTimeSeconds ? 'On time' : dt < 0 ? 'A little early' : 'A little late';
  }

  /** Judge the targets whose time has passed long enough for a note played for them to have been reported. */
  #judgeDue(now: number): void {
    if (!this.#state.assessing) return;
    const latency = this.#state.settings.inputLatencySeconds;
    const ready = this.#targets.filter((t) => !this.#judged.has(t.id) && this.#due.has(t.id) && now >= (this.#due.get(t.id) as number) + latency + JUDGE_AFTER_SECONDS);
    if (ready.length === 0) return;
    this.#judgeAll(ready);
  }

  /** Judge every target reached so far and not yet judged — all at once, so the alignment sees the heard notes around them. */
  #judgeAll(targets: readonly Target[]): void {
    const reached = this.#targets.filter((t) => this.#due.has(t.id));
    const assessed = assessNotes(reached, this.#heard);
    const latency = this.#state.settings.inputLatencySeconds;
    const capture = this.#capture;
    const results = capture === null ? assessed.results : unassessedWhereUnheard(assessed.results, (e) => {
      const due = (this.#due.get(e.id) as number) + latency;
      return capture.healthyBetween(due - 0.1, due + 0.25);
    });
    const want = new Set(targets.map((t) => t.id));
    for (const r of results) if (want.has(r.expected.id)) this.#judged.set(r.expected.id, r);
    this.#extra = assessed.extra.length;
    const judged = this.#targets.flatMap((t) => (this.#judged.has(t.id) ? [this.#judged.get(t.id) as NoteResult] : []));
    this.#set({ results: judged });
  }

  #finish(now: number, stopped: boolean): void {
    if (this.#state.assessing) {
      // everything reached is judged now: what was due too recently to have been heard is left out of a stopped run
      const latency = this.#state.settings.inputLatencySeconds;
      const reached = this.#targets.filter((t) => !this.#judged.has(t.id) && this.#due.has(t.id) && (!stopped || now >= (this.#due.get(t.id) as number) + latency + DEFAULT_POLICY.windowSeconds));
      if (reached.length > 0) this.#judgeAll(reached);
    }
    const results = this.#state.results;
    this.#set({ phase: 'finished', secondsToStart: null, liveText: '', feedback: this.#state.assessing ? feedbackOf(results, [], this.#extra) : null });
  }
}
