/**
 * The tuning session: AnyTune's application state, and the service that moves it. The user's intents (select an instrument, start, stop) and the fusion's
 * events are its only inputs; the state it publishes is plain, frozen data, the same for the same inputs. Framework-neutral — the UI reads it through a view
 * (view.ts) and the demo harness bridges it into the UI's reactivity. The fusion is injected: this layer never names a provider, a format reader or Vue.
 */
import type { FusionEvent, FusionState, PitchFusionPort } from '../domain/ports.ts';
import { SOURCE_FAILURES } from '../domain/ports.ts';
import { findTuning, isStable, readPitch, validateTuning } from '../domain/tuning.ts';
import type { InstrumentTuning, TuningPolicy, TuningReading } from '../domain/tuning.ts';

export type SessionState = 'idle' | 'starting' | 'listening' | 'error';

export type AppErrorKind =
  | 'permission-denied'
  | 'no-device'
  | 'disconnected'
  | 'insecure-context'
  | 'unsupported'
  | 'microphone-unavailable'
  | 'audio-failed'
  | 'microphone-muted'
  | 'unavailable'
  | 'unsupported-input'
  | 'unsupported-instrument'
  | 'invalid-tuning';

export interface AppError {
  readonly kind: AppErrorKind;
  readonly detail?: string;
}

export interface AnyTuneState {
  readonly session: SessionState;
  readonly instrumentId: string;
  readonly reading: TuningReading | null;
  /** the last readings agree (the domain's isStable) */
  readonly stable: boolean;
  /** whether a pitch is heard: none, present, or present but uncertain */
  readonly signal: 'none' | 'present' | 'uncertain';
  readonly input: { readonly state: FusionState | 'idle'; readonly connected: boolean; readonly confidence: number };
  readonly error: AppError | null;
  /** the input the session listens to — one of `inputs` */
  readonly inputId: string;
  /** the inputs the session was given, in order: what the user can choose from */
  readonly inputs: readonly { readonly id: string; readonly label: string }[];
}

/** An input the session can listen to: a PitchFusionPort — the microphone's, the demo's — with the id and the label the user chooses it by. */
export interface SessionInput {
  readonly id: string;
  readonly label: string;
  readonly fusion: PitchFusionPort;
}

/** One fusion — the input "default" — or several inputs to choose from, and the one to begin with (the first when none is named). */
export interface SessionDeps {
  readonly fusion?: PitchFusionPort;
  readonly inputs?: readonly SessionInput[];
  readonly inputId?: string;
  readonly catalog: readonly InstrumentTuning[];
  readonly policy: TuningPolicy;
  readonly instrumentId: string;
}

const INPUT_FAILURES: readonly FusionState[] = [...SOURCE_FAILURES, 'unavailable'];
const INSTRUMENT_ERRORS: readonly AppErrorKind[] = ['unsupported-instrument', 'invalid-tuning'];

const freeze = (state: AnyTuneState): AnyTuneState =>
  Object.freeze({ ...state, input: Object.freeze({ ...state.input }), inputs: Object.freeze(state.inputs.map((i) => Object.freeze({ ...i }))), ...(state.error === null ? {} : { error: Object.freeze({ ...state.error }) }) });

export class TuningSession {
  private state: AnyTuneState;
  private recent: TuningReading[] = [];
  private readonly listeners = new Set<(state: AnyTuneState) => void>();
  private readonly subscribed = new Set<string>();
  private readonly deps: SessionDeps;
  private readonly inputs: readonly SessionInput[];

  constructor(deps: SessionDeps) {
    this.deps = deps;
    const inputs = deps.inputs ?? (deps.fusion === undefined ? [] : [{ id: 'default', label: 'Input', fusion: deps.fusion }]);
    const first = inputs.find((i) => i.id === deps.inputId) ?? inputs[0];
    if (first === undefined) throw new Error('TuningSession: no input — give it a fusion, or inputs');
    this.inputs = inputs;
    this.state = freeze({
      session: 'idle',
      instrumentId: deps.instrumentId,
      reading: null,
      stable: false,
      signal: 'none',
      input: { state: 'idle', connected: false, confidence: 0 },
      error: null,
      inputId: first.id,
      inputs: inputs.map((i) => ({ id: i.id, label: i.label })),
    });
  }

  /** The input listened to now. */
  private active(): SessionInput {
    return this.inputs.find((i) => i.id === this.state.inputId) as SessionInput;
  }

