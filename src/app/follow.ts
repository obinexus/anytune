/**
 * Follow my playing — trial and improvement: the guitar part, one target at a time, at the learner's own pace. The target now stays until it is RECOGNISED
 * (a consensus YES on an attack: src/lesson/consensus.ts) or explicitly SKIPPED; elapsed time never advances it. A wrong attempt keeps the same target and
 * says what was heard; an unclear one keeps listening and is never a mistake.
 *
 *   attacks   Every decision is taken on one attack — one pluck or strum, reported by the live analysis with the observations after it — and each attack
 *             is consumed once: one pluck never completes two targets. A note left ringing makes no new attack, so it cannot satisfy the next target, even
 *             the same note repeated; attacks from before a change of target are stale and discarded.
 *   pauses    The microphone stopping pauses assessment and keeps the place, adding no mistake. A demonstration ("Hear this target") suspends listening
 *             until its sound has died away, so AnyTune cannot answer itself; so does any note of the accompaniment, for the notes it sounds.
 *   the music The target index is the learning position, apart from any clock. The reference's rhythm is guidance: on each accepted (or skipped) target,
 *             the other parts — the accompaniment — play from that target's time to the next one's, at the chosen tempo, and stop there: nothing runs on
 *             to the end, and nothing hangs while the learner works. A song of one part (a mixed recording's transcription) has no other parts to queue:
 *             the learner chooses — the beat as a click between targets, or nothing.
 *   records   Each pass keeps, per target: first try, corrected (with every wrong attempt heard), skipped, or unassessed; the attempts and the response
 *             time. A phrase repeated is compared with its last pass: "You corrected this passage with two fewer retries."
 */
import type { LiveEvent } from '../analysis/live.ts';
import { DEFAULT_CONSENSUS, judgeChord, judgeNote, type ConsensusOptions, type Decision } from '../lesson/consensus.ts';
import { beatGrid, type Beat } from '../lesson/play-clock.ts';
import { MVP_CHORDS } from '../music/chords.ts';
import type { Voicing } from '../music/guitar.ts';
import type { Reference } from '../music/reference.ts';
import type { Arrangement, Target } from './arrangement.ts';
import { noteName } from './guitar-view.ts';
import type { Playback } from './practice.ts';

/** A target of Follow: a note, or a chord in a voicing. */
export type FollowTarget =
  | { readonly kind: 'note'; readonly id: string; readonly time: number; readonly bar: number; readonly key: number; readonly label: string; readonly target: Target }
  | { readonly kind: 'chord'; readonly id: string; readonly time: number; readonly bar: number; readonly symbol: string; readonly voicing: Voicing; readonly label: string };

export type Outcome = 'pending' | 'first-try' | 'corrected' | 'skipped' | 'unassessed';

export interface TargetRecord {
  readonly index: number;
  readonly id: string;
  readonly label: string;
  readonly bar: number;
  /** what was heard on each wrong attempt, in order */
  readonly wrong: readonly string[];
  readonly outcome: Outcome;
  /** from the target becoming current (pauses left out) to the accepted attack */
  readonly responseSeconds: number | null;
}

export interface FollowPass {
  readonly id: number;
  /** target indexes, inclusive */
  readonly from: number;
  readonly to: number;
  readonly records: readonly TargetRecord[];
  readonly done: boolean;
}

export type FollowPhase = 'ready' | 'listening' | 'demonstrating' | 'input-paused' | 'phrase-done' | 'finished';
export type MessageTone = 'info' | 'wrong' | 'correct' | 'unclear' | 'paused' | 'skipped' | 'demo';
export type Accompaniment = 'parts' | 'click' | 'none';

export interface FollowSettings {
  readonly consensus: ConsensusOptions;
  readonly tempoFactor: number;
  readonly accompaniment: Accompaniment;
  /** the learner wears headphones: the microphone cannot hear AnyTune, so its own notes need no guarding */
  readonly headphones: boolean;
  /** the correction for the capture's delay, seconds */
  readonly latencySeconds: number;
}

export const DEFAULT_FOLLOW_SETTINGS: FollowSettings = Object.freeze({ consensus: DEFAULT_CONSENSUS, tempoFactor: 1, accompaniment: 'none', headphones: false, latencySeconds: 0 });

