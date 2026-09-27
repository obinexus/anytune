/**
 * The demo's "obix" → "vue" compatibility alias — a demo harness, NOT the OBIX runtime (OBIX has no runtime or emitter of its own yet). It is symbol-aware and
 * module-boundary controlled: only the authoring primitives defined as Vue-compatible resolve, each to Vue's own function; any other name imported from "obix"
 * is a build error (an OBIX-owned export must never be taken from Vue by accident); and only an .obix component may import "obix" at all. The .obix sources are
 * never rewritten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vue from 'vue';
import { OBIX_VUE_COMPATIBLE, checkObixImports } from '../../tools/obix/allowlist.ts';
import * as compat from '../../tools/obix/obix-vue-compat.ts';

test('the allowlist: the Vue-compatible primitives, and nothing else', () => {
  assert.deepEqual([...OBIX_VUE_COMPATIBLE], ['computed', 'nextTick', 'onMounted', 'onUnmounted', 'reactive', 'ref', 'shallowRef', 'toRef', 'toRefs', 'unref', 'watch', 'watchEffect']);
});

test('the compatibility module exports exactly the allowlist, each Vue’s own function', () => {
  assert.deepEqual(Object.keys(compat).sort(), [...OBIX_VUE_COMPATIBLE]);
  for (const name of OBIX_VUE_COMPATIBLE) assert.equal((compat as Record<string, unknown>)[name], (vue as Record<string, unknown>)[name], name);
});

test('an allowlisted import from "obix" passes; a name that is not Vue-compatible, a namespace or a default import, and a re-export fail the build', () => {
  const ok = '<script setup lang="ts">\nimport { computed, ref as r } from "obix";\nimport type { Foo } from "obix";\n</script>';
  assert.deepEqual(checkObixImports(ok, 'A.obix'), []);
  const bad = [
    '<script setup lang="ts">',
    'import { ref, defineTuner } from "obix";',
    'import * as obix from "obix";',
    'import obix2 from "obix";',
    '</script>',
    '<script lang="ts">',
    'export { computed } from "obix";',
    '</script>',
  ].join('\n');
  assert.deepEqual(checkObixImports(bad, 'B.obix'), [
    'B.obix:2: `defineTuner` is not a Vue-compatible OBIX primitive — an OBIX-owned export is never resolved from Vue',
    'B.obix:3: a namespace import of "obix" is not allowed: import the primitives by name',
    'B.obix:4: a default import of "obix" is not allowed: import the primitives by name',
    'B.obix:7: a re-export from "obix" is not allowed',
  ]);
});
