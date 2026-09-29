/**
 * The architecture checker catches every kind of violation it is meant to — shown on small synthetic sources, so that a green repository test means the rules
 * hold and not that the checker sees nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, importsOf, loadRules } from '../../tools/architecture/check.ts';
import type { SourceText, Violation } from '../../tools/architecture/check.ts';

const rules = loadRules();
const kinds = (violations: readonly Violation[]): string[] => violations.map((v) => `${v.kind} ${v.file}`);
const file = (path: string, text: string): SourceText => ({ path, text });

test('the imports of a TypeScript file: static, type-only, re-exports and dynamic imports, with their lines', () => {
  const text = [
    "import { a } from './a.ts';",
    "import type { B } from '../domain/b.ts';",
    "export { c } from './c.ts';",
    "export * from './d.ts';",
    "const e = await import('./e.ts');",
    "import 'side-effect';",
  ].join('\n');
  assert.deepEqual(importsOf(file('src/app/x.ts', text)).map((i) => [i.specifier, i.line]), [
    ['./a.ts', 1],
    ['../domain/b.ts', 2],
    ['./c.ts', 3],
    ['./d.ts', 4],
    ['./e.ts', 5],
    ['side-effect', 6],
  ]);
});

test('the imports of an .obix component are those of its script blocks, with lines counted in the whole file', () => {
  const text = [
    '<template>',
    '  <p>{{ n }}</p>',
    '</template>',
    '<script setup lang="ts">',
    'import { ref } from "obix";',
    'import type { View } from "../app/view.ts";',
    '</script>',
    '<script lang="ts">',
    'export const x = 1;',
    '</script>',
  ].join('\n');
  assert.deepEqual(importsOf(file('src/components/A.obix', text)).map((i) => [i.specifier, i.line]), [
    ['obix', 5],
    ['../app/view.ts', 6],
  ]);
});

test('a repository that keeps the rules has no violation', () => {
  const files = [
    file('src/domain/pitch.ts', 'export const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);'),
    file('src/instruments/guitar.ts', "import type { X } from '../domain/pitch.ts';\nexport const g: X[] = [];"),
    file('src/app/service.ts', "import { cents } from '../domain/pitch.ts';\nimport { g } from '../instruments/guitar.ts';\nexport const s = [cents, g];"),
    file('src/components/A.obix', '<script setup lang="ts">\nimport { ref } from "obix";\nimport type { S } from "../app/service.ts";\n</script>'),
    file('src/harness/main.ts', "import { createApp } from 'vue';\nimport A from '../components/A.obix';\nexport const app = createApp(A);"),
  ];
  assert.deepEqual(check(files, rules), []);
});

test('an import across layers against the direction is a violation: the domain importing the app, the app importing fusion, a component importing an adapter', () => {
  const files = [
    file('src/domain/a.ts', "import { s } from '../app/service.ts';\nexport const a = s;"),
    file('src/app/service.ts', "import { f } from '../fusion/simulated.ts';\nexport const s = f;"),
    file('src/fusion/simulated.ts', 'export const f = 1;'),
    file('src/adapters/obicall/reader.ts', 'export const r = 1;'),
    file('src/components/A.obix', '<script setup lang="ts">\nimport { r } from "../adapters/obicall/reader.ts";\n</script>'),
  ];
  assert.deepEqual(kinds(check(files, rules)), ['layer-import src/domain/a.ts', 'layer-import src/app/service.ts', 'layer-import src/components/A.obix']);
});

test('a module a layer may not use is a violation: Vue in the domain or in the app, anything but "obix" in a component, obicall anywhere', () => {
  const files = [
    file('src/domain/a.ts', "import { ref } from 'vue';\nexport const a = ref;"),
    file('src/app/b.ts', "import { reactive } from '@vue/reactivity';\nexport const b = reactive;"),
    file('src/components/A.obix', '<script setup lang="ts">\nimport { ref } from "vue";\n</script>'),
    file('src/fusion/c.ts', "import * as obicall from 'obicall';\nexport const c = obicall;"),
    file('src/adapters/d.ts', "import { readFileSync } from 'node:fs';\nexport const d = readFileSync;"),
  ];
  assert.deepEqual(kinds(check(files, rules)), [
    'module src/domain/a.ts',
    'module src/app/b.ts',
    'module src/components/A.obix',
    'module src/fusion/c.ts',
    'module src/adapters/d.ts',
  ]);
});

test('a global a layer may not name is a violation — as a value or as a type — and a property or a local of that name is not', () => {
  const files = [
    file('src/domain/a.ts', 'export const a = (): unknown => document.title;'),
    file('src/fusion/b.ts', 'export const b = (e: HTMLElement): string => e.id;'),
    file('src/app/c.ts', 'export const c = (): unknown => window.setTimeout;'),
    file('src/components/A.obix', '<script setup lang="ts">\nconst x = document.body;\n</script>'),
    file('src/domain/fine.ts', 'const document = { title: 1 };\nexport const d = { window: 1, navigator: document.title };\nexport const e = (o: { document: number }): number => o.document;'),
  ];
  assert.deepEqual(kinds(check(files, rules)), ['global src/domain/a.ts', 'global src/fusion/b.ts', 'global src/app/c.ts', 'global src/components/A.obix']);
});

test('a file of src/ that belongs to no layer, and a relative import of a file that does not exist, are violations', () => {
  const files = [
    file('src/stray.ts', 'export const s = 1;'),
    file('src/app/a.ts', "import { x } from './missing.ts';\nexport const a = x;"),
  ];
  assert.deepEqual(kinds(check(files, rules)), ['unassigned src/stray.ts', 'unresolved src/app/a.ts']);
});

test('a relative import must name its file: an import without an extension is a violation (the runtime and the tools resolve files, not guesses)', () => {
  const files = [file('src/domain/a.ts', "import { b } from './b';\nexport const a = b;"), file('src/domain/b.ts', 'export const b = 1;')];
  assert.deepEqual(kinds(check(files, rules)), ['extension src/domain/a.ts']);
});

test('the rules themselves are checked: every layer the rules name exists, and no two layers claim one directory', () => {
  const names = new Set(rules.layers.map((l) => l.name));
  for (const layer of rules.layers) for (const other of layer.mayImport) assert.ok(names.has(other), `${layer.name} may import ${other}, which is no layer`);
  const paths = rules.layers.flatMap((l) => l.paths);
  assert.equal(new Set(paths).size, paths.length);
});

test('Phase 6: an .obix component may be imported as its IR (`?ir`), a query the build understands; any other query is not a file', () => {
  const files = [
    file('src/components/A.obix', '<template>\n  <p>a</p>\n</template>\n'),
    file('src/harness/mount-native.ts', "import A, { registry } from '../components/A.obix?ir';\nexport const x = [A, registry];"),
    file('src/harness/other.ts', "import A from '../components/A.obix?raw';\nexport const y = A;"),
  ];
  assert.deepEqual(kinds(check(files, rules)), ['extension src/harness/other.ts']);
});

test('Phase 6: the native harness may import OBIX\'s native runtime and never Vue — the one harness file that runs the UI without it', () => {
  const files = [
    file('src/harness/mount-native.ts', "import { createObixApp } from 'obix-runtime-browser';\nimport { h } from 'vue';\nexport const x = [createObixApp, h];"),
    file('src/harness/mount.ts', "import { createObixApp } from 'obix-runtime-browser';\nexport const y = createObixApp;"),
  ];
  assert.deepEqual(check(files, rules).map((v) => `${v.kind} ${v.file} ${v.detail}`), [
    'module src/harness/mount-native.ts native-harness may not import the module "vue"',
    'module src/harness/mount.ts harness may not import the module "obix-runtime-browser"',
  ]);
});
