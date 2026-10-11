/**
 * Practice's audio in the browser (and in the Android app's WebView, which is the same engine): ONE clock — the AudioContext's — for what is captured and what
 * is played, so that "when the learner played" and "when the reference sounded" are comparable to the sample.
 *
 *   capture    the microphone (echo cancellation, noise suppression and gain control off: they bend pitch and smear onsets) → an AudioWorklet on the audio
 *              thread, which posts frames of 1024 samples, each stamped with the context frame of its first sample. No timer anywhere: the audio thread
 *              delivers. Frames that arrive more than a second late (the page was busy) are dropped and counted, never analysed as if they were now.
 *   playback   the reference's notes, rendered by the plucked-string synthesiser (src/synthesis/pluck.ts) at the context's rate, and the click, scheduled at
 *              exact context times — which is why a slower tempo needs no time-stretching: the notes are re-timed, not the sound.
 *
 * The delay between the speaker and the microphone is the browser's own report (base, output and input latency), said to be an estimate: AnyTune has not
 * measured it on the device. Nothing captured leaves this page.
 */
import type { Playback } from '../app/practice.ts';
import { pluck } from '../synthesis/pluck.ts';

export type CaptureOutcome = 'on' | 'denied' | 'unavailable' | 'failed';

export interface PracticeAudio {
  /** the audio clock, seconds */
  now(): number;
  readonly sampleRate: number;
  startCapture(onFrames: (samples: Float32Array, captureTime: number) => void): Promise<CaptureOutcome>;
  stopCapture(): void;
  readonly playback: Playback;
  /** the round trip the browser reports, seconds */
  inputLatencySeconds(): number;
  latencyText(): string;
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
  let inputLatency = 0;
  let droppedFrames = 0;
  const sounding = new Set<AudioBufferSourceNode>();
  const noteCache = new Map<string, AudioBuffer>();
  const ctx = (): AudioContext => {
    if (context === null) context = new AudioContextClass({ latencyHint: 'interactive' });
    if (context.state === 'suspended') void context.resume();
    return context;
  };

  const play = (buffer: AudioBuffer, at: number, gain: number): void => {
    const c = ctx();
    const node = c.createBufferSource();
    node.buffer = buffer;
    const level = c.createGain();
    level.gain.value = gain;
    node.connect(level).connect(c.destination);
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
      play(buffer, at, 0.5 * (velocity / 127) + 0.2);
    },
    click(at, accent) {
      const c = ctx();
      const length = Math.round(0.03 * c.sampleRate);
      const buffer = c.createBuffer(1, length, c.sampleRate);
      const data = buffer.getChannelData(0);
      const hz = accent ? 1600 : 1000;
      for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / c.sampleRate) * (1 - i / length);
      play(buffer, at, accent ? 0.35 : 0.22);
    },
    cancelAll() {
      for (const node of sounding) node.stop();
      sounding.clear();
    },
  };

  return {
    now: () => ctx().currentTime,
    get sampleRate() {
      return ctx().sampleRate;
    },
    async startCapture(onFrames) {
      const c = ctx();
      const media = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
      if (media === undefined || typeof media.getUserMedia !== 'function' || c.audioWorklet === undefined) return 'unavailable';
      try {
        stream = await media.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (error) {
        const name = (error as { name?: string }).name;
        return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'failed';
      }
      try {
        if (!workletLoaded) {
          const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
          await c.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          workletLoaded = true;
        }
        source = c.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(c, 'anytune-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        worklet.port.onmessage = (message: MessageEvent<{ frame: number; samples: Float32Array }>) => {
          const captureTime = message.data.frame / c.sampleRate;
          if (c.currentTime - captureTime > 1) {
            droppedFrames++;
            return;
          }
          onFrames(message.data.samples, captureTime);
        };
        const silent = c.createGain();
        silent.gain.value = 0; // the worklet runs only when connected to the output: through a gain of 0, the learner never hears themselves
        source.connect(worklet).connect(silent).connect(c.destination);
        const settings = stream.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined;
        inputLatency = (c.baseLatency ?? 0) + ((c as { outputLatency?: number }).outputLatency ?? 0) + (settings?.latency ?? 0);
        return 'on';
      } catch {
        this.stopCapture();
        return 'failed';
      }
    },
    stopCapture() {
      worklet?.port.close();
      worklet?.disconnect();
      source?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      worklet = null;
      source = null;
      stream = null;
    },
    playback,
    inputLatencySeconds: () => inputLatency,
    latencyText: () => (inputLatency > 0 ? `Speaker-to-microphone delay: about ${Math.round(inputLatency * 1000)} ms, as the browser reports it (not measured on this device).` : 'The browser did not report its audio delay: timing is judged without a correction.'),
    dropped: () => droppedFrames,
  };
}
