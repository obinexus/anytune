/**
 * The demo harness's Vite plugin — what register.ts does for Node, for the browser: an .obix file is loaded as the modules the REAL OBIX Vue frontend compiles
 * from it (compile.ts), and "obix" — imported only by an .obix component — resolves to the allowlisted Vue-compatible primitives (obix-vue-compat.ts); and
 * `Component.obix?ir` is the component lowered to canonical DOP IR with everything it invokes, for OBIX's native runtime (ir-module.ts, Phase 6 N11). No source
 * file is rewritten; a component with any diagnostic of any stage, or an import from "obix" outside the allowlist, or one the IR cannot express, fails the build.
 *
 * The production build also writes `obix-runtime-manifest.json`: every component it compiled, by path and the SHA-256 of its source — the same list the
 * IR trace records (dist/obix-ir), so that the two proof paths are shown to start from the same files (tests/build/vite-build.test.ts).
 *
 * Which runtime runs the UI is the harness's choice (`#anytune-mount`, vite.config.ts): the official Vue runtime by default, OBIX's native runtime in `--mode native`.
 * The manifest says which (`runtime`).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { checkObixImports } from './allowlist.ts';
import { compileObix, glueModule, normalize, sha256 } from './compile.ts';
import type { CompiledObix } from './compile.ts';
import { irModuleOf } from './ir-module.ts';

const COMPAT = path.join(import.meta.dirname, 'obix-vue-compat.ts');
const isObix = (id: string | undefined): boolean => id !== undefined && /\.obix(\?|$)/.test(id);

export function obixVue(): Plugin {
  const cache = new Map<string, CompiledObix>();
  const built = new Map<string, string>();
  let root = process.cwd();
  let runtime: 'vue' | 'native' = 'vue';

  const compiledAt = (file: string): CompiledObix => {
    const source = fs.readFileSync(file, 'utf8');
    const key = `${file}\n${source}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const problems = [...checkObixImports(source, path.basename(file))];
    const compiled = compileObix(source, path.basename(file));
    problems.push(...compiled.diagnostics);
    if (problems.length > 0) throw new Error(`${path.basename(file)} is not built:\n  ${problems.join('\n  ')}`);
    cache.set(key, compiled);
    built.set(path.relative(root, file).split(path.sep).join('/'), sha256(normalize(source)));
    return compiled;
  };

  return {
    name: 'anytune:obix-vue',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
      runtime = config.mode === 'native' ? 'native' : 'vue';
    },
    resolveId(source, importer) {
      if (source !== 'obix') return null;
      if (!isObix(importer)) this.error(`"obix" is imported only by .obix components; ${importer ?? 'an entry'} is not one`);
      return COMPAT;
    },
    load(id) {
      if (!isObix(id)) return null;
      const [file, query] = id.split('?') as [string, string | undefined];
      this.addWatchFile(file);
      const params = new URLSearchParams(query ?? '');
      if (params.has('ir')) {
        const module = irModuleOf(file, root);
        for (const entry of module.files) {
          this.addWatchFile(path.join(root, entry.source));
          built.set(entry.source, entry.sourceSha256);
        }
        return { code: module.code, moduleType: 'js' };
      }
      const compiled = compiledAt(file);
      const part = params.get('obix');
      const code = part === 'script' ? compiled.script : part === 'render' ? compiled.render : glueModule(path.basename(file));
      return { code: code ?? 'export default {};', moduleType: 'js' };
    },
    generateBundle() {
      const components = [...built.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, sourceSha256]) => ({ source, sourceSha256 }));
      const about = runtime === 'native'
        ? 'The .obix components this build lowered with the OBIX Vue frontend to canonical DOP IR for OBIX\'s native runtime, by path and SHA-256 of the source (the same list dist/obix-ir traces).'
        : 'The .obix components this build compiled with the OBIX Vue frontend for the Vue runtime, by path and SHA-256 of the source (the same list dist/obix-ir traces).';
      this.emitFile({ type: 'asset', fileName: 'obix-runtime-manifest.json', source: `${JSON.stringify({ about, runtime, components }, null, 2)}\n` });
    },
  };
}
