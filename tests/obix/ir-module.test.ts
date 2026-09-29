/**
 * Phase 6, N11 — the native runtime's modules of the .obix components: `Component.obix?ir` is the component LOWERED — the same file, through the same OBIX Vue frontend
 * and DOP lowering that write the IR trace — as a module whose default export is its canonical IR (`obix-dop-ir/3`), with `registry`, every component it invokes
 * (directly or not) by the module specifier its source wrote, and the SHA-256 of its source. No source is rewritten and no Vue code is in it. A component the IR cannot
 * express, or two components that name different files by one specifier, is refused with the reason — never a partial module.
 */
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { irEqual } from 'obix-compiler-ir';
import { componentFiles } from '../../tools/obix/compile.ts';
import { traceComponent } from '../../tools/obix/trace.ts';
import { irModuleOf } from '../../tools/obix/ir-module.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const COMPONENTS = path.join(ROOT, 'src', 'components');

test('AnyTuneApp.obix?ir: its canonical IR, the trace\'s — and a registry of every component it invokes, each the trace\'s IR of that file', async () => {
  const module = (await import('../../src/components/AnyTuneApp.obix?ir')) as { default: unknown; registry: Record<string, unknown>; sourceSha256: string };
  const trace = traceComponent(path.join(COMPONENTS, 'AnyTuneApp.obix'), ROOT);
  assert.equal(trace.status, 'compiled');
  assert.equal(irEqual(module.default as never, trace.ir), true, 'the IR the native runtime runs is the one the trace records');
  assert.equal(module.sourceSha256, trace.sourceSha256, 'from the same source');
  const others = componentFiles(ROOT).map((f) => path.basename(f)).filter((n) => n !== 'AnyTuneApp.obix').sort();
  assert.deepEqual(Object.keys(module.registry).sort(), others.map((n) => `./${n}`), 'every other component, reached directly or through others');
  for (const name of others) assert.equal(irEqual(module.registry[`./${name}`] as never, traceComponent(path.join(COMPONENTS, name), ROOT).ir), true, name);
});

test('the module holds no code of any framework: plain data', () => {
  const code = irModuleOf(path.join(COMPONENTS, 'PitchMeter.obix'), ROOT).code;
  assert.doesNotMatch(code, /\bvue\b|createElementVNode|openBlock/);
  assert.match(code, /"schema": "obix-dop-ir\/3"/);
});

test('a component the IR cannot express is refused, with the lowering\'s own diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-ir-'));
  try {
    const file = path.join(dir, 'Model.obix');
    fs.writeFileSync(file, '<script setup lang="ts">\nimport { ref } from "obix";\nconst text = ref("");\n</script>\n\n<template>\n  <input v-model="text" />\n</template>\n');
    assert.throws(() => irModuleOf(file, ROOT), /Model\.obix is not lowered to the IR[^]*OBIX_DOP_DEFERRED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two components that name different files by one specifier are refused: the registry would not know which is meant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-ir-'));
  try {
    const leaf = (text: string) => `<template>\n  <p>${text}</p>\n</template>\n`;
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a', 'Leaf.obix'), leaf('a'));
    fs.writeFileSync(path.join(dir, 'b', 'Leaf.obix'), leaf('b'));
    const invoker = () => `<script setup lang="ts">\nimport Leaf from "./Leaf.obix";\n</script>\n\n<template>\n  <Leaf />\n</template>\n`;
    fs.writeFileSync(path.join(dir, 'a', 'A.obix'), invoker());
    fs.writeFileSync(path.join(dir, 'b', 'B.obix'), invoker());
    fs.writeFileSync(path.join(dir, 'Root.obix'), '<script setup lang="ts">\nimport A from "./a/A.obix";\nimport B from "./b/B.obix";\n</script>\n\n<template>\n  <A />\n  <B />\n</template>\n');
    assert.throws(() => irModuleOf(path.join(dir, 'Root.obix'), ROOT), /\.\/Leaf\.obix names two files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
