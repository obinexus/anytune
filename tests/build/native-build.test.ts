/**
 * Phase 6, N11 — the production build of the NATIVE demo (`npm run build:native`, `vite build --mode native`), built for real into a temporary directory, and audited:
 *
 *   - the page is the same page (index.html, its stylesheet), its script mounts the UI with src/harness/mount-native.ts on OBIX's native runtime;
 *   - no module of Vue's runtime is in the bundle: not `vue`, not `@vue/runtime-core`, not `@vue/runtime-dom`, not `@vue/reactivity`, not `@vue/shared` — read from the
 *     module graph the bundler built, not guessed from the output — and OBIX's four runtime packages are;
 *   - its runtime manifest says `native` and lists every .obix component by the SHA-256 of its source — the IR trace's list;
 *   - the Vue build, built the same way, is the control: it does have Vue's runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import type { Plugin } from 'vite';
import { runtimeManifest } from '../../tools/obix/compile.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

async function built(mode: 'native' | 'production') {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `anytune-${mode}-`));
  const modules: string[] = [];
  const record: Plugin = { name: 'record-modules', moduleParsed(info) { modules.push(info.id.split(path.sep).join('/')); } };
  await build({ root: ROOT, mode, logLevel: 'silent', plugins: [record], build: { outDir, emptyOutDir: true } });
  return { outDir, modules };
}

const VUE_RUNTIME = /\/node_modules\/(?:vue|@vue\/(?:runtime-core|runtime-dom|reactivity|shared))\//;

test('the native build: the same page, no module of Vue\'s runtime in it, OBIX\'s runtime packages, and the manifest of the components it lowered — the trace\'s list', async () => {
  const { outDir, modules } = await built('native');
  try {
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<title>AnyTune — Groove to any tune<\/title>/);
    assert.match(html, /<link rel="stylesheet" crossorigin href="\/assets\/index-[\w-]+\.css">/);
    assert.deepEqual(modules.filter((id) => VUE_RUNTIME.test(id)), [], 'no module of Vue\'s runtime');
    for (const name of ['reactivity', 'dom', 'component', 'browser']) assert.ok(modules.some((id) => id.includes(`obix-runtime-${name}/dist/`)), `obix-runtime-${name} is in the bundle`);
    assert.ok(modules.some((id) => id.endsWith('src/harness/mount-native.ts')), 'the native harness mounts it');
    assert.ok(!modules.some((id) => id.endsWith('src/harness/mount.ts')), 'the Vue harness is not in it');
    assert.ok(modules.some((id) => /AnyTuneApp\.obix\?ir$/.test(id)), 'the root component, as IR');
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'obix-runtime-manifest.json'), 'utf8'));
    assert.equal(manifest.runtime, 'native');
    assert.deepEqual(manifest.components, runtimeManifest(ROOT));
    const js = fs.readdirSync(path.join(outDir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n');
    assert.match(js, /obix-dop-ir\/3/, 'the IR is in the bundle');
    assert.match(js, /anytune-pitch-recording\/1/, 'the demo input is in the bundle');
    assert.doesNotMatch(js, /__VUE__|__vccOpts|createElementVNode/, 'no mark of Vue\'s runtime in the output either');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('the control: the Vue build (the default) does have Vue\'s runtime, and its manifest says vue', async () => {
  const { outDir, modules } = await built('production');
  try {
    assert.ok(modules.some((id) => VUE_RUNTIME.test(id)), 'the audit sees Vue\'s runtime where it is');
    assert.ok(!modules.some((id) => id.includes('obix-runtime-browser/dist/')), 'and no native runtime');
    assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'obix-runtime-manifest.json'), 'utf8')).runtime, 'vue');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
