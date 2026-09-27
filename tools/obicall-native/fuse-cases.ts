/**
 * The cases of the scalar-fusion conformance (A8), the same for AnyTune and for Obicall's native obicall_static_fuse_1d: named cases — Obicall's worked
 * example, the identity, several measurements, every refusal, the extremes, the order of accumulation — and a seeded set of generated ones. Deterministic:
 * the same list every time, so that the native answers recorded once (tests/fixtures/obicall/fuse-oracle.json) stay the answers to these cases.
 *
 * These are numbers. The conformance is of the MATHEMATICS — AnyTune's fusion equals Obicall's — and says nothing of Obicall carrying a frequency: it does not.
 */

export interface FuseCase {
  readonly name: string;
  readonly means: readonly number[];
  readonly variances: readonly number[];
}

/** mulberry32: a small seeded generator, so that the generated cases never change */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const permutations = <T>(items: readonly T[]): T[][] => (items.length <= 1 ? [[...items]] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));

export function fuseCases(): FuseCase[] {
  const cases: FuseCase[] = [
    { name: 'worked example (Obicall docs/VALIDATION.md): 10.0 and 10.4, variances 0.04 and 0.16', means: [10.0, 10.4], variances: [0.04, 0.16] },
    { name: 'identity: one measurement', means: [110.0], variances: [0.25] },
    { name: 'identity: one measurement, a tiny variance', means: [82.40688922821748], variances: [1e-12] },
    { name: 'two equal measurements', means: [440, 440], variances: [1, 1] },
    { name: 'three measurements', means: [108, 109, 110], variances: [0.5, 0.25, 1] },
    { name: 'five measurements', means: [110.2, 109.8, 110.05, 110.4, 109.9], variances: [0.3, 0.2, 0.05, 1.5, 0.8] },
    { name: 'refused: no measurement', means: [], variances: [] },
    { name: 'refused: a variance of zero', means: [10, 11], variances: [0.1, 0] },
    { name: 'refused: a negative variance', means: [10], variances: [-0.1] },
    { name: 'refused: a negative zero variance', means: [10], variances: [-0] },
    { name: 'refused: a NaN measurement', means: [Number.NaN], variances: [1] },
    { name: 'refused: an infinite measurement', means: [10, Number.POSITIVE_INFINITY], variances: [1, 1] },
    { name: 'refused: a negative infinite measurement', means: [Number.NEGATIVE_INFINITY], variances: [1] },
    { name: 'refused: a NaN variance', means: [10], variances: [Number.NaN] },
    { name: 'refused: an infinite variance', means: [10, 11], variances: [1, Number.POSITIVE_INFINITY] },
    { name: 'refused after a good one: the check is of every measurement', means: [10, 11, 12], variances: [1, 1, -1] },
    { name: 'extreme: a subnormal variance', means: [1, 2], variances: [5e-324, 1] },
    { name: 'extreme: the sums overflow', means: [1e300, 1e300], variances: [1e-300, 1e-300] },
    { name: 'extreme: huge variances', means: [3, 4], variances: [1e300, 1e308] },
    { name: 'extreme: signed zeros', means: [-0, 0], variances: [1, 1] },
  ];
  // the order of accumulation: Obicall sums from the first measurement to the last, and floating point is not associative — each order is a case of its own
  for (const [i, order] of permutations([0, 1, 2]).entries()) {
    const means = [1e16, 1, -1e16];
    cases.push({ name: `order ${i}: 1e16, 1, -1e16 summed as ${order.join('')}`, means: order.map((k) => means[k] as number), variances: [1, 1, 1] });
  }
  for (const [i, order] of permutations([0, 1, 2, 3]).entries()) {
    const means = [110.1, 109.7, 110.3, 109.95];
    const variances = [0.3, 0.7, 0.11, 0.05];
    cases.push({ name: `order ${i}: four readings summed as ${order.join('')}`, means: order.map((k) => means[k] as number), variances: order.map((k) => variances[k] as number) });
  }
  const random = generator(0xa7a8);
  for (let i = 0; i < 2000; i++) {
    const count = 1 + Math.floor(random() * 8);
    const scale = 10 ** Math.floor(random() * 10 - 3);
    const means = Array.from({ length: count }, () => (random() * 2 - 1) * scale + (random() < 0.5 ? 0 : 440));
    const variances = Array.from({ length: count }, () => 10 ** (random() * 12 - 8));
    cases.push({ name: `generated ${i}`, means, variances });
  }
  return cases;
}

/** A double as the 16 hex digits of its IEEE-754 bits — how the cases cross to the native harness, with no decimal rounding between. */
export function bitsOf(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
