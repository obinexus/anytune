/**
 * The pitch detector: a frame of audio samples and its sample rate in, the fundamental frequency and how sure the detector is of it out — or null when there
 * is no pitch to speak of. PURE: no browser, no audio API, no state between frames. The microphone provider (microphone-provider.ts) feeds it frames; the
 * tests feed it signals generated from their mathematics (tests/audio/pitch-detector.test.ts).
 *
 * The algorithm is YIN (A. de Cheveigné and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music", JASA 111(4), 2002), monophonic and
 * instrument-neutral:
 *
 *   1. the difference function      d(τ) = Σ_{j<W} (x_j − x_{j+τ})²,   W = half the frame, the frame's mean removed first
 *   2. its cumulative-mean normalization   d′(0) = 1,   d′(τ) = d(τ) · τ / Σ_{k=1..τ} d(k)   — which removes the bias towards τ = 0, and with it most octave errors
 *   3. the absolute threshold: the first τ ≥ τmin with d′(τ) < `threshold`, then on down to the bottom of that dip; when no τ goes below the threshold, the
 *      smallest d′ — a pitch the detector is unsure of, and says so in its confidence
 *   4. parabolic interpolation of d around that τ: the period to a fraction of a sample, which is what makes cents out of samples
 *   5. frequency = sampleRate / period
 *
 * What it looks for, and how it decides:
 *
 *   frequency range   `minFrequencyHz` 40 Hz (below the bass's E1, 41.2 Hz) … `maxFrequencyHz` 2000 Hz (above the flute's and the violin's range for tuning)
 *   frame size        DETECTOR_FRAME_SIZE = 4096 samples: 85 ms at 48 kHz, 93 ms at 44.1 kHz — half of it must hold the longest period, 48000 / 40 = 1200 samples
 *   confidence        1 − d′ at the period chosen, clamped to 0…1: 1 for a perfectly periodic frame; noise gives no deep dip, and a low confidence, which the
 *                     domain reads as "uncertain" (below 0.6) whatever the frequency
 *   silence           a frame whose RMS, its mean removed, is below `silenceRms` 0.004 (−48 dBFS) is no pitch at all: null
 *   interpolation     parabolic, on d(τ) at the chosen τ and its two neighbours
 *
 * Accuracy, on clean tones of the guitar's open strings and A4 at 44.1 and 48 kHz: within ±1 cent (tests) — a fifth of the domain's ±5-cent in-tune window.
 */

export interface PitchDetection {
  readonly frequencyHz: number;
  /** 0…1: how periodic the frame is at that frequency — 1 − YIN's aperiodicity */
  readonly confidence: number;
}

export interface PitchDetector {
  detect(samples: Float32Array, sampleRate: number): PitchDetection | null;
}

export interface DetectorOptions {
  readonly minFrequencyHz: number;
  readonly maxFrequencyHz: number;
  /** YIN's absolute threshold on d′ */
  readonly threshold: number;
  /** below this RMS (samples in −1…1) a frame is silence */
  readonly silenceRms: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = Object.freeze({ minFrequencyHz: 40, maxFrequencyHz: 2000, threshold: 0.1, silenceRms: 0.004 });

/** The frame the detector is meant for: a power of two whose half holds the longest period it looks for, at the usual sample rates. */
export const DETECTOR_FRAME_SIZE = 4096;

export function createYinDetector(options: Partial<DetectorOptions> = {}): PitchDetector {
  const { minFrequencyHz, maxFrequencyHz, threshold, silenceRms } = { ...DEFAULT_DETECTOR_OPTIONS, ...options };
  return {
    detect(samples: Float32Array, sampleRate: number): PitchDetection | null {
      const n = samples.length;
      const window = Math.floor(n / 2);
      const tauMin = Math.max(2, Math.floor(sampleRate / maxFrequencyHz));
      const tauMax = Math.min(window - 1, Math.ceil(sampleRate / minFrequencyHz));
      if (!(sampleRate > 0) || tauMax <= tauMin + 1) return null;

      // the mean removed; silence is decided on what is left
      let mean = 0;
      for (let i = 0; i < n; i++) mean += samples[i] as number;
      mean /= n;
      const x = new Float64Array(n);
      let energy = 0;
      for (let i = 0; i < n; i++) {
        const v = (samples[i] as number) - mean;
        x[i] = v;
        energy += v * v;
      }
      if (!(Math.sqrt(energy / n) >= silenceRms)) return null;

      // 1. the difference function, 2. its cumulative-mean normalization
      const d = new Float64Array(tauMax + 2);
      const normalized = new Float64Array(tauMax + 2);
      normalized[0] = 1;
      let running = 0;
      for (let tau = 1; tau <= tauMax + 1 && tau < n - window; tau++) {
        let sum = 0;
        for (let j = 0; j < window; j++) {
          const delta = (x[j] as number) - (x[j + tau] as number);
          sum += delta * delta;
        }
        d[tau] = sum;
        running += sum;
        normalized[tau] = running === 0 ? 1 : (sum * tau) / running;
      }

      // 3. the first dip below the threshold, to its bottom — or the deepest dip when none goes below it
      let best = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if ((normalized[tau] as number) < threshold) {
          while (tau + 1 <= tauMax && (normalized[tau + 1] as number) < (normalized[tau] as number)) tau++;
          best = tau;
          break;
        }
      }
      if (best === -1) {
        best = tauMin;
        for (let tau = tauMin + 1; tau <= tauMax; tau++) if ((normalized[tau] as number) < (normalized[best] as number)) best = tau;
      }

      // 4. parabolic interpolation of d around the period
      let period = best;
      if (best > 1 && best + 1 < d.length) {
        const a = d[best - 1] as number;
        const b = d[best] as number;
        const c = d[best + 1] as number;
        const curvature = a - 2 * b + c;
        if (curvature > 0) period = best + Math.max(-1, Math.min(1, (0.5 * (a - c)) / curvature));
      }

      // 5. the frequency, inside the range looked for
      const frequencyHz = sampleRate / period;
      if (!(frequencyHz >= minFrequencyHz && frequencyHz <= maxFrequencyHz)) return null;
      const confidence = Math.max(0, Math.min(1, 1 - (normalized[best] as number)));
      return { frequencyHz, confidence };
    },
  };
}