export interface FollowState {
  readonly phase: FollowPhase;
  readonly title: string;
  readonly arrangementText: string;
  /** for a selector: "Guitar — melody (octave lower)" */
  readonly arrangementLabel: string;
  readonly targets: readonly FollowTarget[];
  readonly index: number;
  readonly current: FollowTarget | null;
  readonly next: FollowTarget | null;
  readonly message: { readonly text: string; readonly tone: MessageTone };
  readonly pass: FollowPass;
  /** the passes finished, oldest first */
  readonly history: readonly FollowPass[];
  /** after a repeated phrase: how it compares with its last pass */
  readonly comparison: string;
  /** audio-clock seconds the session started — elapsed session time, apart from the song's position */
  readonly startedAt: number | null;
  readonly settings: FollowSettings;
  /** whether the song has parts besides the guitar's to accompany it */
  readonly hasParts: boolean;
}

/** how long "Correct" stays before the next target's instruction */
const CORRECT_SECONDS = 0.8;
/** a sound of AnyTune's is heard by the microphone this long after it ends — a guitar note's tail, and the room */
const TAIL_SECONDS = 0.4;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const words = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/** Follow's targets from an arrangement: the guitar melody's notes (the arrangement is followed — a melody stays a melody). */
export function noteTargets(arrangement: Arrangement): FollowTarget[] {
  return arrangement.targets.map((t) => ({ kind: 'note', id: t.id, time: t.time, bar: t.bar, key: t.key, label: noteName(t.key), target: t }));
}

export class FollowSession {
  readonly #reference: Reference;
  readonly #playback: Playback | null;
  readonly #partsTracks: readonly number[];
  readonly #beats: readonly Beat[];
  readonly #listeners = new Set<(s: FollowState) => void>();
  #state: FollowState;
  /** the current target became current at this capture time (pauses added on) */
  #activatedAt = 0;
  /** attacks at or before this capture time are spent: decided, or stale */
  #consumedUntil = Number.NEGATIVE_INFINITY;
  #pausedAt: number | null = null;
  #demoUntil = 0;
  #correctUntil = 0;
  /** AnyTune's own notes on the microphone: capture-time intervals and keys (null: a click, any pitch) */
  #sounding: { from: number; to: number; key: number | null }[] = [];
  /** accompaniment notes already scheduled in this pass */
  readonly #scheduled = new Set<string>();
  #records: TargetRecord[] = [];
  #passIds = 0;

  constructor(reference: Reference, arrangement: Arrangement, targets: readonly FollowTarget[], options: { readonly playback?: Playback | null; readonly melodyTrack: number; readonly pickupTicks?: number; readonly settings?: Partial<FollowSettings> }) {
    this.#reference = reference;
    this.#playback = options.playback ?? null;
    this.#partsTracks = [...new Set(reference.notes.map((n) => n.track))].filter((t) => t !== options.melodyTrack);
    this.#beats = beatGrid(reference, options.pickupTicks ?? 0);
    const hasParts = this.#partsTracks.length > 0;
    const settings = { ...DEFAULT_FOLLOW_SETTINGS, accompaniment: hasParts ? 'parts' : 'none', ...options.settings } as FollowSettings;
    this.#state = {
      phase: 'ready',
      title: reference.song.title,
      arrangementText: arrangement.text,
      arrangementLabel: arrangement.label,
      targets,
      index: 0,
      current: targets[0] ?? null,
      next: targets[1] ?? null,
      message: { text: targets[0] === undefined ? 'This arrangement has no targets.' : this.#playText(targets[0]), tone: 'info' },
      pass: { id: 0, from: 0, to: Math.max(0, targets.length - 1), records: [], done: false },
      history: [],
      comparison: '',
      startedAt: null,
      settings,
      hasParts,
    };
  }

  getState(): FollowState {
    return this.#state;
  }

  /** the song's beats: the reference's rhythm, as guidance on the timeline */
  get beats(): readonly Beat[] {
    return this.#beats;
  }

  subscribe(listener: (s: FollowState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<FollowState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }

  #playText(t: FollowTarget): string {
    return t.kind === 'chord' ? `Play the ${t.symbol} chord` : `Play ${t.label}`;
  }

