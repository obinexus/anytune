/**
 * MicrophonePitchProvider — the microphone as a PitchProvider, beside the simulated and the recorded ones: the same contract, the same events, so that the
 * fusion, the tuning domain, the session and the .obix UI are those of the rest of AnyTune, unchanged.
 *
 *   getUserMedia (audio only; echo cancellation, noise suppression and automatic gain off where the browser allows)
 *     → an AudioContext → a MediaStreamAudioSourceNode → an AnalyserNode of DETECTOR_FRAME_SIZE samples (connected to nothing else: nothing is played)
 *     → every 50 ms, the latest frame → the pure pitch detector (pitch-detector.ts) → a PitchObservation { sourceId "microphone", frequencyHz, confidence,
 *       varianceHz2, timestampMs }
 *
 * The browser's APIs are INJECTED (MicrophoneEnvironment): this module names no global, and the tests run it on a fake browser with no microphone. The
 * harness gives it the real ones (src/harness/main.ts).
 *
 * PRIVACY: the samples of a frame live in one buffer, which each frame overwrites; they are given to the detector and to nothing else — never stored, never
 * sent, never recorded. Only the detected frequency and confidence leave this module.
 *
 * The rates are kept apart: the audio is sampled at the context's rate (44.1 or 48 kHz); the detector reads a frame every FRAME_INTERVAL_MS; the UI renders at
 * most once a tick however many observations arrive; the live region speaks at most once a second.
 */
import type { PitchProvider, ProviderEvent, Scheduler, SourceState } from '../domain/ports.ts';
import { Emitter } from './emitter.ts';
import { DETECTOR_FRAME_SIZE, createYinDetector } from './pitch-detector.ts';
import type { PitchDetector } from './pitch-detector.ts';

// ── what the provider needs of the browser ────────────────────────────────────────────────────────────────────────────────────────────

export interface MicrophoneTrackLike {
  readonly label: string;
  stop(): void;
  getSettings?(): Record<string, unknown>;
  addEventListener(type: 'ended', listener: () => void): void;
  removeEventListener(type: 'ended', listener: () => void): void;
}
export interface MediaStreamLike {
  getAudioTracks(): readonly MicrophoneTrackLike[];
  getTracks(): readonly MicrophoneTrackLike[];
}
export interface MediaDevicesLike {
  getUserMedia(constraints: MicrophoneConstraints): Promise<MediaStreamLike>;
}
export interface AnalyserLike {
  fftSize: number;
  getFloatTimeDomainData(out: Float32Array): void;
  disconnect(): void;
}
export interface SourceNodeLike {
  connect(node: AnalyserLike): unknown;
  disconnect(): void;
}
export interface AudioContextLike {
  readonly sampleRate: number;
  readonly state: string;
  createMediaStreamSource(stream: MediaStreamLike): SourceNodeLike;
  createAnalyser(): AnalyserLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}
export interface MicrophoneEnvironment {
  /** getUserMedia exists only in a secure context: https, or localhost */
  readonly secureContext: boolean;
  readonly mediaDevices: MediaDevicesLike | undefined;
  readonly createAudioContext: (() => AudioContextLike) | undefined;
}

/** What is asked of the browser: audio only, and — as preferences it may ignore, never requirements — none of the processing made for voice calls. */
export const MICROPHONE_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
  video: false,
} as const);

/** What is asked of the browser when the raw audio is digitally silent: audio with the browser's own processing, which some laptop arrays need to give sound. */
export const PROCESSED_MICROPHONE_CONSTRAINTS = Object.freeze({ audio: true, video: false } as const);

export type MicrophoneConstraints = typeof MICROPHONE_CONSTRAINTS | typeof PROCESSED_MICROPHONE_CONSTRAINTS;

/**
 * How long a microphone may send digital silence before it is taken to send nothing: a real microphone always has a noise floor, far above
 * DIGITAL_SILENCE_PEAK, so this is never a pause between plucks — it is a microphone muted, blocked, or silent in raw mode.
 */
export const DIGITAL_SILENCE_MS = 2000;
/** A frame none of whose samples reaches this magnitude — −120 dBFS — is digital silence. */
const DIGITAL_SILENCE_PEAK = 1e-6;

/** How often a frame is read and its pitch detected. */
export const FRAME_INTERVAL_MS = 50;

