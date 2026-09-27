/**
 * The tuning session: AnyTune's application state, and the service that moves it. The user's intents (select an instrument, start, stop) and the fusion's
 * events are its only inputs; the state it publishes is plain, frozen data, the same for the same inputs. Framework-neutral — the UI reads it through a view
 * (view.ts) and the demo harness bridges it into the UI's reactivity. The fusion is injected: this layer never names a provider, an Obicall reader or Vue.
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
  | 'unavailable'
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
}

export interface SessionDeps {
  readonly fusion: PitchFusionPort;
  readonly catalog: readonly InstrumentTuning[];
  readonly policy: TuningPolicy;
  readonly instrumentId: string;
}

const INPUT_FAILURES: readonly FusionState[] = [...SOURCE_FAILURES, 'unavailable'];
const INSTRUMENT_ERRORS: readonly AppErrorKind[] = ['unsupported-instrument', 'invalid-tuning'];

const freeze = (state: AnyTuneState): AnyTuneState => Object.freeze({ ...state, input: Object.freeze({ ...state.input }), ...(state.error === null ? {} : { error: Object.freeze({ ...state.error }) }) });

export class TuningSession {
  private state: AnyTuneState;
  private recent: TuningReading[] = [];
  private readonly listeners = new Set<(state: AnyTuneState) => void>();
  private subscribed = false;
  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.state = freeze({
      session: 'idle',
      instrumentId: deps.instrumentId,
      reading: null,
      stable: false,
      signal: 'none',
      input: { state: 'idle', connected: false, confidence: 0 },
      error: null,
    });
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
    if (!this.subscribed) {
      this.deps.fusion.subscribe((event) => this.onFusion(event));
      this.subscribed = true;
    }
    await this.deps.fusion.start();
  }

  async stop(): Promise<void> {
    await this.deps.fusion.stop();
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