  configure(patch: Partial<FollowSettings>): void {
    const settings = { ...this.#state.settings, ...patch };
    if (settings.accompaniment === 'parts' && !this.#state.hasParts) return;
    this.#set({ settings: { ...settings, tempoFactor: Math.min(1.25, Math.max(0.25, settings.tempoFactor)) } });
  }

  /** Start listening for a pass from target `from` to `to` (the whole arrangement by default), at capture time `now`. */
  start(now: number, from = 0, to = this.#state.targets.length - 1): void {
    const targets = this.#state.targets;
    if (targets.length === 0) return;
    const f = Math.max(0, Math.min(from, targets.length - 1));
    const t = Math.max(f, Math.min(to, targets.length - 1));
    this.#records = [];
    this.#scheduled.clear();
    this.#sounding = [];
    this.#activatedAt = now;
    this.#consumedUntil = now;
    this.#pausedAt = null;
    this.#demoUntil = 0;
    this.#correctUntil = 0;
    this.#playback?.cancelAll();
    const current = targets[f] as FollowTarget;
    this.#set({
      phase: 'listening',
      index: f,
      current,
      next: f < t ? (targets[f + 1] ?? null) : null,
      pass: { id: ++this.#passIds, from: f, to: t, records: [], done: false },
      comparison: '',
      startedAt: this.#state.startedAt ?? now,
      message: { text: this.#playText(current), tone: 'info' },
    });
    // what comes before the first target, from the song's start
    if (f === 0) this.#accompany(-1, now);
  }

  /** The attacks the live analysis heard. Each is decided once — YES, NO or MAYBE — against the target now. */
  hear(events: readonly LiveEvent[], now: number): void {
    for (const e of events) {
      if (this.#state.phase !== 'listening') return;
      const current = this.#state.current;
      if (current === null) return;
      // an attack is a note or an unclear onset for a note target; a strum for a chord target
      const relevant = current.kind === 'note' ? e.kind === 'note' || e.kind === 'unclear' : e.kind === 'chord';
      if (!relevant || e.time <= this.#consumedUntil) continue;
      this.#consumedUntil = e.time;
      const decision = this.#decide(current, e);
      this.#apply(decision, e.time, now);
    }
  }

  #decide(t: FollowTarget, e: LiveEvent): Decision {
    const o = this.#state.settings.consensus;
    let d: Decision;
    if (t.kind === 'note') d = judgeNote(t.key, (e as { observations: readonly { midi: number | null; confidence: number }[] }).observations, o);
    else {
      const chord = e as Extract<LiveEvent, { kind: 'chord' }>;
      d = judgeChord(t.symbol, chord.readings.map((r) => ({ candidates: r.candidates, confidence: r.confidence })), chord.observations, MVP_CHORDS, o);
    }
    // AnyTune's own sound on the microphone: never an answer
    if (d.kind !== 'maybe' && !this.#state.settings.headphones && this.#ownSound(e.time, d.kind === 'yes' ? (t.kind === 'note' ? t.key : null) : d.heardKey, t.kind === 'chord')) return { kind: 'maybe', why: 'own-playback' };
    return d;
  }

  /** Was AnyTune sounding, at capture time `time`, this pitch class (or anything at all, for a chord)? */
  #ownSound(time: number, key: number | null, anyPitch: boolean): boolean {
    return this.#sounding.some((s) => time >= s.from && time <= s.to && (anyPitch || s.key === null || key === null || (((s.key - key) % 12) + 12) % 12 === 0));
  }

  #apply(d: Decision, attackTime: number, now: number): void {
    const t = this.#state.current as FollowTarget;
    if (d.kind === 'yes') {
      const record = this.#record(this.#state.index);
      this.#recordSet(this.#state.index, { outcome: record.wrong.length === 0 ? 'first-try' : 'corrected', responseSeconds: Math.max(0, attackTime - this.#activatedAt) });
      this.#correctUntil = now + CORRECT_SECONDS;
      this.#set({ message: { text: record.wrong.length === 0 ? 'Correct' : `Correct — after ${words(record.wrong.length)} ${record.wrong.length === 1 ? 'retry' : 'retries'}`, tone: 'correct' } });
      this.#advance(attackTime, now);
      return;
    }
    if (d.kind === 'no') {
      const heard = d.heardSymbol ?? (d.heardKey === null ? '?' : noteName(d.heardKey));
      const record = this.#record(this.#state.index);
      this.#recordSet(this.#state.index, { wrong: [...record.wrong, heard] });
      const want = t.kind === 'chord' ? t.symbol : t.label;
      const text =
        d.why === 'octave' && d.heardKey !== null && t.kind === 'note'
          ? `Heard ${heard} — the right note, an octave ${d.heardKey > t.key ? 'higher' : 'lower'}; try ${want} again.`
          : d.why === 'single-note'
            ? `Heard only ${heard} — strum all the strings of ${want}.`
            : `Heard ${heard}; try ${want} again.`;
      this.#set({ message: { text, tone: 'wrong' } });
      return;
    }
    // MAYBE: keep listening; say so only when something was played
    if (d.why === 'silence') return;
    const want = t.kind === 'chord' ? `the ${t.symbol} chord` : t.label;
    const text =
      d.why === 'own-playback' ? `That sounded like AnyTune's own note — play ${want} when it has died away.`
      : d.why === 'unsupported' ? `AnyTune cannot assess ${want} yet — play it, then press Skip.`
      : `I could not make that out — play ${want} again.`;
    this.#set({ message: { text, tone: 'unclear' } });
  }

  #record(index: number): TargetRecord {
    const existing = this.#records.find((r) => r.index === index);
    if (existing !== undefined) return existing;
    const t = this.#state.targets[index] as FollowTarget;
    const r: TargetRecord = { index, id: t.id, label: t.kind === 'chord' ? t.symbol : t.label, bar: t.bar, wrong: [], outcome: 'pending', responseSeconds: null };
    this.#records.push(r);
    return r;
  }

  #recordSet(index: number, patch: Partial<TargetRecord>): void {
    const r = this.#record(index);
    this.#records = this.#records.map((x) => (x === r ? { ...r, ...patch } : x)).sort((a, b) => a.index - b.index);
    this.#set({ pass: { ...this.#state.pass, records: this.#records } });
  }

