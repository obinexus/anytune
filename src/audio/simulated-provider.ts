/**
 * A pitch provider driven by hand — by a test, or by the demo's simulation controls. It hears what it is told to hear, stamped with the scheduler's clock, and
 * only while it listens. It can be told to fail as a real input fails.
 */
import type { PitchProvider, ProviderEvent, Scheduler, SourceState } from '../domain/ports.ts';
import { Emitter } from './emitter.ts';

export interface SimulatedOptions {
  /** what `start()` ends in: listening, or a failure to start */
  readonly startOutcome?: 'listening' | 'permission-denied' | 'no-device';
}

export class SimulatedPitchProvider implements PitchProvider {
  private readonly events = new Emitter<ProviderEvent>();
  private state: SourceState | 'idle' = 'idle';

  readonly id: string;
  private readonly clock: Scheduler;
  private readonly options: SimulatedOptions;

  constructor(id: string, clock: Scheduler, options: SimulatedOptions = {}) {
    this.id = id;
    this.clock = clock;
    this.options = options;
  }

  subscribe(observer: (event: ProviderEvent) => void): () => void {
    return this.events.subscribe(observer);
  }

  async start(): Promise<void> {
    if (this.state === 'listening' || this.state === 'starting') return;
    this.become('starting');
    this.become(this.options.startOutcome ?? 'listening');
  }

  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.become('stopped');
  }

  /** Hear a pitch now. */
  hear(frequencyHz: number, estimate: { readonly confidence?: number; readonly varianceHz2?: number } = {}): void {
    if (this.state !== 'listening') return;
    this.events.emit({
      kind: 'observation',
      observation: { sourceId: this.id, frequencyHz, varianceHz2: estimate.varianceHz2 ?? 0.04, confidence: estimate.confidence ?? 0.95, timestampMs: this.clock.now() },
    });
  }

  /** Hear no pitch now. */
  silence(): void {
    if (this.state !== 'listening') return;
    this.events.emit({ kind: 'silence', sourceId: this.id, timestampMs: this.clock.now() });
  }

  /** Lose the input, as a device that is unplugged. */
  disconnect(): void {
    if (this.state !== 'listening') return;
    this.become('disconnected');
  }

  private become(state: SourceState): void {
    this.state = state;
    this.events.emit({ kind: 'state', sourceId: this.id, state, timestampMs: this.clock.now() });
  }
}
