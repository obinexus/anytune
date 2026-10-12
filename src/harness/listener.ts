/**
 * The microphone, for Practise and Play: opened only when the learner asks for an assessed attempt, checked before anything is judged, watched while it
 * is judged.
 *
 *   open()      idle → requesting → checking: the meter runs, and the first clearly heard note makes it ready (src/app/input-check.ts). Raw audio that is
 *               digital silence is asked for once more with the browser's processing on (some laptop arrays need it), then said to be muted.
 *   listen()    ready → listening: the analysis events go to the session; the capture's coverage (src/app/capture.ts) goes with them, so a target the
 *               microphone could not hear is unassessed, never missed.
 *   alert()     while listening: whether the capture is stalled, silent or gone — said at once, and assessment of that time suspended.
 *   close()     → idle; the capture's summary is kept for the review.
 *
 * Renders are coalesced to the display's frame: the meter does not re-render the page for each of the ~47 frames a second.
 */
import { LiveAnalyser, type LiveEvent, type LiveOptions } from '../analysis/live.ts';
import { CaptureMonitor, type CaptureSummary } from '../app/capture.ts';
import { InputCheck } from '../app/input-check.ts';
import type { CaptureInfo, InputState } from '../app/input-view.ts';
import type { CaptureOutcome, PracticeAudio } from './practice-audio.ts';

const PROBLEM: Readonly<Record<Exclude<CaptureOutcome, 'on'>, InputState['kind']>> = { denied: 'denied', 'no-device': 'no-device', unreadable: 'unreadable', unsupported: 'unsupported', failed: 'failed' };

/** While listening, a stall this long — no frames at all — is said (any gap already leaves the notes around it unassessed) */
const STALL_SECONDS = 0.25;
/** …and digital silence this long */
const SILENT_SECONDS = 1;

export interface CaptureRecord {
  readonly summary: CaptureSummary;
  /** the capture clock's time the attempt started */
  readonly origin: number;
  readonly info: CaptureInfo | null;
}

export class Listener {
  readonly #audio: PracticeAudio;
  readonly #frame: (run: () => void) => () => void;
  readonly #changed: () => void;
  #state: InputState = { kind: 'idle' };
  #monitor: CaptureMonitor | null = null;
  #check: InputCheck | null = null;
  #loudestDb = Number.NEGATIVE_INFINITY;
  #origin = 0;
  #last: CaptureRecord | null = null;
  #renderPending: (() => void) | null = null;
  #hadProblem = false;
  /** how the analysis listens: notes or chords, the observation window — set at open() */
  #analysis: Partial<LiveOptions> = {};
  /** where the analysis events go while listening */
  onEvents: ((events: readonly LiveEvent[]) => void) | null = null;

  constructor(audio: PracticeAudio, frame: (run: () => void) => () => void, changed: () => void) {
    this.#audio = audio;
    this.#frame = frame;
    this.#changed = changed;
  }

  get state(): InputState {
    return this.#state;
  }

  get monitor(): CaptureMonitor | null {
    return this.#monitor;
  }

  levelDb(): number {
    return this.#monitor?.levelDb() ?? Number.NEGATIVE_INFINITY;
  }

  loudestDb(): number {
    return this.#loudestDb;
  }

  /** The last attempt's capture, for the review — kept after the microphone is closed. */
  lastRecord(): CaptureRecord | null {
    return this.#last;
  }

