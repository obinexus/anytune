/**
 * Practice's audio in the browser (and in the Android app's WebView, which is the same engine): ONE clock — the AudioContext's — for what is captured and what
 * is played, so that "when the learner played" and "when the reference sounded" are comparable to the sample.
 *
 *   capture    the microphone → an AudioWorklet on the audio thread, which posts frames of 1024 samples, each stamped with the context frame of its first
 *              sample. No timer anywhere: the audio thread delivers. Raw audio is asked for first (echo cancellation, noise suppression and gain control
 *              off: they bend pitch and smear onsets); some laptop microphone arrays send digital silence raw, so the caller may ask again with the
 *              browser's processing on — and says so. Frames that arrive more than a second late (the page was busy) are dropped and counted. When the
 *              device ends (unplugged, the permission withdrawn) the caller is told at once.
 *   playback   the reference's notes, rendered by the plucked-string synthesiser (src/synthesis/pluck.ts) at the context's rate, and the click, scheduled at
 *              exact context times — which is why a slower tempo needs no time-stretching: the notes are re-timed, not the sound. The reference and the
 *              click each have their own level.
 *
 * Latency: what the browser reports, quantity by quantity — AudioContext.baseLatency, AudioContext.outputLatency and the microphone track's `latency`
 * setting — each possibly absent. They are the browser's estimates of parts of the path, not a measurement of the delay from the speaker to the
 * microphone; AnyTune has not measured that on any device. Nothing captured leaves this page.
 */
import type { CaptureInfo, ReportedLatency } from '../app/input-view.ts';
import type { Playback } from '../app/practice.ts';
import { pluck } from '../synthesis/pluck.ts';

export type CaptureOutcome = 'on' | 'denied' | 'no-device' | 'unreadable' | 'unsupported' | 'failed';

export interface CaptureRequest {
  /** ask for the browser's processing (echo cancellation, noise suppression, automatic gain): only when raw audio was silent */
  readonly processing: boolean;
  onFrames(samples: Float32Array, captureTime: number): void;
  /** the device ended: unplugged, or the permission withdrawn */
  onEnded(): void;
}

export interface PracticeAudio {
  /** the audio clock, seconds */
  now(): number;
  readonly sampleRate: number;
  startCapture(request: CaptureRequest): Promise<CaptureOutcome>;
  stopCapture(): void;
  /** what is open now, or null */
  captureInfo(): CaptureInfo | null;
  readonly playback: Playback;
  /** the reference's and the click's levels, 0…1 */
  setLevels(reference: number, click: number): void;
  latency(): ReportedLatency;
  /** frames dropped because they arrived too late */
  dropped(): number;
}

const WORKLET = `
class AnyTuneCapture extends AudioWorkletProcessor {
  constructor() { super(); this.size = 1024; this.buffer = new Float32Array(this.size); this.filled = 0; this.first = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        if (this.filled === 0) this.first = currentFrame + i;
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.size) {
          this.port.postMessage({ frame: this.first, samples: this.buffer }, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('anytune-capture', AnyTuneCapture);
`;

