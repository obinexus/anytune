/**
 * PitchFusionPort implementations. `InverseVarianceFusion` fuses the latest observation of every source heard within a window by inverse variance
 * (scalar-fusion.ts), and turns the states of its sources into one state. `SimulatedPitchFusion` and `RecordedPitchFusion` put it over a simulated or a
 * recorded provider. A native pitch source (the Android capture path) is one more provider behind the same port.
 */
import type { FusionEvent, FusionState, PitchFusionPort, PitchObservation, PitchProvider, ProviderEvent, Scheduler, SourceState } from '../domain/ports.ts';
import { SOURCE_FAILURES } from '../domain/ports.ts';
import { Emitter } from '../audio/emitter.ts';
import { SimulatedPitchProvider } from '../audio/simulated-provider.ts';
import type { SimulatedOptions } from '../audio/simulated-provider.ts';
import { RecordedPitchProvider } from '../audio/recorded-provider.ts';
import type { PitchRecording } from '../audio/recording.ts';
import { fuseInverseVariance } from './scalar-fusion.ts';

export interface FusionOptions {
  /** observations of different sources fuse when they are at most this far apart */
  readonly windowMs: number;
}

export const DEFAULT_FUSION: FusionOptions = Object.freeze({ windowMs: 100 });


export class InverseVarianceFusion implements PitchFusionPort {
  private readonly events = new Emitter<FusionEvent>();
  private readonly latest = new Map<string, PitchObservation>();
  /** the provider each source was heard through */
  private readonly owners = new Map<string, number>();
  private states: SourceState[] = [];
  private state: FusionState | 'idle' = 'idle';
  private unsubscribers: (() => void)[] = [];

  private readonly providers: readonly PitchProvider[];
  private readonly clock: Scheduler;
  private readonly options: FusionOptions;

  constructor(providers: readonly PitchProvider[], clock: Scheduler, options: FusionOptions = DEFAULT_FUSION) {
    this.providers = providers;
    this.clock = clock;
    this.options = options;
  }

  subscribe(listener: (event: FusionEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    if (this.providers.length === 0) return this.become('unavailable', this.clock.now());
    this.latest.clear();
    this.states = this.providers.map(() => 'starting');
    this.become('starting', this.clock.now());
    this.unsubscribers = this.providers.map((provider, i) => provider.subscribe((event) => this.onProvider(i, event)));
    for (const provider of this.providers) await provider.start();
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    for (const provider of this.providers) await provider.stop();
    this.latest.clear();
    this.become('stopped', this.clock.now());
  }

  private onProvider(index: number, event: ProviderEvent): void {
    if (event.kind === 'state') {
      this.states[index] = event.state;
      // a source that stops listening is heard no more: what it said last is not fused with what the others say next
      if (event.state !== 'listening') for (const [sourceId, owner] of this.owners) if (owner === index) this.latest.delete(sourceId);
      const next = this.aggregate();
      if (next !== this.state) this.become(next, event.timestampMs);
      return;
    }
    if (event.kind === 'silence') {
      this.latest.delete(event.sourceId);
      this.publish(event.timestampMs);
      return;
    }
    const obs = event.observation;
    if (!Number.isFinite(obs.frequencyHz) || obs.frequencyHz <= 0 || !Number.isFinite(obs.varianceHz2) || obs.varianceHz2 <= 0) {
      this.events.emit({ kind: 'rejected', sourceId: obs.sourceId, timestampMs: obs.timestampMs, reason: 'a frequency and a variance must be positive finite numbers' });
      return;
    }
    this.latest.set(obs.sourceId, obs);
    this.owners.set(obs.sourceId, index);
    this.publish(obs.timestampMs);
  }

  /** Fuse what was heard within the window before `now`, or say silence when nothing was. */
  private publish(now: number): void {
    const heard = [...this.latest.values()].filter((obs) => obs.timestampMs >= now - this.options.windowMs).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    if (heard.length === 0) return this.events.emit({ kind: 'silence', timestampMs: now });
    const fused = fuseInverseVariance(
      heard.map((o) => o.frequencyHz),
      heard.map((o) => o.varianceHz2),
    );
    if (!fused.ok) return; // unreachable: every observation kept was checked above
    let weighted = 0;
    let weights = 0;
    for (const o of heard) {
      const w = 1 / o.varianceHz2;
      weighted += o.confidence * w;
      weights += w;
    }
    this.events.emit({
      kind: 'fused',
      pitch: { frequencyHz: fused.mean, varianceHz2: fused.variance, confidence: weighted / weights, timestampMs: Math.max(...heard.map((o) => o.timestampMs)), sourceIds: heard.map((o) => o.sourceId) },
    });
  }

  /** One state for all the sources: starting while any is; listening when all are; degraded when some are; else ended, or the first failure. */
  private aggregate(): FusionState {
    if (this.states.includes('starting')) return 'starting';
    const listening = this.states.filter((s) => s === 'listening').length;
    if (listening === this.states.length) return 'listening';
    if (listening > 0) return 'degraded';
    return this.states.find((s) => SOURCE_FAILURES.includes(s)) ?? (this.states.every((s) => s === 'ended') ? 'ended' : 'stopped');
  }

  private become(state: FusionState, timestampMs: number): void {
    this.state = state;
    this.events.emit({ kind: 'state', state, timestampMs });
  }
}

/** A fusion over one simulated provider (`simulated-microphone`), which the caller drives. */
export function SimulatedPitchFusion(clock: Scheduler, options: SimulatedOptions & Partial<FusionOptions> = {}): { readonly port: PitchFusionPort; readonly providers: readonly SimulatedPitchProvider[] } {
  const providers = [new SimulatedPitchProvider('simulated-microphone', clock, options)];
  return { port: new InverseVarianceFusion(providers, clock, { windowMs: options.windowMs ?? DEFAULT_FUSION.windowMs }), providers };
}

/** A fusion over the replay of an AnyTune pitch recording. */
export function RecordedPitchFusion(recording: PitchRecording, clock: Scheduler, options: Partial<FusionOptions> = {}): PitchFusionPort {
  return new InverseVarianceFusion([new RecordedPitchProvider(recording, clock)], clock, { windowMs: options.windowMs ?? DEFAULT_FUSION.windowMs });
}
