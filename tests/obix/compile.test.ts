/**
 * Both proof paths start from the same .obix files, through the real OBIX Vue frontend (parser → canonical SFC → script setup → template with the script's
 * binding metadata → TypeScript phase):
 *
 *   EXECUTION     AnyTune .obix → OBIX Vue frontend output → demo-only "obix" → "vue" alias → official Vue runtime
 *   SEMANTICS     AnyTune .obix → OBIX Vue frontend → lowerVueToDop → canonical obix-dop-ir/3 → the trace (dist/obix-ir)
 *
 * Every component compiles for the runtime with no diagnostic, and imports from "obix" only the allowlist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compileObix, componentFiles } from '../../tools/obix/compile.ts';
import { checkObixImports } from '../../tools/obix/allowlist.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('the components of the directive, and no other: small components with one responsibility each', () => {
  assert.deepEqual(componentFiles(ROOT).map((f) => path.basename(f)), [
    'AnyTuneApp.obix',
    'ConfidenceIndicator.obix',
    'InputSelector.obix',
    'InputStatus.obix',
    'InstrumentSelector.obix',
    'NoteDisplay.obix',
    'PitchMeter.obix',
    'TunerDisplay.obix',
    'TuningStatus.obix',
  ]);
});

test('every component compiles through the OBIX Vue frontend for the Vue runtime, with no diagnostic from any stage', () => {
  for (const file of componentFiles(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    const compiled = compileObix(source, path.basename(file));
    assert.deepEqual(compiled.diagnostics, [], path.basename(file));
    assert.ok(compiled.script !== null && compiled.render !== null, path.basename(file));
    assert.deepEqual(checkObixImports(source, path.basename(file)), []);
  }
});

test('AnyTuneApp declares exactly the fields of the view as its props — the view and the UI cannot drift apart unnoticed', async () => {
  const { stagesOf } = await import('../../tools/obix/compile.ts');
  const { toView } = await import('../../src/app/view.ts');
  const { CATALOG } = await import('../../src/instruments/catalog.ts');
  const file = componentFiles(ROOT).find((f) => f.endsWith('AnyTuneApp.obix'));
  assert.ok(file);
  const bindings = stagesOf(fs.readFileSync(file, 'utf8'), 'AnyTuneApp.obix').script.artifact?.bindings ?? {};
  const props = Object.entries(bindings).filter(([, kind]) => kind === 'props').map(([name]) => name).sort();
  const view = toView({ session: 'idle', instrumentId: 'guitar-standard', reading: null, stable: false, signal: 'none', input: { state: 'idle', connected: false, confidence: 0 }, error: null, inputId: 'default', inputs: [{ id: 'default', label: 'Input' }] }, CATALOG);
  assert.deepEqual(props, Object.keys(view).sort());
});

test('the compiled script keeps the source’s "obix" imports as written — the alias is resolved when a module is loaded, never by rewriting', () => {
  const file = componentFiles(ROOT).find((f) => f.endsWith('PitchMeter.obix'));
  assert.ok(file);
  const compiled = compileObix(fs.readFileSync(file, 'utf8'), 'PitchMeter.obix');
  assert.match(compiled.script ?? '', /import \{[^}]*\bcomputed\b[^}]*\} from ["']obix["']/);
  // (the official compiler's own output imports its runtime helpers from "vue" — that is the execution path; the author's primitives stay "obix")
  assert.doesNotMatch(compiled.script ?? '', /import \{[^}]*\bcomputed\b[^}]*\} from ["']vue["']/);
});