/** The browser's practice audio, or null where there is no Web Audio. The AudioContext is made at the first use — a user's gesture (Start, Listen). */
export function browserPracticeAudio(): PracticeAudio | null {
  const AudioContextClass = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (AudioContextClass === undefined) return null;
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let worklet: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let workletLoaded = false;
  let info: CaptureInfo | null = null;
  let inputLatency: number | null = null;
  let droppedFrames = 0;
  let referenceGain: GainNode | null = null;
  let clickGain: GainNode | null = null;
  let levels = { reference: 0.8, click: 0.6 };
  const sounding = new Set<AudioBufferSourceNode>();
  const noteCache = new Map<string, AudioBuffer>();
  const ctx = (): AudioContext => {
    if (context === null) context = new AudioContextClass({ latencyHint: 'interactive' });
    if (context.state === 'suspended') void context.resume();
    return context;
  };
  const bus = (which: 'reference' | 'click'): GainNode => {
    const c = ctx();
    if (which === 'reference') {
      referenceGain ??= c.createGain();
      referenceGain.gain.value = levels.reference;
      referenceGain.connect(c.destination);
      return referenceGain;
    }
    clickGain ??= c.createGain();
    clickGain.gain.value = levels.click;
    clickGain.connect(c.destination);
    return clickGain;
  };

  const play = (buffer: AudioBuffer, at: number, gain: number, which: 'reference' | 'click'): void => {
    const c = ctx();
    const node = c.createBufferSource();
    node.buffer = buffer;
    const level = c.createGain();
    level.gain.value = gain;
    node.connect(level).connect(bus(which));
    node.onended = () => sounding.delete(node);
    sounding.add(node);
    node.start(Math.max(c.currentTime, at));
  };

  const playback: Playback = {
    note(key, at, durationSeconds, velocity) {
      const c = ctx();
      const id = `${key}:${Math.round(durationSeconds * 20)}`;
      let buffer = noteCache.get(id);
      if (buffer === undefined) {
        const samples = pluck(440 * 2 ** ((key - 69) / 12), { sampleRate: c.sampleRate, duration: Math.min(2.5, durationSeconds + 0.3), velocity: 0.9 });
        buffer = c.createBuffer(1, samples.length, c.sampleRate);
        buffer.getChannelData(0).set(samples);
        noteCache.set(id, buffer);
      }
      play(buffer, at, 0.5 * (velocity / 127) + 0.2, 'reference');
    },
    click(at, accent) {
      const c = ctx();
      const length = Math.round(0.03 * c.sampleRate);
      const buffer = c.createBuffer(1, length, c.sampleRate);
      const data = buffer.getChannelData(0);
      const hz = accent ? 1600 : 1000;
      for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / c.sampleRate) * (1 - i / length);
      play(buffer, at, accent ? 0.5 : 0.35, 'click');
    },
    cancelAll() {
      for (const node of sounding) node.stop();
      sounding.clear();
    },
  };

  const stopCapture = (): void => {
    worklet?.port.close();
    worklet?.disconnect();
    source?.disconnect();
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    worklet = null;
    source = null;
    stream = null;
    info = null;
  };

  return {
    now: () => ctx().currentTime,
    get sampleRate() {
      return ctx().sampleRate;
    },
    async startCapture(request) {
      const c = ctx();
      const media = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
      if (media === undefined || typeof media.getUserMedia !== 'function' || c.audioWorklet === undefined) return 'unsupported';
      stopCapture();
      try {
        stream = await media.getUserMedia({ audio: request.processing ? true : { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (error) {
        const name = (error as { name?: string }).name;
        return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no-device' : name === 'NotReadableError' || name === 'AbortError' ? 'unreadable' : 'failed';
      }
      try {
        if (!workletLoaded) {
          const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
          await c.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          workletLoaded = true;
        }
        const track = stream.getAudioTracks()[0];
        source = c.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(c, 'anytune-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        worklet.port.onmessage = (message: MessageEvent<{ frame: number; samples: Float32Array }>) => {
          const captureTime = message.data.frame / c.sampleRate;
          if (c.currentTime - captureTime > 1) {
            droppedFrames++;
            return;
          }
          request.onFrames(message.data.samples, captureTime);
        };
        if (track !== undefined) track.onended = () => request.onEnded();
        const silent = c.createGain();
        silent.gain.value = 0; // the worklet runs only when connected to the output: through a gain of 0, the learner never hears themselves
        source.connect(worklet).connect(silent).connect(c.destination);
        const settings = track?.getSettings() as { latency?: number; sampleRate?: number } | undefined;
        inputLatency = typeof settings?.latency === 'number' ? settings.latency : null;
        info = { device: track?.label || 'microphone', sampleRate: c.sampleRate, processing: request.processing };
        return 'on';
      } catch {
        stopCapture();
        return 'failed';
      }
    },
    stopCapture,
    captureInfo: () => info,
    playback,
    setLevels(reference, click) {
      levels = { reference: Math.max(0, Math.min(1, reference)), click: Math.max(0, Math.min(1, click)) };
      if (referenceGain !== null) referenceGain.gain.value = levels.reference;
      if (clickGain !== null) clickGain.gain.value = levels.click;
    },
    latency() {
      const c = context;
      return {
        baseSeconds: c !== null && typeof c.baseLatency === 'number' ? c.baseLatency : null,
        outputSeconds: c !== null && typeof (c as { outputLatency?: number }).outputLatency === 'number' ? ((c as { outputLatency?: number }).outputLatency as number) : null,
        inputSeconds: inputLatency,
      };
    },
    dropped: () => droppedFrames,
  };
}
