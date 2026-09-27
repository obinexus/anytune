/**
 * A browser's microphone and Web Audio, faked for the tests of MicrophonePitchProvider: getUserMedia that grants, refuses or waits; tracks that can be
 * unplugged; an AudioContext whose analyser gives frames of a signal the test chooses, at the scheduler's time. Everything it hands out is counted, so that a
 * test can see a leak: a track never stopped, a context never closed, a node never disconnected.
 */
import type { AnalyserLike, AudioContextLike, MediaDevicesLike, MediaStreamLike, MicrophoneEnvironment, MicrophoneTrackLike, SourceNodeLike } from '../../src/audio/microphone-provider.ts';
import type { Scheduler } from '../../src/domain/ports.ts';

/** A signal: the sample at time `t` seconds. */
export type Signal = (t: number) => number;
export const sineSignal = (frequencyHz: number, amplitude = 0.3): Signal => (t) => amplitude * Math.sin(2 * Math.PI * frequencyHz * t);
export const silentSignal: Signal = () => 0;

export class FakeTrack implements MicrophoneTrackLike {
  stopped = false;
  private readonly ended = new Set<() => void>();
  readonly label: string;
  private readonly settings: Record<string, unknown>;
  constructor(label: string, settings: Record<string, unknown>) {
    this.label = label;
    this.settings = settings;
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings(): Record<string, unknown> {
    return this.settings;
  }
  addEventListener(_type: 'ended', listener: () => void): void {
    this.ended.add(listener);
  }
  removeEventListener(_type: 'ended', listener: () => void): void {
    this.ended.delete(listener);
  }
  /** The device is unplugged, or the browser revokes the permission: the track ends by itself. */
  unplug(): void {
    this.stopped = true;
    for (const listener of [...this.ended]) listener();
  }
  get listeners(): number {
    return this.ended.size;
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getAudioTracks(): readonly FakeTrack[] {
    return this.tracks;
  }
  getTracks(): readonly FakeTrack[] {
    return this.tracks;
  }
}

export class FakeAnalyser implements AnalyserLike {
  fftSize = 2048;
  connected = true;
  private readonly context: FakeAudioContext;
  constructor(context: FakeAudioContext) {
    this.context = context;
  }
  getFloatTimeDomainData(out: Float32Array): void {
    // the last `out.length` samples before now
    const rate = this.context.sampleRate;
    const end = this.context.clock.now() / 1000;
    for (let i = 0; i < out.length; i++) out[i] = this.context.signal(end - (out.length - i) / rate);
  }
  disconnect(): void {
    this.connected = false;
  }
}

export class FakeSourceNode implements SourceNodeLike {
  connectedTo: unknown[] = [];
  disconnect(): void {
    this.connectedTo = [];
  }
  connect(node: AnalyserLike): void {
    this.connectedTo.push(node);
  }
}

export class FakeAudioContext implements AudioContextLike {
  state: 'running' | 'suspended' | 'closed';
  readonly sampleRate: number;
  readonly clock: Scheduler;
  signal: Signal;
  readonly sources: FakeSourceNode[] = [];
  readonly analysers: FakeAnalyser[] = [];
  resumed = 0;
  constructor(sampleRate: number, clock: Scheduler, signal: Signal, state: 'running' | 'suspended') {
    this.sampleRate = sampleRate;
    this.clock = clock;
    this.signal = signal;
    this.state = state;
  }
  createMediaStreamSource(_stream: MediaStreamLike): FakeSourceNode {
    const node = new FakeSourceNode();
    this.sources.push(node);
    return node;
  }
  createAnalyser(): FakeAnalyser {
    const node = new FakeAnalyser(this);
    this.analysers.push(node);
    return node;
  }
  async resume(): Promise<void> {
    this.resumed++;
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
}

export interface FakeBrowserOptions {
  readonly sampleRate?: number;
  readonly signal?: Signal;
  readonly secureContext?: boolean;
  /** what getUserMedia does: grant, or reject with an error of this DOMException name */
  readonly refuse?: string;
  readonly noMediaDevices?: boolean;
  readonly noAudioContext?: boolean;
  /** the AudioContext constructor throws */
  readonly audioContextThrows?: boolean;
  readonly startSuspended?: boolean;
  /** getUserMedia waits until the test calls `grant()` */
  readonly manualGrant?: boolean;
  readonly settings?: Record<string, unknown>;
}

/** A fake browser: the environment for the provider, and what it handed out. */
export class FakeBrowser {
  readonly contexts: FakeAudioContext[] = [];
  readonly tracks: FakeTrack[] = [];
  readonly requests: unknown[] = [];
  signal: Signal;
  private pending: (() => void)[] = [];
  private readonly options: FakeBrowserOptions;
  private readonly clock: Scheduler;

  constructor(clock: Scheduler, options: FakeBrowserOptions = {}) {
    this.clock = clock;
    this.options = options;
    this.signal = options.signal ?? silentSignal;
  }

  get environment(): MicrophoneEnvironment {
    const o = this.options;
    const mediaDevices: MediaDevicesLike | undefined = o.noMediaDevices
      ? undefined
      : {
          getUserMedia: (constraints) => {
            this.requests.push(constraints);
            if (o.refuse !== undefined) return Promise.reject(Object.assign(new Error(`fake ${o.refuse}`), { name: o.refuse }));
            const make = (): MediaStreamLike => {
              const track = new FakeTrack('Fake microphone', o.settings ?? { sampleRate: o.sampleRate ?? 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
              this.tracks.push(track);
              return new FakeStream([track]);
            };
            if (!o.manualGrant) return Promise.resolve(make());
            return new Promise((resolve) => this.pending.push(() => resolve(make())));
          },
        };
    return {
      secureContext: o.secureContext ?? true,
      mediaDevices,
      createAudioContext: o.noAudioContext
        ? undefined
        : () => {
            if (o.audioContextThrows) throw Object.assign(new Error('fake: no audio output'), { name: 'NotSupportedError' });
            const context = new FakeAudioContext(o.sampleRate ?? 48000, this.clock, (t) => this.signal(t), o.startSuspended ? 'suspended' : 'running');
            this.contexts.push(context);
            return context;
          },
    };
  }

  /** Grant every getUserMedia still waiting. */
  grant(): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
  }

  /** What is still held: tracks not stopped, contexts not closed, nodes still connected. */
  get held(): { readonly tracks: number; readonly contexts: number; readonly nodes: number } {
    return {
      tracks: this.tracks.filter((t) => !t.stopped).length,
      contexts: this.contexts.filter((c) => c.state !== 'closed').length,
      nodes: this.contexts.flatMap((c) => [...c.sources.filter((s) => s.connectedTo.length > 0), ...c.analysers.filter((a) => a.connected)]).length,
    };
  }
}