  /**
   * Listen to another input. One the session was not given is an error, and the input does not change. The one that was active is stopped first — a
   * microphone gives its stream back — so the session is idle, with no reading; Start begins the new one. Choosing asks nothing of the input itself.
   */
  async selectInput(id: string): Promise<void> {
    if (!this.inputs.some((i) => i.id === id)) return this.set({ error: { kind: 'unsupported-input', detail: id } });
    const inputError = this.state.error !== null && !INSTRUMENT_ERRORS.includes(this.state.error.kind);
    if (id === this.state.inputId) {
      if (inputError) this.set({ error: null });
      return;
    }
    // the choice takes effect at once — a Start that follows at once starts the input chosen — and the one before is stopped after it: what it says while
    // it stops is not the active input's, and moves nothing
    const previous = this.active();
    this.recent = [];
    this.set({
      inputId: id,
      session: 'idle',
      reading: null,
      stable: false,
      signal: 'none',
      input: { state: 'idle', connected: false, confidence: 0 },
      error: inputError ? null : this.state.error,
    });
    await previous.fusion.stop();
  }

  getState(): AnyTuneState {
    return this.state;
  }

  subscribe(listener: (state: AnyTuneState) => void): () => void {
    const own = (state: AnyTuneState): void => listener(state);
    this.listeners.add(own);
    return () => {
      this.listeners.delete(own);
    };
  }

  /** Tune another instrument, from the next pitch on. An id the catalog does not have is an error, and the instrument does not change. */
  selectInstrument(id: string): void {
    if (findTuning(this.deps.catalog, id) === undefined) {
      this.set({ error: { kind: 'unsupported-instrument', detail: id } });
      return;
    }
    this.recent = [];
    const error = this.state.error !== null && INSTRUMENT_ERRORS.includes(this.state.error.kind) ? null : this.state.error;
    this.set({ instrumentId: id, reading: null, stable: false, signal: 'none', error });
  }

  /** Start listening — after which every pitch updates the state with no further intent. An unsupported instrument or an invalid tuning is an error first. */
  async start(): Promise<void> {
    const tuning = findTuning(this.deps.catalog, this.state.instrumentId);
    if (tuning === undefined) return this.set({ session: 'error', error: { kind: 'unsupported-instrument', detail: this.state.instrumentId } });
    const issues = validateTuning(tuning);
    if (issues.length > 0) return this.set({ session: 'error', error: { kind: 'invalid-tuning', detail: issues.join(',') } });
    if (this.state.error !== null) this.set({ error: null });
    const input = this.active();
    if (!this.subscribed.has(input.id)) {
      // only the active input moves the state: one that was switched away from is heard no more
      input.fusion.subscribe((event) => {
        if (this.state.inputId === input.id) this.onFusion(event);
      });
      this.subscribed.add(input.id);
    }
    await input.fusion.start();
  }

  async stop(): Promise<void> {
    await this.active().fusion.stop();
  }

  private onFusion(event: FusionEvent): void {
    switch (event.kind) {
      case 'state':
        return this.onInput(event.state);
      case 'fused': {
        const tuning = findTuning(this.deps.catalog, this.state.instrumentId);
        const reading = tuning === undefined ? null : readPitch(event.pitch, tuning, this.deps.policy);
        if (reading === null) return this.silence();
        this.recent = [...this.recent, reading].slice(-this.deps.policy.stableCount);
        return this.set({
          reading,
          stable: isStable(this.recent, this.deps.policy),
          signal: reading.status === 'uncertain' ? 'uncertain' : 'present',
          input: { ...this.state.input, confidence: event.pitch.confidence },
        });
      }
      case 'silence':
        return this.silence();
      case 'rejected':
        return undefined; // an observation the fusion refused changes nothing that is shown
    }
  }

  private silence(): void {
    this.recent = [];
    this.set({ reading: null, stable: false, signal: 'none', input: { ...this.state.input, confidence: 0 } });
  }

  private onInput(state: FusionState): void {
    if (state === 'starting') return this.set({ session: 'starting', input: { state, connected: false, confidence: 0 } });
    if (state === 'listening' || state === 'degraded') return this.set({ session: 'listening', input: { ...this.state.input, state, connected: true } });
    if (state === 'ended') return this.set({ session: 'idle', input: { state, connected: false, confidence: 0 } });
    if (state === 'stopped') {
      this.recent = [];
      return this.set({ session: 'idle', reading: null, stable: false, signal: 'none', input: { state, connected: false, confidence: 0 } });
    }
    if (INPUT_FAILURES.includes(state)) {
      this.recent = [];
      return this.set({ session: 'error', error: { kind: state as AppErrorKind }, reading: null, stable: false, signal: 'none', input: { state, connected: false, confidence: 0 } });
    }
    return undefined;
  }

  /** Change the state, and publish it — unless nothing changed. */
  private set(change: Partial<AnyTuneState>): void {
    const next = freeze({ ...this.state, ...change });
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener(next);
  }
}
