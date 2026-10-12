/**
 * What the microphone actually delivered, on the capture clock: so that a note nobody could hear is never called a note not played.
 *
 * Every captured frame is recorded. A frame of real sound — any microphone has a noise floor far above −120 dBFS — extends the HEALTHY coverage; a frame of
 * DIGITAL SILENCE (every sample below −120 dBFS: a muted device, a driver giving zeros) does not, and neither does time with no frames at all (a GAP: the
 * page was busy, the device stalled) or the time after the device ENDED (unplugged, the permission revoked). Assessment asks `healthyBetween` for each
 * target's window and leaves a target it cannot cover UNASSESSED; the review says how much was covered, and why not the rest.
 *
 * Bounded: the coverage is a list of merged intervals (a capture without trouble is one), capped; the level meter keeps a few hundred milliseconds.
 */

/** −120 dBFS: below the noise floor of any real microphone */
export const DIGITAL_SILENCE = 1e-6;

export type CaptureProblem = 'gap' | 'digital-silence' | 'ended';

export interface CaptureSummary {
  /** frames received */
  readonly frames: number;
  /** capture-clock seconds of the first frame's start and the last frame's end; null before any */
  readonly from: number | null;
  readonly to: number | null;
  /** seconds of real sound received, and of digital silence */
  readonly soundSeconds: number;
  readonly silentSeconds: number;
  /** seconds with no frames at all, between the first and the last */
  readonly gapSeconds: number;
  /** the loudest sample, dBFS (−Infinity before any sound) */
  readonly loudestDb: number;
  /** when the device ended, if it did */
  readonly endedAt: number | null;
  /** the problems, in order: each interval and why */
  readonly problems: readonly { readonly from: number; readonly to: number; readonly why: CaptureProblem }[];
}

export const toDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY);

export class CaptureMonitor {
  readonly sampleRate: number;
  /** two frames further apart than this have a gap between them */
  readonly #tolerance: number;
  readonly #healthy: [number, number][] = [];
  readonly #problems: { from: number; to: number; why: CaptureProblem }[] = [];
  #frames = 0;
  #from: number | null = null;
  #expected: number | null = null;
  #sound = 0;
  #silent = 0;
  #gaps = 0;
  #loudest = 0;
  #endedAt: number | null = null;
  /** the recent frames' peaks, for the meter: [end time, peak] */
  readonly #recent: [number, number][] = [];
  /** the digital silence under way: since when */
  #silentSince: number | null = null;

  constructor(sampleRate: number, options: { readonly gapToleranceSeconds?: number } = {}) {
    this.sampleRate = sampleRate;
    this.#tolerance = options.gapToleranceSeconds ?? 0.03;
  }

  /** A frame captured at `time` (the capture time of its first sample). */
  push(samples: Float32Array, time: number): void {
    if (this.#endedAt !== null) return;
    const duration = samples.length / this.sampleRate;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i] as number);
      if (v > peak) peak = v;
    }
    this.#frames++;
    if (this.#from === null) this.#from = time;
    if (this.#expected !== null && time - this.#expected > this.#tolerance) {
      this.#gaps += time - this.#expected;
      this.#problem(this.#expected, time, 'gap');
    }
    this.#expected = Math.max(this.#expected ?? time, time + duration);
    if (peak < DIGITAL_SILENCE) {
      this.#silent += duration;
      this.#silentSince ??= time;
      this.#problem(time, time + duration, 'digital-silence');
    } else {
      this.#sound += duration;
      this.#silentSince = null;
      this.#cover(time, time + duration);
    }
    if (peak > this.#loudest) this.#loudest = peak;
    this.#recent.push([time + duration, peak]);
    while (this.#recent.length > 0 && (this.#recent[0] as [number, number])[0] < time + duration - 0.3) this.#recent.shift();
  }

  /** The device ended — unplugged, or the permission revoked — at `time`: nothing after it is covered. */
  ended(time: number): void {
    if (this.#endedAt !== null) return;
    this.#endedAt = time;
    this.#problem(time, Number.POSITIVE_INFINITY, 'ended');
  }

  get endedAt(): number | null {
    return this.#endedAt;
  }

  /** The loudest of the last 300 ms, dBFS — the input meter. */
  levelDb(): number {
    return toDb(this.#recent.reduce((m, [, p]) => Math.max(m, p), 0));
  }

  /** Seconds of unbroken digital silence up to the last frame (0 when the last frame had sound). */
  silentFor(): number {
    return this.#silentSince === null || this.#expected === null ? 0 : this.#expected - this.#silentSince;
  }

  /** Seconds since the last frame ended, at capture-clock `now`: frames that stop arriving altogether are a stall. */
  stalledFor(now: number): number {
    return this.#expected === null ? 0 : Math.max(0, now - this.#expected);
  }

  /** Whether real sound covered all of [from, to], give or take the tolerance. */
  healthyBetween(from: number, to: number): boolean {
    return this.#healthy.some(([a, b]) => a <= from + this.#tolerance && b >= to - this.#tolerance);
  }

  summary(): CaptureSummary {
    return {
      frames: this.#frames,
      from: this.#from,
      to: this.#expected,
      soundSeconds: this.#sound,
      silentSeconds: this.#silent,
      gapSeconds: this.#gaps,
      loudestDb: toDb(this.#loudest),
      endedAt: this.#endedAt,
      problems: this.#problems.map((p) => ({ ...p })),
    };
  }

  #cover(from: number, to: number): void {
    const last = this.#healthy[this.#healthy.length - 1];
    if (last !== undefined && from - last[1] <= this.#tolerance) last[1] = Math.max(last[1], to);
    else this.#healthy.push([from, to]);
    if (this.#healthy.length > 4096) this.#healthy.splice(0, this.#healthy.length - 4096);
  }

  #problem(from: number, to: number, why: CaptureProblem): void {
    const last = this.#problems[this.#problems.length - 1];
    if (last !== undefined && last.why === why && from - last.to <= this.#tolerance) last.to = Math.max(last.to, to);
    else this.#problems.push({ from, to, why });
    if (this.#problems.length > 1024) this.#problems.splice(0, this.#problems.length - 1024);
  }
}

/** How a capture went, in a sentence for the review — or for diagnosing a review that says nothing was heard. */
export function captureText(s: CaptureSummary, origin: number): string[] {
  if (s.frames === 0) return ['No audio arrived from the microphone.'];
  const at = (t: number): string => `${Math.max(0, t - origin).toFixed(1)} s`;
  const out = [`Audio received from ${at(s.from as number)} to ${at(s.to as number)}: ${s.soundSeconds.toFixed(1)} s of sound; loudest ${Number.isFinite(s.loudestDb) ? `${Math.round(s.loudestDb)} dBFS` : 'nothing'}.`];
  if (s.silentSeconds >= 0.1) out.push(`${s.silentSeconds.toFixed(1)} s of digital silence (the device sent zeros).`);
  if (s.gapSeconds >= 0.1) out.push(`${s.gapSeconds.toFixed(1)} s with no audio at all (capture interrupted).`);
  if (s.endedAt !== null) out.push(`The microphone stopped at ${at(s.endedAt)} (disconnected, or the permission was withdrawn).`);
  if (s.silentSeconds < 0.1 && s.gapSeconds < 0.1 && s.endedAt === null) out.push('No interruption.');
  return out;
}
