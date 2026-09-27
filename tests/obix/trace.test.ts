/**
 * The OBIX semantic proof path: every .obix component of AnyTune is lowered by the real OBIX Vue frontend and DOP lowering (`lowerVueToDop`) into the canonical
 * `obix-dop-ir/2`, and the trace — one JSON document per component under dist/obix-ir — is GENERATED from the sources, never written by hand. What the current
 * IR cannot express is a `deferred` entry with the lowering's own diagnostics, never a hidden omission.
 *
 * And the integration test the directive asks for: the runtime build and the trace come from the SAME source file of each component.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkIr, parseIr } from '@obinexusltd/obix-compiler-ir';
import { componentFiles, runtimeManifest } from '../../tools/obix/compile.ts';
import { TRACE_SCHEMA, traceComponent, writeTrace } from '../../tools/obix/trace.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

test('what the current OBIX pipeline makes of each component: what it can express lowers to IR; what calls a function is deferred, with the lowering’s own code', () => {
  const statuses = Object.fromEntries(componentFiles(ROOT).map((file) => {
    const t = traceComponent(file, ROOT);
    return [path.basename(file, '.obix'), [t.status, t.diagnostics.map((d) => d.code)]];
  }));
  assert.deepEqual(statuses, {
    // since OBIX C2 (obix-dop-ir/2) what a component tells its invoker is IR: AnyTuneApp's outputs and its interaction with InstrumentSelector,
    // InstrumentSelector's output told from its change handler
    AnyTuneApp: ['compiled', []],
    ConfidenceIndicator: ['compiled', []],
    InputSelector: ['compiled', []],
    InputStatus: ['compiled', []],
    InstrumentSelector: ['compiled', []],
    NoteDisplay: ['compiled', []],
    // since OBIX C1 the frontend resolves `ref` / `computed` from "obix": PitchMeter's `computed` now lowers as far as its `Math.round(…)` — the IR has no call
    // expressions, an honest limit of the IR, not of AnyTune; TunerDisplay's `ref` is a state and its toggle an action
    PitchMeter: ['deferred', ['OBIX_DOP_DEFERRED_EXPRESSION']],
    TunerDisplay: ['compiled', []],
    TuningStatus: ['compiled', []],
  });
});

test('a trace entry: the schema, the source path and its SHA-256, the OBIX packages that made it, and — compiled — a canonical IR the IR package accepts', () => {
  for (const file of componentFiles(ROOT)) {
    const t = traceComponent(file, ROOT);
    assert.equal(t.schema, TRACE_SCHEMA);
    assert.equal(t.source, path.relative(ROOT, file).split(path.sep).join('/'));
    assert.equal(t.sourceSha256, sha(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')));
    assert.deepEqual(Object.keys(t.pipeline).sort(), ['@obinexusltd/obix-compiler-dop', '@obinexusltd/obix-compiler-ir', '@obinexusltd/obix-compiler-parser', '@obinexusltd/obix-compiler-script-setup', '@obinexusltd/obix-compiler-template']);
    if (t.status === 'compiled') {
      assert.ok(t.ir !== null && t.provenance !== null);
      assert.deepEqual(checkIr(parseIr(JSON.stringify(t.ir))), []);
      assert.equal(t.ir.name, path.basename(file, '.obix'));
    } else {
      assert.equal(t.ir, null, 'a deferred component has no IR — never a partial one');
      assert.ok(t.diagnostics.length > 0);
    }
  }
});

test('what a compiled component is, in the IR: NoteDisplay has its props and shows them, and nothing of Vue is in it', () => {
  const file = componentFiles(ROOT).find((f) => f.endsWith('NoteDisplay.obix'));
  assert.ok(file);
  const t = traceComponent(file, ROOT);
  assert.ok(t.ir);
  assert.deepEqual(t.ir.props.map((p: { name: string; type: string }) => [p.name, p.type]), [['note', 'string'], ['octaveText', 'string'], ['frequencyText', 'string']]);
  assert.doesNotMatch(JSON.stringify(t.ir), /v-if|v-for|v-bind|__vue|createVNode/);
});

test('the trace is deterministic: written twice, the same bytes; one file per component, named after it', () => {
  const a = path.join(ROOT, '.obix-tmp', 'trace-a');
  const b = path.join(ROOT, '.obix-tmp', 'trace-b');
  for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
  writeTrace(ROOT, a);
  writeTrace(ROOT, b);
  const files = fs.readdirSync(a).sort();
  assert.deepEqual(files, [...componentFiles(ROOT).map((f) => `${path.basename(f)}.json`), 'index.json'].sort());
  for (const f of files) assert.equal(fs.readFileSync(path.join(a, f), 'utf8'), fs.readFileSync(path.join(b, f), 'utf8'), f);
});

test('the two proof paths originate from the same source file: the runtime build and the IR trace each record the path and hash of every component, and they agree with the file on disk', () => {
  const runtime = runtimeManifest(ROOT);
  for (const file of componentFiles(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const onDisk = sha(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    const built = runtime.find((entry) => entry.source === rel);
    assert.ok(built, `${rel} is not in the runtime build`);
    assert.equal(built.sourceSha256, onDisk, `${rel}: runtime build`);
    assert.equal(traceComponent(file, ROOT).sourceSha256, onDisk, `${rel}: trace`);
  }
  // and no second, hand-kept source of a component exists anywhere: one .obix per component name
  assert.equal(new Set(componentFiles(ROOT).map((f) => path.basename(f))).size, componentFiles(ROOT).length);
});
