/**
 * Inverse-variance fusion of independent scalar estimates: each estimate weighs 1/variance; the fused value is Σ(mean/variance) / Σ(1/variance) and the fused
 * variance 1 / Σ(1/variance). The sums accumulate first to last, so a given list always gives the same doubles. No measurement is an invalid argument; a
 * non-finite value, or a variance that is not positive, is refused — never fused. Pure, and AnyTune's own (tests/fusion/scalar-fusion.test.ts).
 */

export type FuseResult = { readonly ok: true; readonly mean: number; readonly variance: number } | { readonly ok: false; readonly error: 'invalid-argument' | 'validation-non-finite' };

export function fuseInverseVariance(means: readonly number[], variances: readonly number[]): FuseResult {
  // no measurement, or lists that do not pair up: an invalid argument
  if (means.length === 0 || means.length !== variances.length) return { ok: false, error: 'invalid-argument' };
  let sumInvVar = 0;
  let sumMeanOverVar = 0;
  for (let i = 0; i < means.length; i++) {
    const mean = means[i] as number;
    const variance = variances[i] as number;
    // a value that is not finite, or a variance that is not positive, cannot be weighed
    if (!Number.isFinite(mean) || !Number.isFinite(variance) || variance <= 0) return { ok: false, error: 'validation-non-finite' };
    const w = 1 / variance;
    sumInvVar += w;
    sumMeanOverVar += mean * w;
  }
  return { ok: true, mean: sumMeanOverVar / sumInvVar, variance: 1 / sumInvVar };
}
