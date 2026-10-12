/**
 * Chord CANDIDATES from sound: a chroma vector (the spectrum's energy folded onto the twelve pitch classes) compared with the templates of a DECLARED
 * vocabulary — by default the MVP's eight open chords, nothing else — and turned into a ranked list with a confidence. What this can say is the chord's
 * IDENTITY, uncertainly: not its voicing, not its octave, not which strings were played, not the strum's direction.
 *
 *   chroma      a Hann-windowed frame (8192 samples: 170 ms at 48 kHz, enough to separate the low strings' semitones), each bin from 70 Hz to 2.1 kHz
 *               given to its nearest pitch class with a cos² weight on its distance from the semitone; log-compressed; normalised
 *   templates   each chord tone with its harmonics 1–4 (weights 1, 0.6, 0.4, 0.3) — a string's third harmonic sounds its fifth above, so C's template
 *               carries some G, E's some B, G's some D — normalised
 *   scores      cosine similarity of the chroma and each template
 *   confidence  the softmax probability of the best (temperature 0.03): high when one chord stands clear of the rest, low for noise, a single note, or a
 *               sound between two chords. Below the caller's threshold the result is "uncertain" — never a guess.
 */
import { MVP_CHORDS, parseChord, type ChordIdentity } from '../music/chords.ts';
import { magnitudeSpectrum, rms } from './spectrum.ts';

export interface ChromaOptions {
  readonly referenceHz: number;
  readonly minHz: number;
  readonly maxHz: number;
}

export const DEFAULT_CHROMA: ChromaOptions = Object.freeze({ referenceHz: 440, minHz: 70, maxHz: 2100 });
export const CHORD_FRAME_SIZE = 8192;

export function chroma(frame: Float32Array, sampleRate: number, options: ChromaOptions = DEFAULT_CHROMA): Float64Array {
  const mag = magnitudeSpectrum(frame);
  const n = frame.length;
  const out = new Float64Array(12);
  const lo = Math.max(1, Math.floor((options.minHz * n) / sampleRate));
  const hi = Math.min(mag.length - 2, Math.ceil((options.maxHz * n) / sampleRate));
  let max = 0;
  for (let k = lo; k <= hi; k++) max = Math.max(max, mag[k] as number);
  // only the spectrum's PEAKS within 40 dB of the strongest count: every bin of a frame counted alike would let the window's leakage and the noise floor —
  // spread over many more bins at high frequencies than at low — flatten the chroma until no chord stands out
  const floor = max * 0.01;
  for (let k = lo; k <= hi; k++) {
    const m = mag[k] as number;
    if (m < floor || m < (mag[k - 1] as number) || m <= (mag[k + 1] as number)) continue;
    // the peak's true frequency, by a parabola through the log magnitudes of it and its neighbours
    const a = Math.log(mag[k - 1] as number);
    const b = Math.log(m);
    const c = Math.log(mag[k + 1] as number);
    const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
    const hz = ((k + shift) * sampleRate) / n;
    const midi = 69 + 12 * Math.log2(hz / options.referenceHz);
    const nearest = Math.round(midi);
    const pc = ((nearest % 12) + 12) % 12;
    out[pc] = (out[pc] as number) + Math.sqrt(m) * Math.cos(Math.PI * (midi - nearest)) ** 2;
  }
  return normalise(out);
}

function normalise(v: Float64Array): Float64Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

const HARMONICS: readonly [number, number][] = [[0, 1], [12, 0.6], [19, 0.4], [24, 0.3]]; // semitones above the tone, weight

export function harmonicTemplate(chord: ChordIdentity): Float64Array {
  const t = new Float64Array(12);
  for (const pc of chord.pitchClasses) for (const [semitones, weight] of HARMONICS) t[(pc + semitones) % 12] = (t[(pc + semitones) % 12] as number) + weight;
  return normalise(t);
}

export interface ChordCandidate {
  readonly symbol: string;
  /** cosine similarity, 0…1 */
  readonly score: number;
}

export interface ChordFit {
  /** the weakest of the best candidate's three tones, as a fraction of the strongest pitch class: low for a single note, a power chord, a sus chord */
  readonly coverage: number;
  /** the share of the chroma's energy outside the best candidate's tones and their harmonics 1–6: high for noise and for chords outside the vocabulary */
  readonly outside: number;
  /** coverage ≥ 0.45 and outside ≤ 0.15 */
  readonly accepted: boolean;
}

export interface ChordReading {
  /** best first */
  readonly candidates: readonly ChordCandidate[];
  /** the softmax probability of the best candidate — 0 when the fit refuses it: a closed vocabulary always has a nearest chord, which may be no chord at all */
  readonly confidence: number;
  readonly fit: ChordFit;
}

/** The open-set gate's thresholds, calibrated on synthetic strums and refusals (docs/evaluation/guitar-synthetic.md): every vocabulary chord's tones present,
 * and little energy where none of its tones or their harmonics sound. */
export const FIT_THRESHOLDS = Object.freeze({ minCoverage: 0.45, maxOutside: 0.15 });

export function fitOf(c: Float64Array, chord: ChordIdentity): ChordFit {
  const max = Math.max(...c);
  const coverage = max > 0 ? Math.min(...chord.pitchClasses.map((pc) => (c[pc] as number) / max)) : 0;
  const support = new Set<number>();
  for (const pc of chord.pitchClasses) for (const h of [0, 12, 19, 24, 28, 31]) support.add((pc + h) % 12);
  let all = 0;
  let out = 0;
  for (let i = 0; i < 12; i++) {
    all += (c[i] as number) ** 2;
    if (!support.has(i)) out += (c[i] as number) ** 2;
  }
  const outside = all > 0 ? out / all : 1;
  return { coverage, outside, accepted: coverage >= FIT_THRESHOLDS.minCoverage && outside <= FIT_THRESHOLDS.maxOutside };
}

export interface ChordAnalyser {
  /** null for silence; otherwise the candidates of the declared vocabulary */
  read(frame: Float32Array, sampleRate: number): ChordReading | null;
  readonly vocabulary: readonly string[];
}

export function createChordAnalyser(vocabulary: readonly string[] = MVP_CHORDS, options: { readonly temperature?: number; readonly silenceRms?: number; readonly chroma?: ChromaOptions } = {}): ChordAnalyser {
  const chords = vocabulary.map((symbol) => {
    const chord = parseChord(symbol);
    if (chord === null) throw new RangeError(`${symbol} is not a chord AnyTune can template`);
    return { symbol, chord, template: harmonicTemplate(chord) };
  });
  const temperature = options.temperature ?? 0.03;
  const silence = options.silenceRms ?? 0.003;
  return {
    vocabulary,
    read(frame, sampleRate) {
      if (rms(frame) < silence) return null;
      const c = chroma(frame, sampleRate, options.chroma ?? DEFAULT_CHROMA);
      const scored = chords.map(({ symbol, template }) => {
        let dot = 0;
        for (let i = 0; i < 12; i++) dot += (c[i] as number) * (template[i] as number);
        return { symbol, score: dot };
      });
      scored.sort((a, b) => b.score - a.score);
      const top = (scored[0] as ChordCandidate).score;
      const total = scored.reduce((s, x) => s + Math.exp((x.score - top) / temperature), 0);
      const best = chords.find((x) => x.symbol === (scored[0] as ChordCandidate).symbol) as (typeof chords)[number];
      const fit = fitOf(c, best.chord);
      return { candidates: scored, confidence: fit.accepted ? 1 / total : 0, fit };
    },
  };
}
