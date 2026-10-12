/**
 * A plucked-string sound source: Karplus–Strong synthesis (K. Karplus, A. Strong, "Digital synthesis of plucked-string and drum timbres", Computer Music
 * Journal 7(2), 1983) with the fractional delay that tunes it to a cent, and the averaging filter's loss that makes it decay like a string. Deterministic: the
 * excitation comes from a seeded generator, so a given call always renders the same samples.
 *
 * What it is for, and what it is not: it renders a reference so that a learner can HEAR it (reference playback follows any tempo, since it is rendered from
 * notes), and it renders TEST SIGNALS for the analysis. It is not a recording of a guitar: anything measured on it is measured on synthetic strings, and says so.
 */

export interface PluckOptions {
  readonly sampleRate: number;
  /** seconds the note sounds before it is damped */
  readonly duration: number;
  /** 0…1 */
  readonly velocity: number;
  /** per-sample loss of the loop: closer to 1, longer sustain */
  readonly decay: number;
  /** the excitation's seed */
  readonly seed: number;
  /** the excitation's brightness, 0…1: a pick (bright) or a thumb (dark) */
  readonly brightness: number;
}

const DEFAULTS: PluckOptions = Object.freeze({ sampleRate: 48000, duration: 1.5, velocity: 0.8, decay: 0.996, seed: 1, brightness: 0.7 });

/** mulberry32: a small seeded generator */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One plucked string at `frequencyHz`, as samples in −1…1. */
export function pluck(frequencyHz: number, options: Partial<PluckOptions> = {}): Float32Array {
  const o = { ...DEFAULTS, ...options };
  if (!(frequencyHz > 20 && frequencyHz < o.sampleRate / 4)) throw new RangeError(`a string sounds 20 Hz … ${o.sampleRate / 4} Hz, not ${frequencyHz}`);
  const out = new Float32Array(Math.round(o.duration * o.sampleRate));
  // the loop's delay, in samples: the averaging filter adds half a sample; an allpass tunes the fraction
  const period = o.sampleRate / frequencyHz - 0.5;
  const length = Math.floor(period);
  const fraction = period - length;
  const c = (1 - fraction) / (1 + fraction);
  const line = new Float64Array(length);
  const random = seeded(o.seed);
  let smooth = 0;
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1;
    smooth = o.brightness * white + (1 - o.brightness) * smooth; // a darker pluck, low-passed
    line[i] = smooth;
  }
  let mean = 0;
  for (const v of line) mean += v / length;
  for (let i = 0; i < length; i++) line[i] = ((line[i] as number) - mean) * o.velocity;
  let index = 0;
  let previous = 0;
  let allpassIn = 0;
  let allpassOut = 0;
  for (let n = 0; n < out.length; n++) {
    const current = line[index] as number;
    const averaged = o.decay * 0.5 * (current + previous);
    previous = current;
    // first-order allpass: the fractional part of the delay
    const tuned = c * averaged + allpassIn - c * allpassOut;
    allpassIn = averaged;
    allpassOut = tuned;
    line[index] = tuned;
    index = (index + 1) % length;
    out[n] = current;
  }
  // the damping at the end: a 20 ms fade, no click
  const fade = Math.min(out.length, Math.round(0.02 * o.sampleRate));
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] = (out[out.length - 1 - i] as number) * (i / fade);
  return out;
}

/** Add `source` into `target` starting at `at` seconds, scaled by `gain`. */
export function mixInto(target: Float32Array, source: Float32Array, at: number, sampleRate: number, gain = 1): void {
  const start = Math.round(at * sampleRate);
  for (let i = 0; i < source.length && start + i < target.length; i++) {
    if (start + i >= 0) target[start + i] = (target[start + i] as number) + gain * (source[i] as number);
  }
}

export interface RenderedNote {
  /** MIDI note number */
  readonly key: number;
  readonly onsetSeconds: number;
  readonly durationSeconds: number;
  /** 1…127 */
  readonly velocity: number;
}

/** Notes rendered as plucked strings into one buffer (A4 = `referenceHz`), normalised to a peak of 0.9 when they would clip. */
export function renderNotes(notes: readonly RenderedNote[], sampleRate = 48000, referenceHz = 440, tail = 0.5): Float32Array {
  const end = notes.reduce((t, n) => Math.max(t, n.onsetSeconds + n.durationSeconds), 0) + tail;
  const out = new Float32Array(Math.ceil(end * sampleRate));
  notes.forEach((n, i) => {
    const hz = referenceHz * 2 ** ((n.key - 69) / 12);
    mixInto(out, pluck(hz, { sampleRate, duration: n.durationSeconds + 0.05, velocity: n.velocity / 127, seed: 1 + i }), n.onsetSeconds, sampleRate);
  });
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.9) for (let i = 0; i < out.length; i++) out[i] = ((out[i] as number) * 0.9) / peak;
  return out;
}
