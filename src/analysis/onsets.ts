/**
 * Onsets — the moments a string is struck or plucked — by spectral flux: the summed rise of the log-magnitude spectrum from one hop to the next, against an
 * adaptive threshold (a multiple of the recent median, plus a floor), peak-picked, with a minimum gap between onsets. Streaming: frames are pushed as they
 * are captured; an onset is reported one hop after its peak (when the peak is known to be one).
 *
 * A strum is one onset: a later string of a slow strum (within `maskSeconds` of an onset, and much weaker — under `maskRatio` of its strength) is masked
 * by the strum it belongs to, while successive melody notes, each struck as hard as the last, stay separate.
 *
 * An onset says THAT something was struck and when, with a strength — not which string, and not whether the strum went down or up: onset detection cannot
 * tell strum direction, and AnyTune never claims it.
 */
import { magnitudeSpectrum, rms } from './spectrum.ts';

export interface OnsetOptions {
  readonly sampleRate: number;
  /** analysis frame, samples (power of two) */
  readonly frameSize: number;
  /** samples between frames */
  readonly hopSize: number;
  /** the flux must exceed this multiple of the recent median… */
  readonly sensitivity: number;
  /** …and this floor (in summed log-magnitude units, per bin) */
  readonly floor: number;
  /** two onsets are at least this far apart */
  readonly minGapSeconds: number;
  /** frames quieter than this RMS have no onset */
  readonly silenceRms: number;
  /** an onset this close after another… */
  readonly maskSeconds: number;
  /** …and weaker than this share of its strength is part of it */
  readonly maskRatio: number;
}

export const DEFAULT_ONSET_OPTIONS: Omit<OnsetOptions, 'sampleRate'> = Object.freeze({ frameSize: 1024, hopSize: 256, sensitivity: 2.5, floor: 0.08, minGapSeconds: 0.06, silenceRms: 0.002, maskSeconds: 0.15, maskRatio: 0.35 });

export interface Onset {
  /** seconds, on the clock of the samples pushed (the start of the first pushed sample is 0) */
  readonly time: number;
  readonly strength: number;
}

export class OnsetDetector {
  readonly #o: OnsetOptions;
  #buffer: Float32Array;
  #filled = 0;
  #consumed = 0; // samples consumed into hops so far
  #previous: Float64Array | null = null;
  readonly #history: number[] = [];
  /** the last two flux values and the frame time of the middle one */
  #window: { flux: number; time: number }[] = [];
  #lastOnset = Number.NEGATIVE_INFINITY;
  #lastStrength = 0;

  constructor(options: Partial<OnsetOptions> & Pick<OnsetOptions, 'sampleRate'>) {
    this.#o = { ...DEFAULT_ONSET_OPTIONS, ...options };
    this.#buffer = new Float32Array(this.#o.frameSize);
  }

  /** Push captured samples; returns the onsets they complete, in order. */
  push(samples: Float32Array): Onset[] {
    const out: Onset[] = [];
    const { frameSize, hopSize } = this.#o;
    for (let at = 0; at < samples.length; ) {
      const take = Math.min(frameSize - this.#filled, samples.length - at);
      this.#buffer.set(samples.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === frameSize) {
        const onset = this.#frame(this.#buffer, (this.#consumed + frameSize / 2) / this.#o.sampleRate);
        if (onset !== null) out.push(onset);
        this.#buffer.copyWithin(0, hopSize);
        this.#filled = frameSize - hopSize;
        this.#consumed += hopSize;
      }
    }
    return out;
  }

  #frame(frame: Float32Array, time: number): Onset | null {
    const quiet = rms(frame) < this.#o.silenceRms;
    const mag = magnitudeSpectrum(frame);
    const log = mag.map((m) => Math.log1p(100 * m));
    let flux = 0;
    if (this.#previous !== null && !quiet) for (let k = 1; k < log.length; k++) flux += Math.max(0, (log[k] as number) - (this.#previous[k] as number));
    flux /= log.length;
    this.#previous = log;
    this.#window.push({ flux, time });
    if (this.#window.length > 3) this.#window.shift();
    const sorted = [...this.#history].sort((a, b) => a - b);
    const median = sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] as number);
    this.#history.push(flux);
    if (this.#history.length > 43) this.#history.shift(); // ~230 ms of hops at 48 kHz
    if (this.#window.length < 3) return null;
    const [before, peak, after] = this.#window as [{ flux: number }, { flux: number; time: number }, { flux: number }];
    const threshold = Math.max(this.#o.floor, this.#o.sensitivity * median);
    if (peak.flux > threshold && peak.flux >= before.flux && peak.flux > after.flux && peak.time - this.#lastOnset >= this.#o.minGapSeconds) {
      if (peak.time - this.#lastOnset < this.#o.maskSeconds && peak.flux < this.#o.maskRatio * this.#lastStrength) return null;
      this.#lastOnset = peak.time;
      this.#lastStrength = peak.flux;
      return { time: peak.time, strength: peak.flux };
    }
    return null;
  }
}

/** Every onset of a whole signal. */
export function detectOnsets(samples: Float32Array, sampleRate: number, options: Partial<OnsetOptions> = {}): Onset[] {
  return new OnsetDetector({ ...options, sampleRate }).push(samples);
}

/**
 * Strums, for chord practice: onsets within `windowSeconds` of a strum's first onset are its later strings, however hard they were struck — a slow strum can
 * spread over 100 ms. Melody practice does not group (successive notes can be closer than that), and keeps every onset.
 */
export function groupStrums(onsets: readonly Onset[], windowSeconds = 0.15): Onset[] {
  const strums: Onset[] = [];
  for (const onset of onsets) {
    const last = strums[strums.length - 1];
    if (last !== undefined && onset.time - last.time < windowSeconds) {
      if (onset.strength > last.strength) strums[strums.length - 1] = { time: last.time, strength: onset.strength };
    } else strums.push(onset);
  }
  return strums;
}
