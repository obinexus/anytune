/**
 * The magnitude spectrum of a frame: a Hann window, then an iterative radix-2 FFT (Cooley–Tukey, in place). Pure; frames are a power of two long.
 */

const hannCache = new Map<number, Float64Array>();

function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (w === undefined) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/** In-place complex FFT of (re, im), length a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) throw new RangeError(`an FFT is a power of two long, not ${n}`);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = (re[b] as number) * cr - (im[b] as number) * ci;
        const ti = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** |X(k)| for k = 0 … n/2 of a Hann-windowed frame. */
export function magnitudeSpectrum(frame: Float32Array | Float64Array): Float64Array {
  const n = frame.length;
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (frame[i] as number) * (w[i] as number);
  fft(re, im);
  const mag = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k] as number, im[k] as number);
  return mag;
}

export function rms(frame: Float32Array | Float64Array): number {
  let mean = 0;
  for (const v of frame) mean += v / frame.length;
  let sum = 0;
  for (const v of frame) sum += (v - mean) ** 2;
  return Math.sqrt(sum / frame.length);
}