  #set(state: InputState): void {
    this.#state = state;
    this.#changed();
  }

  /** Open the microphone and check it: the learner plucks a string. `analysis`: what the analysis listens for, and its observation window. */
  async open(processing = false, analysis: Partial<LiveOptions> = this.#analysis): Promise<void> {
    this.#analysis = analysis;
    if (this.#state.kind === 'requesting' || this.#state.kind === 'listening') return;
    this.#close(false);
    this.#last = null;
    this.#set({ kind: 'requesting' });
    const audio = this.#audio;
    const monitor = new CaptureMonitor(audio.sampleRate);
    const analyser = new LiveAnalyser({ listenFor: 'notes', ...analysis, sampleRate: audio.sampleRate });
    this.#monitor = monitor;
    this.#check = new InputCheck(audio.now());
    this.#loudestDb = Number.NEGATIVE_INFINITY;
    const outcome = await audio.startCapture({ processing, onFrames: (samples, at) => this.#frames(monitor, analyser, samples, at), onEnded: () => this.#ended(monitor) });
    if (this.#monitor !== monitor) return; // closed meanwhile
    if (outcome !== 'on') {
      this.#monitor = null;
      this.#set({ kind: PROBLEM[outcome] } as InputState);
      return;
    }
    this.#set({ kind: 'checking', hint: 'pluck', processing });
  }

  #frames(monitor: CaptureMonitor, analyser: LiveAnalyser, samples: Float32Array, at: number): void {
    if (this.#monitor !== monitor) return;
    monitor.push(samples, at);
    this.#loudestDb = Math.max(this.#loudestDb, monitor.levelDb());
    const events = analyser.push(samples, at);
    const s = this.#state;
    if ((s.kind === 'checking' || s.kind === 'ready') && this.#check !== null) {
      const v = this.#check.update(monitor, at + samples.length / monitor.sampleRate, events);
      if (s.kind === 'checking') {
        if (v.kind === 'ready') this.#set({ kind: 'ready', heard: v.heard, processing: s.processing });
        else if (v.kind === 'silent') {
          if (!s.processing) void this.open(true);
          else {
            this.#close(false);
            this.#set({ kind: 'muted' });
          }
          return;
        } else if (v.hint !== s.hint) this.#set({ ...s, hint: v.hint });
      }
    } else if (s.kind === 'listening' && events.length > 0) this.onEvents?.(events);
    this.#renderSoon();
  }

  #ended(monitor: CaptureMonitor): void {
    if (this.#monitor !== monitor) return;
    monitor.ended(this.#audio.now());
    if (this.#state.kind === 'listening') {
      this.#changed(); // the alert says it; the session goes on, unassessed
      return;
    }
    this.#close(false);
    this.#set({ kind: 'disconnected' });
  }

  /** ready → listening: returns the capture's coverage, for the session's judgement. */
  listen(): CaptureMonitor | null {
    const s = this.#state;
    if (s.kind !== 'ready' || this.#monitor === null) return null;
    this.#origin = this.#audio.now();
    this.#hadProblem = false;
    this.#set({ kind: 'listening', processing: s.processing });
    return this.#monitor;
  }

  /** While listening: whether the capture is delivering sound now — frames arriving, not digital silence, the device not ended. */
  healthy(now: number): boolean {
    const m = this.#monitor;
    return this.#state.kind === 'listening' && m !== null && m.endedAt === null && m.stalledFor(now) < STALL_SECONDS && m.silentFor() < SILENT_SECONDS;
  }

  /** While listening: what is wrong with the capture now, in words, or '' — and, after a problem has passed, that assessment has resumed. */
  alert(now: number): string {
    const m = this.#monitor;
    if (this.#state.kind !== 'listening' || m === null) return '';
    let text = '';
    if (m.endedAt !== null) text = 'The microphone was disconnected, or its permission withdrawn: the rest of this attempt is not being assessed.';
    else if (m.stalledFor(now) >= STALL_SECONDS) text = 'The microphone stopped delivering sound: this part is not being assessed.';
    else if (m.silentFor() >= SILENT_SECONDS) text = 'The microphone is sending silence: this part is not being assessed.';
    if (text !== '') {
      this.#hadProblem = true;
      return text;
    }
    return this.#hadProblem ? 'The microphone is back: assessment resumed. The interrupted part is not counted.' : '';
  }

  /** Close the microphone; what it captured is kept for the review. */
  close(): void {
    this.#close(true);
    if (this.#state.kind !== 'idle') this.#set({ kind: 'idle' });
  }

  #close(keep: boolean): void {
    this.#renderPending?.();
    this.#renderPending = null;
    if (keep && this.#monitor !== null && this.#state.kind === 'listening') this.#last = { summary: this.#monitor.summary(), origin: this.#origin, info: this.#audio.captureInfo() };
    if (this.#monitor !== null) this.#audio.stopCapture();
    this.#monitor = null;
    this.#check = null;
    this.onEvents = null;
  }

  #renderSoon(): void {
    if (this.#renderPending !== null) return;
    this.#renderPending = this.#frame(() => {
      this.#renderPending = null;
      this.#changed();
    });
  }
}
