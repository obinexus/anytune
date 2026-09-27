/**
 * A8 — AnyTune's inverse-variance fusion (src/fusion/scalar-fusion.ts) is Obicall's: for every case of tools/obicall-native/fuse-cases.ts it gives, BIT FOR
 * BIT, what the native obicall_static_fuse_1d of the staged obicall.dll gave (tests/fixtures/obicall/fuse-oracle.json, recorded through
 * tools/obicall-native/fuse-harness.c) — the same values, the same refusals, in the same order of accumulation. When the harness is built (.native/), the
 * last test asks the DLL again.
 *
 * What this proves: AnyTune's fusion mathematics equals Obicall's scalar-fusion mathematics. What it does not: that Obicall carries a frequency — it has
 * no unit for one (docs/OBICALL.md). The browser never loads the DLL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fuseInverseVariance } from '../../src/fusion/scalar-fusion.ts';
import type { FuseResult } from '../../src/fusion/scalar-fusion.ts';
import { bitsOf, fuseCases } from '../../tools/obicall-native/fuse-cases.ts';
import { askNative } from '../../tools/obicall-native/record-oracle.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
type Answer = [string, string | null, string | null];
const ORACLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'obicall', 'fuse-oracle.json'), 'utf8')) as { cases: { name: string; means: string[]; variances: string[]; native: Answer }[] };
const CASES = fuseCases();

/** An AnyTune result in the harness's words: Obicall's status string, and the bits of what it wrote. */
const said = (result: FuseResult): Answer => (result.ok ? ['ok', bitsOf(result.mean), bitsOf(result.variance)] : [result.error === 'invalid-argument' ? 'invalid argument' : 'non-finite value', null, null]);
const nativeOf = (name: string): Answer => {
  const found = ORACLE.cases.find((c) => c.name === name);
  assert.ok(found, name);
  return found.native;
};

test('the oracle answers these very cases: the same names, the same inputs, bit for bit', () => {
  assert.equal(ORACLE.cases.length, CASES.length);
  CASES.forEach((c, i) => assert.deepEqual([ORACLE.cases[i]?.name, ORACLE.cases[i]?.means, ORACLE.cases[i]?.variances], [c.name, c.means.map(bitsOf), c.variances.map(bitsOf)]));
});

test('Obicall’s worked example, natively: 10.0 and 10.4 with variances 0.04 and 0.16 fuse to 10.08 with variance 0.032 — and AnyTune gives the same bits', () => {
  const native = nativeOf(CASES[0]?.name as string);
  assert.deepEqual(native, ['ok', bitsOf(10.08), bitsOf(0.032)]);
  assert.deepEqual(said(fuseInverseVariance([10.0, 10.4], [0.04, 0.16])), native);
});

test('the identity, several measurements, every refusal and the extremes: AnyTune answers what Obicall answers, bit for bit', () => {
  for (const c of CASES.filter((x) => !x.name.startsWith('generated') && !x.name.startsWith('order'))) assert.deepEqual(said(fuseInverseVariance(c.means, c.variances)), nativeOf(c.name), c.name);
  // what the native side refused, and how
  assert.deepEqual(nativeOf('refused: no measurement'), ['invalid argument', null, null]);
  for (const name of ['refused: a variance of zero', 'refused: a negative zero variance', 'refused: a NaN measurement', 'refused: an infinite variance', 'refused after a good one: the check is of every measurement']) {
    assert.deepEqual(nativeOf(name), ['non-finite value', null, null], name);
  }
  assert.deepEqual(nativeOf('identity: one measurement'), ['ok', bitsOf(110), bitsOf(0.25)]);
});

test('the order of accumulation is Obicall’s — first to last: where the order changes the bits, AnyTune changes them the same way', () => {
  const orders = CASES.filter((c) => c.name.startsWith('order'));
  for (const c of orders) assert.deepEqual(said(fuseInverseVariance(c.means, c.variances)), nativeOf(c.name), c.name);
  // the order matters at all: 1e16, 1, -1e16 fuse to different means in different orders — natively, and in AnyTune alike
  const means = new Set(orders.filter((c) => c.name.includes('1e16')).map((c) => nativeOf(c.name)[1]));
  assert.ok(means.size > 1, 'the native answers differ with the order');
});

test('2 000 generated cases — 1 to 8 measurements, magnitudes from 0.001 to 10⁶, variances from 10⁻⁸ to 10⁴: every answer equal, bit for bit', () => {
  const generated = CASES.filter((c) => c.name.startsWith('generated'));
  assert.equal(generated.length, 2000);
  let ok = 0;
  for (const c of generated) {
    const native = nativeOf(c.name);
    assert.deepEqual(said(fuseInverseVariance(c.means, c.variances)), native, c.name);
    if (native[0] === 'ok') ok++;
  }
  assert.equal(ok, 2000, 'every generated case is one the native side fuses');
});

test('the comparison can fail: a fusion that sums from the last measurement to the first disagrees with Obicall where the order matters', () => {
  const reversed = (means: readonly number[], variances: readonly number[]): FuseResult => fuseInverseVariance([...means].reverse(), [...variances].reverse());
  const differs = CASES.filter((c) => c.name.startsWith('order')).filter((c) => JSON.stringify(said(reversed(c.means, c.variances))) !== JSON.stringify(nativeOf(c.name)));
  assert.ok(differs.length > 0);
});

test('the live oracle: the staged obicall.dll, asked again through the harness, answers what the committed oracle says it answered', (t) => {
  const harness = process.env.OBICALL_FUSE_HARNESS ?? path.join(ROOT, '.native', 'fuse-harness.exe');
  if (!fs.existsSync(harness)) {
    t.skip(`the native harness is not built at ${harness} (tools/obicall-native/build.sh): the committed oracle stands`);
    return;
  }
  const answers = askNative(harness);
  assert.equal(answers.length, ORACLE.cases.length);
  answers.forEach((answer, i) => assert.deepEqual(answer, ORACLE.cases[i]?.native, ORACLE.cases[i]?.name));
});
