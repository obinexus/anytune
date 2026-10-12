/**
 * Inverse-variance scalar fusion (src/fusion/scalar-fusion.ts), against its definition: Σ(mean/variance) / Σ(1/variance), variance 1 / Σ(1/variance),
 * accumulated first to last; bad input refused, never fused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseInverseVariance } from '../../src/fusion/scalar-fusion.ts';

const near = (actual: number, expected: number, tolerance: number): void => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

test('a worked example: 10.0 and 10.4 with variances 0.04 and 0.16 fuse to 10.08 with variance 0.032', () => {
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

test('bad input is refused: no measurement is an invalid argument; a non-finite value or a variance ≤ 0 is a validation error', () => {
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

test('the sums accumulate first to last: the result is exactly the definition computed in the order given — where the order changes the bits, so does the result', () => {
  const definition = (means: number[], variances: number[]): [number, number] => {
    let w = 0;
    let wm = 0;
    for (let i = 0; i < means.length; i++) {
      w += 1 / (variances[i] as number);
      wm += (means[i] as number) * (1 / (variances[i] as number));
    }
    return [wm / w, 1 / w];
  };
  const orders: [number[], number[]][] = [
    [[1e16, 1, -1e16], [1, 1, 1]],
    [[1, 1e16, -1e16], [1, 1, 1]],
    [[-1e16, 1e16, 1], [1, 1, 1]],
  ];
  const means = new Set<number>();
  for (const [m, v] of orders) {
    const r = fuseInverseVariance(m, v);
    assert.ok(r.ok);
    assert.deepEqual([r.mean, r.variance], definition(m, v));
    means.add(r.mean);
  }
  assert.ok(means.size > 1, 'the order of accumulation is visible in the bits');
});
