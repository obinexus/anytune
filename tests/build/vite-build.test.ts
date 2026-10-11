/**
 * A9 — the production build of the browser demo (vite.config.ts, tools/obix/vite-plugin.ts), built for real into a temporary directory:
 *
 *   - its runtime manifest lists every .obix component by the SHA-256 of its source — the same list, and the same hashes, the IR trace records;
 *   - "obix" is resolved at build time, never left for the browser: the bundle has no import of it, and runs on Vue's own runtime;
 *   - the bundle carries the demo input (the guitar's acceptance sequence) and nothing of Obicall — it is not a dependency — and no DLL: the demo needs none.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { componentFiles, runtimeManifest } from '../../tools/obix/compile.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('the production build: a page, its script and stylesheet, and the runtime manifest of the .obix components it compiled — the trace’s list', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-build-'));
  try {
    await build({ root: ROOT, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" crossorigin href="\/assets\/index-[\w-]+\.css">/);
    assert.match(html, /<title>AnyTune — Tune any instrument<\/title>/);

    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'obix-runtime-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.components, runtimeManifest(ROOT));
    assert.equal(manifest.components.length, componentFiles(ROOT).length);

    const assets = fs.readdirSync(path.join(outDir, 'assets'));
    const js = assets.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n');
    assert.doesNotMatch(js, /from\s*["']obix["']|import\(["']obix["']\)/, '"obix" is resolved at build time');
    assert.match(js, /anytune-pitch-recording\/1/, 'the demo input is in the bundle');
    assert.doesNotMatch(js, /JORB|obicall_static_fuse_1d|fuse-harness|\.dll/i, 'nothing of Obicall is in the bundle: AnyTune does not depend on it');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
