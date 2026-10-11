/**
 * AnyTune's own sources keep the layers of architecture.json — the separations the directive requires, each named:
 *
 *   domain/      ✗→ Vue, the DOM                   fusion/  ✗→ the DOM
 *   components/  ✗→ providers, fusion                the format adapters ✗→ components
 *
 * and Obicall nowhere: AnyTune has no Obicall dependency (Polycall is its only polyglot runtime; docs/ARCHITECTURE.md).
 *
 * and the direction components → app → domain ← fusion / audio / adapters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, loadRules, readSources } from '../../tools/architecture/check.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const rules = loadRules();
const sources = readSources(ROOT);

test('the repository has the layout of the public repository: the layers of src/, public/assets, tests, docs, tools', () => {
  for (const dir of ['src/app', 'src/components', 'src/domain', 'src/audio', 'src/fusion', 'src/instruments', 'src/adapters', 'src/styles', 'src/harness', 'public/assets', 'tests', 'docs', 'tools']) {
    assert.ok(fs.statSync(path.join(ROOT, dir)).isDirectory(), `${dir} is missing`);
  }
});

test('every source file of AnyTune keeps the layers: no violation of any kind', () => {
  // the checker reads every source there is — counted independently, by a glob of the disk
  const onDisk = fs.globSync('src/**/*.{ts,obix}', { cwd: ROOT }).map((f) => f.split(path.sep).join('/')).sort();
  assert.deepEqual(sources.map((s) => s.path), onDisk);
  assert.deepEqual(check(sources, rules), []);
});

test('the separations the directive names are rules of architecture.json, and not only a consequence of others', () => {
  const layer = (name: string) => {
    const found = rules.layers.find((l) => l.name === name);
    assert.ok(found, name);
    return found;
  };
  // domain ✗→ Vue, DOM: it imports no layer and no module, and names no DOM global
  assert.deepEqual([layer('domain').mayImport, layer('domain').modules], [[], []]);
  assert.ok(rules.globalsOf(layer('domain')).includes('document'));
  // components ✗→ providers, fusion, native code: they import the app's types and "obix" alone
  assert.deepEqual([layer('components').mayImport, layer('components').modules], [['app'], ['obix']]);
  // fusion ✗→ DOM
  assert.ok(rules.globalsOf(layer('fusion')).includes('document') && rules.globalsOf(layer('fusion')).includes('HTMLElement'));
  // the format adapters ✗→ components
  assert.ok(!layer('adapters').mayImport.includes('components'));
  // nothing but the harness may import vue, and nothing may import obicall: it is not a dependency
  for (const l of rules.layers) {
    if (l.name !== 'harness') assert.ok(!l.modules.includes('vue'), `${l.name} may import vue`);
    assert.ok(!l.modules.some((m) => m.includes('obicall')), `${l.name} may import obicall`);
  }
});

test('one source per component: there is no .vue file anywhere in the sources — the .obix file is the only source of a component', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const vue = walk(ROOT).filter((f) => f.endsWith('.vue'));
  assert.deepEqual(vue, []);
});
