/**
 * Inverse-variance scalar fusion — AnyTune's MATHEMATICAL COMPATIBILITY implementation of Obicall's `obicall_static_fuse_1d` (src/core/estimator.c at
 * obicall ae5581a). This is not Obicall execution, and it does not make pitch an Obicall observation type. The cases below are Obicall's own unit tests
 * (tests/unit/test_kalman.c), restated; the native comparison is tests/integration/obicall-fusion-conformance.test.ts (A7).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseInverseVariance } from '../../src/fusion/scalar-fusion.ts';

const near = (actual: number, expected: number, tolerance: number): void => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

test("Obicall's worked example: 10.0 and 10.4 with variances 0.04 and 0.16 fuse to 10.08 with variance 0.032", () => {
  const r = fuseInverseVariance([10.0, 10.4], [0.04, 0.16]);
  assert.ok(r.ok);
  near(r.mean, 10.08, 1e-9);
  near(r.variance, 0.032, 1e-9);
});

test('one measurement is itself: the identity', () => {
  const r = fuseInverseVariance([7.5], [0.5]);
  assert.ok(r.ok);
  near(r.mean, 7.5, 1e-12);
  near(r.variance, 0.5, 1e-12);
});

test('bad input is refused as Obicall refuses it: no measurement is an invalid argument; a non-finite value or a variance ≤ 0 is a validation error', () => {
  assert.deepEqual(fuseInverseVariance([1, 2], [0.1, -1]), { ok: false, error: 'validation-non-finite' });
  assert.deepEqual(fuseInverseVariance([], []), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(fuseInverseVariance([Number.NaN], [1]), { ok: false, error: 'validation-non-finite' });
  assert.deepEqual(fuseInverseVariance([1], [0]), { ok: false, error: 'validation-non-finite' });
  assert.deepEqual(fuseInverseVariance([1], [Number.POSITIVE_INFINITY]), { ok: false, error: 'validation-non-finite' });
  assert.deepEqual(fuseInverseVariance([1, 2], [1]), { ok: false, error: 'invalid-argument' }, 'the lists must be as long as each other');
});

test('what fusion means: the fused variance is below every input variance, and the fused value lies between the inputs, nearer the surer one', () => {
  const r = fuseInverseVariance([109.2, 110.4, 110.1], [0.25, 0.04, 0.09]);
  assert.ok(r.ok);
  assert.ok(r.variance < 0.04);
  assert.ok(r.mean > 109.2 && r.mean < 110.4);
  assert.ok(Math.abs(r.mean - 110.4) < Math.abs(r.mean - 109.2));
});
