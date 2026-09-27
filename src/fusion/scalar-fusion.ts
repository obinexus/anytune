/**
 * Inverse-variance fusion of independent scalar estimates — a MATHEMATICAL COMPATIBILITY implementation of Obicall's `obicall_static_fuse_1d`
 * (src/core/estimator.c, obicall ae5581a): the same rule, the same checks in the same order, the same order of operations, so that it gives the same doubles.
 * It is not Obicall execution, and it does not make pitch an Obicall observation type (docs/OBICALL.md). The native comparison: A7.
 */

export type FuseResult = { readonly ok: true; readonly mean: number; readonly variance: number } | { readonly ok: false; readonly error: 'invalid-argument' | 'validation-non-finite' };

export function fuseInverseVariance(means: readonly number[], variances: readonly number[]): FuseResult {
  // obicall: count == 0 -> OBICALL_ERR_INVALID_ARGUMENT (a C caller passes one count for both arrays; here two lists must agree)
  if (means.length === 0 || means.length !== variances.length) return { ok: false, error: 'invalid-argument' };
  let sumInvVar = 0;
  let sumMeanOverVar = 0;
  for (let i = 0; i < means.length; i++) {
    const mean = means[i] as number;
    const variance = variances[i] as number;
    // obicall: !isfinite(mean) || !isfinite(variance) || variance <= 0 -> OBICALL_ERR_VALIDATION_NON_FINITE
    if (!Number.isFinite(mean) || !Number.isFinite(variance) || variance <= 0) return { ok: false, error: 'validation-non-finite' };
    const w = 1 / variance;
    sumInvVar += w;
    sumMeanOverVar += mean * w;
  }
  return { ok: true, mean: sumMeanOverVar / sumInvVar, variance: 1 / sumInvVar };
}