/**
 * The variance of a microphone pitch, in Hz²: what a period known to one sample implies. A period of P samples rounded to a whole sample is off by at most
 * ½ sample, uniformly — a variance of 1/12 sample² — and f = rate / P, so σ_f = (f² / rate) · σ_P. The detector refines the period below a sample, so this
 * is a bound, not an estimate of its error; it is what the PitchFusionPort needs (a positive variance), and with the microphone as the only source it does
 * not change the pitch the fusion passes on.
 */
export function microphoneVarianceHz2(frequencyHz: number, sampleRate: number): number {
  return (frequencyHz ** 2 / sampleRate) ** 2 / 12;
}

export interface MicrophoneInfo {
  /** the sample rate of the AudioContext, which the detector is given */
  readonly sampleRate: number;
  readonly device: string | null;
  /** what the browser says it does to the audio; null where it does not say */
  readonly processing: { readonly echoCancellation: boolean | null; readonly noiseSuppression: boolean | null; readonly autoGainControl: boolean | null };
  /** raw, as asked first; processed, when the raw audio was digitally silent and the browser's processing was asked for instead */
  readonly mode: 'raw' | 'processed';
}

interface Running {
  readonly context: AudioContextLike;
  readonly source: SourceNodeLike;
  readonly analyser: AnalyserLike;
  readonly tracks: readonly MicrophoneTrackLike[];
  readonly onEnded: () => void;
  readonly frame: Float32Array;
  readonly mode: 'raw' | 'processed';
  cancelTimer: (() => void) | null;
  heard: boolean;
  /** when the digital silence began, or null while there is sound */
  silentSince: number | null;
}

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/**
 * A refusal of getUserMedia, as a state — by the name of its DOMException (Media Capture and Streams): the permission refused (NotAllowedError, and
 * SecurityError for a document the user agent will not let use it), no device that fits (NotFoundError, OverconstrainedError), and anything else — the
 * device busy or failing (NotReadableError), the request aborted (AbortError), what a browser has not named yet — a microphone that cannot be opened.
 */
function stateOfRefusal(error: unknown): SourceState {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  return 'microphone-unavailable';
}

export class MicrophonePitchProvider implements PitchProvider {
  readonly id = 'microphone';
  readonly #events = new Emitter<ProviderEvent>();
  readonly #environment: MicrophoneEnvironment;
  readonly #clock: Scheduler;
  readonly #detector: PitchDetector;
  #state: SourceState | 'idle' = 'idle';
  #running: Running | null = null;
  #starting: Promise<void> | null = null;
  /** raised by every stop: a start that was waiting for the permission sees it and releases what it was given */
  #generation = 0;
  #info: MicrophoneInfo | null = null;

  constructor(environment: MicrophoneEnvironment, clock: Scheduler, detector: PitchDetector = createYinDetector()) {
    this.#environment = environment;
    this.#clock = clock;
    this.#detector = detector;
  }

  /** The input as the browser gave it, once started: its sample rate, the device, the processing. */
  get info(): MicrophoneInfo | null {
    return this.#info;
  }

  subscribe(observer: (event: ProviderEvent) => void): () => void {
    return this.#events.subscribe(observer);
  }