  /** The next target: the accompaniment of the one just done plays up to it; at the pass's end, the pass is finished and compared. */
  #advance(at: number, now: number): void {
    const i = this.#state.index;
    this.#accompany(i, now);
    const pass = this.#state.pass;
    if (i >= pass.to) {
      this.#finishPass(now);
      return;
    }
    const targets = this.#state.targets;
    const current = targets[i + 1] as FollowTarget;
    this.#activatedAt = at;
    this.#set({ index: i + 1, current, next: i + 1 < pass.to ? (targets[i + 2] ?? null) : null });
    if (now >= this.#correctUntil) this.#set({ message: { text: this.#playText(current), tone: 'info' } });
  }

  /** Skip the target now: recorded as skipped (or, while the microphone is out, unassessed) — never as a success. */
  skip(now: number): void {
    const phase = this.#state.phase;
    if (phase !== 'listening' && phase !== 'input-paused' && phase !== 'demonstrating') return;
    this.#recordSet(this.#state.index, { outcome: phase === 'input-paused' ? 'unassessed' : 'skipped' });
    this.#consumedUntil = Math.max(this.#consumedUntil, now);
    if (phase === 'demonstrating') this.#set({ phase: 'listening' });
    this.#set({ message: { text: phase === 'input-paused' ? `Moved on without listening: ${this.#state.current?.label ?? ''} is not assessed.` : `Skipped ${this.#state.current?.label ?? ''}.`, tone: 'skipped' } });
    this.#correctUntil = now + CORRECT_SECONDS;
    const wasPaused = phase === 'input-paused';
    this.#advance(now, now);
    if (wasPaused && this.#state.phase === 'listening') this.#set({ phase: 'input-paused' });
  }

  /** Hear this target: the reference plays it; listening is suspended until its sound has died away, so AnyTune cannot answer itself. */
  demonstrate(now: number): void {
    const t = this.#state.current;
    if (t === null || (this.#state.phase !== 'listening' && this.#state.phase !== 'input-paused')) return;
    this.#playback?.cancelAll();
    const at = now + 0.05;
    const duration = 0.9;
    if (t.kind === 'note') this.#playback?.note(t.key, at, duration, 90);
    else t.voicing.frets.forEach((fret, i) => fret !== null && fret !== undefined && this.#playback?.note([40, 45, 50, 55, 59, 64][i] as number + fret, at + i * 0.03, duration, 80));
    this.#demoUntil = at + duration + this.#state.settings.latencySeconds + TAIL_SECONDS;
    this.#consumedUntil = Math.max(this.#consumedUntil, this.#demoUntil);
    this.#set({ phase: 'demonstrating', message: { text: `Listen: ${t.kind === 'chord' ? `the ${t.symbol} chord` : t.label}. I listen again when it has died away.`, tone: 'demo' } });
  }

  /** The microphone stopped (or came back): assessment pauses, the place is kept, nothing is marked. */
  inputAvailable(available: boolean, now: number): void {
    const phase = this.#state.phase;
    if (!available && (phase === 'listening' || phase === 'demonstrating')) {
      this.#pausedAt = now;
      this.#correctUntil = 0;
      this.#playback?.cancelAll();
      this.#set({ phase: 'input-paused', message: { text: 'The microphone stopped delivering sound. Your place is kept and nothing is marked; it listens again when the sound is back.', tone: 'paused' } });
    } else if (available && phase === 'input-paused') {
      if (this.#pausedAt !== null) this.#activatedAt += now - this.#pausedAt;
      this.#pausedAt = null;
      this.#consumedUntil = Math.max(this.#consumedUntil, now);
      const t = this.#state.current;
      this.#set({ phase: 'listening', message: { text: t === null ? '' : `The microphone is back. ${this.#playText(t)}.`, tone: 'info' } });
    }
  }

  /** The display's frame: "Correct" gives way to the next instruction; a demonstration's silence ends. */
  tick(now: number): void {
    const t = this.#state.current;
    if (this.#state.phase === 'demonstrating' && now >= this.#demoUntil) {
      this.#consumedUntil = Math.max(this.#consumedUntil, this.#demoUntil);
      this.#set({ phase: 'listening', message: { text: t === null ? '' : this.#playText(t), tone: 'info' } });
    } else if (this.#state.phase === 'listening' && this.#correctUntil > 0 && now >= this.#correctUntil) {
      this.#correctUntil = 0;
      if (t !== null) this.#set({ message: { text: this.#playText(t), tone: 'info' } });
    }
    this.#sounding = this.#sounding.filter((s) => s.to >= now - 1);
  }

  /** Repeat the bar the target now is in — a new pass over it, compared with the last over the same targets when it ends. */
  repeatBar(now: number): void {
    const t = this.#state.current ?? this.#state.targets[this.#state.pass.to];
    if (t === undefined || t === null) return;
    const inBar = this.#state.targets.map((x, i) => ({ x, i })).filter(({ x }) => x.bar === t.bar);
    this.#closePass(false);
    this.start(now, inBar[0]?.i ?? 0, inBar[inBar.length - 1]?.i ?? 0);
  }

  /** Repeat the pass just finished, over the same targets. */
  repeatPhrase(now: number): void {
    const last = this.#state.history[this.#state.history.length - 1];
    if (last === undefined) return;
    this.start(now, last.from, last.to);
  }

  /** After a phrase: go on from the target after it, to the end. */
  continueAfter(now: number): void {
    const last = this.#state.history[this.#state.history.length - 1];
    const from = (last?.to ?? -1) + 1;
    if (from >= this.#state.targets.length) return;
    this.start(now, from, this.#state.targets.length - 1);
  }

  stop(now: number): void {
    if (this.#state.phase === 'ready' || this.#state.phase === 'finished') return;
    void now;
    this.#playback?.cancelAll();
    this.#closePass(false);
    this.#set({ phase: 'finished', message: { text: 'Stopped. Your progress on this pass is below.', tone: 'info' } });
  }

  #closePass(done: boolean): void {
    const pass = this.#state.pass;
    if (pass.records.length === 0 && !done) return;
    const closed = { ...pass, records: this.#records, done };
    this.#set({ history: [...this.#state.history, closed], pass: closed });
  }

  #finishPass(now: number): void {
    void now;
    const pass = { ...this.#state.pass, records: this.#records, done: true };
    const before = [...this.#state.history].reverse().find((p) => p.done && p.from === pass.from && p.to === pass.to);
    const comparison = before === undefined ? '' : compareText(before, pass);
    const whole = pass.from === 0 && pass.to === this.#state.targets.length - 1;
    this.#set({ history: [...this.#state.history, pass], pass, comparison, phase: whole ? 'finished' : 'phrase-done', current: null, next: null });
  }

  /**
   * The accompaniment of target `i` (−1: what comes before the first): from its time to the next target's, at the chosen tempo — clipped there, so nothing
   * sounds on while the learner works on the next. Each accompaniment note is scheduled once per pass.
   */
  #accompany(i: number, now: number): void {
    const s = this.#state.settings;
    if (s.accompaniment === 'none' || this.#playback === null) return;
    const targets = this.#state.targets;
    const from = i < 0 ? Number.NEGATIVE_INFINITY : (targets[i] as FollowTarget).time;
    const to = targets[i + 1]?.time ?? this.#reference.timing.endSeconds;
    const origin = i < 0 ? Math.min(0, targets[0]?.time ?? 0) : from;
    const startAt = now + 0.03;
    const at = (songTime: number): number => startAt + (songTime - origin) / s.tempoFactor;
    const latency = s.latencySeconds;
    if (s.accompaniment === 'parts') {
      for (const n of this.#reference.notes) {
        if (!this.#partsTracks.includes(n.track) || n.onsetSeconds < from || n.onsetSeconds >= to || this.#scheduled.has(n.id)) continue;
        const duration = (Math.min(n.releaseSeconds, to) - n.onsetSeconds) / s.tempoFactor;
        if (duration < 0.04) continue;
        this.#scheduled.add(n.id);
        this.#playback.note(n.key, at(n.onsetSeconds), duration, n.velocity ?? 80);
        this.#sounding.push({ from: at(n.onsetSeconds) + latency - 0.05, to: at(n.onsetSeconds) + duration + latency + TAIL_SECONDS, key: n.key });
      }
    } else {
      for (const b of this.#beats) {
        if (b.time < from || b.time >= to) continue;
        this.#playback.click(at(b.time), b.beat === 1);
      }
    }
  }
}

/** One pass's numbers: retries, first tries, skips, unassessed, the median response. */
export function passSummary(p: FollowPass): { readonly firstTry: number; readonly corrected: number; readonly retries: number; readonly skipped: number; readonly unassessed: number; readonly reached: number; readonly medianResponse: number | null } {
  const count = (o: Outcome): number => p.records.filter((r) => r.outcome === o).length;
  const responses = p.records.flatMap((r) => (r.responseSeconds === null ? [] : [r.responseSeconds])).sort((a, b) => a - b);
  return {
    firstTry: count('first-try'),
    corrected: count('corrected'),
    retries: p.records.reduce((n, r) => n + r.wrong.length, 0),
    skipped: count('skipped'),
    unassessed: count('unassessed'),
    reached: p.records.filter((r) => r.outcome !== 'pending').length,
    medianResponse: responses.length === 0 ? null : (responses[Math.floor(responses.length / 2)] as number),
  };
}

/** A repeated passage against its last pass, in words: "You corrected this passage with two fewer retries." */
export function compareText(before: FollowPass, now: FollowPass): string {
  const a = passSummary(before);
  const b = passSummary(now);
  const retry = (n: number): string => (n === 1 ? 'retry' : 'retries');
  const parts: string[] = [];
  if (b.retries < a.retries) parts.push(`You corrected this passage with ${words(a.retries - b.retries)} fewer ${retry(a.retries - b.retries)} (${b.retries}; last time ${a.retries}).`);
  else if (b.retries > a.retries) parts.push(`${words(b.retries - a.retries).replace(/^./, (c) => c.toUpperCase())} more ${retry(b.retries - a.retries)} than last time (${b.retries}; last time ${a.retries}) — try it slower, or hear each target first.`);
  else parts.push(`The same number of retries as last time (${b.retries}).`);
  if (b.firstTry !== a.firstTry) parts.push(`First try: ${b.firstTry} of ${b.reached} (last time ${a.firstTry}).`);
  if (b.skipped < a.skipped) parts.push(`${words(a.skipped - b.skipped).replace(/^./, (c) => c.toUpperCase())} fewer skipped.`);
  if (a.medianResponse !== null && b.medianResponse !== null && a.medianResponse - b.medianResponse >= 0.2) parts.push(`About ${(a.medianResponse - b.medianResponse).toFixed(1)} s quicker to each note.`);
  return parts.join(' ');
}
