/**
 * A pitch provider that replays an AnyTune pitch recording: each entry at its timestamp after `start()`, by the scheduler's clock — deterministic in virtual
 * time. A recording of several sources is one provider per recording; each observation keeps the source it names. When the last entry has been replayed the
 * provider has `ended` (unless an entry ended it first, as a disconnection does).
 */
import type { PitchProvider, ProviderEvent, Scheduler, SourceState } from '../domain/ports.ts';
import { Emitter } from './emitter.ts';
import type { PitchRecording, RecordingEntry } from './recording.ts';

export class RecordedPitchProvider implements PitchProvider {
  readonly id: string;
  private readonly events = new Emitter<ProviderEvent>();
  private state: SourceState | 'idle' = 'idle';
  private pending: (() => void)[] = [];

  private readonly recording: PitchRecording;
  private readonly clock: Scheduler;

  constructor(recording: PitchRecording, clock: Scheduler) {
    this.recording = recording;
    this.clock = clock;
    this.id = `recording:${recording.instrument}`;
  }

  subscribe(observer: (event: ProviderEvent) => void): () => void {
    return this.events.subscribe(observer);
  }

  async start(): Promise<void> {
    if (this.state === 'listening' || this.state === 'starting') return;
    const startedAt = this.clock.now();
    this.become('starting', startedAt);
    this.become('listening', startedAt);
    const entries = this.recording.entries;
    entries.forEach((entry, i) => {
      const cancel = this.clock.setTimeout(() => {
        if (this.state !== 'listening') return;
        this.replay(entry, startedAt);
        if (i === entries.length - 1 && this.state === 'listening') this.become('ended', this.clock.now());
      }, entry.timestampMs);
      this.pending.push(cancel);
    });
  }

  async stop(): Promise<void> {
    for (const cancel of this.pending) cancel();
    this.pending = [];
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.become('stopped', this.clock.now());
  }

  private replay(entry: RecordingEntry, startedAt: number): void {
    const timestampMs = startedAt + entry.timestampMs;
    if (entry.kind === 'observation') {
      const { sourceId, frequencyHz, varianceHz2, confidence } = entry;
      this.events.emit({ kind: 'observation', observation: { sourceId, frequencyHz, varianceHz2, confidence, timestampMs } });
    } else if (entry.kind === 'silence') {
      this.events.emit({ kind: 'silence', sourceId: entry.sourceId, timestampMs });
    } else {
      this.become(entry.state, timestampMs);
    }
  }

  private become(state: SourceState, timestampMs: number): void {
    this.state = state;
    this.events.emit({ kind: 'state', sourceId: this.id, state, timestampMs });
  }
}