  start(): Promise<void> {
    if (this.#starting !== null) return this.#starting;
    if (this.#state === 'listening') return Promise.resolve();
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const generation = this.#generation;
    this.#become('starting');
    const { secureContext, mediaDevices, createAudioContext } = this.#environment;
    // what cannot work is said before the permission is asked for
    if (!secureContext) return this.#become('insecure-context');
    if (mediaDevices === undefined || createAudioContext === undefined) return this.#become('unsupported');
    const acquired = await this.#acquire('raw', generation, mediaDevices, createAudioContext);
    if (acquired === 'abandoned') return;
    if (typeof acquired === 'string') return this.#become(acquired);
    this.#running = acquired;
    this.#become('listening');
    this.#schedule();
  }

  /**
   * Open the microphone and build the analyser on it — raw, or with the browser's processing — or say why not: a state, or `abandoned` when a stop came
   * meanwhile (and then whatever was given is given back).
   */
  async #acquire(mode: 'raw' | 'processed', generation: number, mediaDevices: MediaDevicesLike, createAudioContext: () => AudioContextLike): Promise<Running | SourceState | 'abandoned'> {
    let stream: MediaStreamLike;
    try {
      stream = await mediaDevices.getUserMedia(mode === 'raw' ? MICROPHONE_CONSTRAINTS : PROCESSED_MICROPHONE_CONSTRAINTS);
    } catch (error) {
      return generation === this.#generation ? stateOfRefusal(error) : 'abandoned';
    }
    const tracks = stream.getTracks();
    if (generation !== this.#generation) {
      for (const track of tracks) track.stop();
      return 'abandoned';
    }
    let context: AudioContextLike | null = null;
    let source: SourceNodeLike | null = null;
    let analyser: AnalyserLike | null = null;
    try {
      context = createAudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = DETECTOR_FRAME_SIZE;
      source.connect(analyser);
      if (context.state === 'suspended') await context.resume();
    } catch {
      source?.disconnect();
      analyser?.disconnect();
      for (const track of tracks) track.stop();
      await context?.close().catch(() => undefined);
      return generation === this.#generation ? 'audio-failed' : 'abandoned';
    }
    if (generation !== this.#generation) {
      source.disconnect();
      analyser.disconnect();
      for (const track of tracks) track.stop();
      await context.close().catch(() => undefined);
      return 'abandoned';
    }
    const onEnded = (): void => {
      void this.#release().then(() => this.#become('disconnected'));
    };
    for (const track of tracks) track.addEventListener('ended', onEnded);
    const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
    this.#info = {
      sampleRate: context.sampleRate,
      device: stream.getAudioTracks()[0]?.label || null,
      processing: { echoCancellation: flag(settings['echoCancellation']), noiseSuppression: flag(settings['noiseSuppression']), autoGainControl: flag(settings['autoGainControl']) },
      mode,
    };
    return { context, source, analyser, tracks, onEnded, frame: new Float32Array(DETECTOR_FRAME_SIZE), mode, cancelTimer: null, heard: false, silentSince: null };
  }

  /**
   * Two seconds of digital silence: the audio is not arriving. Raw, it is asked for once more with the browser's processing on — some laptop microphone
   * arrays give sound only through it; processed and still silent, the microphone is muted (or blocked), and that is said — never "listening".
   */
  async #silent(running: Running): Promise<void> {
    const generation = this.#generation;
    await this.#release();
    if (generation !== this.#generation) return;
    const { mediaDevices, createAudioContext } = this.#environment;
    if (running.mode === 'processed' || mediaDevices === undefined || createAudioContext === undefined) return this.#become('microphone-muted');
    const acquired = await this.#acquire('processed', generation, mediaDevices, createAudioContext);
    if (acquired === 'abandoned') return;
    if (typeof acquired === 'string') return this.#become(acquired);
    this.#running = acquired;
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#generation++;
    const wasActive = this.#state === 'starting' || this.#state === 'listening';
    await this.#release();
    if (wasActive) this.#become('stopped');
  }

  /** Read a frame, detect its pitch, publish it — and read the next one a frame interval later. */
  #schedule(): void {
    const running = this.#running;
    if (running === null) return;
    running.cancelTimer = this.#clock.setTimeout(() => {
      if (this.#running !== running) return;
      running.analyser.getFloatTimeDomainData(running.frame);
      const timestampMs = this.#clock.now();
      let peak = 0;
      for (const sample of running.frame) peak = Math.max(peak, Math.abs(sample));
      if (peak > DIGITAL_SILENCE_PEAK) running.silentSince = null;
      else if (running.silentSince === null) running.silentSince = timestampMs;
      else if (timestampMs - running.silentSince >= DIGITAL_SILENCE_MS) {
        void this.#silent(running);
        return;
      }
      const found = this.#detector.detect(running.frame, running.context.sampleRate);
      if (found !== null) {
        running.heard = true;
        this.#events.emit({
          kind: 'observation',
          observation: { sourceId: this.id, frequencyHz: found.frequencyHz, confidence: found.confidence, varianceHz2: microphoneVarianceHz2(found.frequencyHz, running.context.sampleRate), timestampMs },
        });
      } else if (running.heard) {
        running.heard = false;
        this.#events.emit({ kind: 'silence', sourceId: this.id, timestampMs });
      }
      this.#schedule();
    }, FRAME_INTERVAL_MS);
  }

  /** Give back everything: the timer, the nodes, the tracks, the context. */
  async #release(): Promise<void> {
    const running = this.#running;
    if (running === null) return;
    this.#running = null;
    running.cancelTimer?.();
    for (const track of running.tracks) track.removeEventListener('ended', running.onEnded);
    running.source.disconnect();
    running.analyser.disconnect();
    for (const track of running.tracks) track.stop();
    await running.context.close();
  }

  #become(state: SourceState): void {
    this.#state = state;
    this.#events.emit({ kind: 'state', sourceId: this.id, state, timestampMs: this.#clock.now() });
  }
}
