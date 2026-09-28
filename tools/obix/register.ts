/**
 * The demo harness's module hooks for Node (the UI tests; the browser build does the same in its Vite plugin): an .obix file is loaded as the modules the OBIX
 * Vue frontend compiled from it, and "obix" — imported only by an .obix component — resolves to the allowlisted Vue-compatible primitives; `Component.obix?ir` is the
 * component lowered to canonical DOP IR, for OBIX's native runtime (ir-module.ts). What a bundler does, nothing more: no source file is rewritten.
 */
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkObixImports } from './allowlist.ts';
import { compileObix, glueModule } from './compile.ts';
import { irModuleOf } from './ir-module.ts';
import type { CompiledObix } from './compile.ts';

const COMPAT_URL = pathToFileURL(path.join(import.meta.dirname, 'obix-vue-compat.ts')).href;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const isObix = (url: string | undefined): boolean => url !== undefined && /\.obix(\?|$)/.test(url);

const cache = new Map<string, CompiledObix>();
function compiledAt(fileUrl: string): CompiledObix {
  const file = fileURLToPath(fileUrl);
  const source = fs.readFileSync(file, 'utf8');
  const key = `${file}\n${source}`;
  let compiled = cache.get(key);
  if (compiled === undefined) {
    const problems = [...checkObixImports(source, path.basename(file))];
    compiled = compileObix(source, path.basename(file));
    problems.push(...compiled.diagnostics);
    if (problems.length > 0) throw new Error(`${path.basename(file)} is not built:\n  ${problems.join('\n  ')}`);
    cache.set(key, compiled);
  }
  return compiled;
}

let registered = false;
export function registerObixHooks(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'obix') {
        if (!isObix(context.parentURL)) throw new Error(`"obix" is imported only by .obix components; ${context.parentURL ?? 'an entry'} is not one`);
        return { url: COMPAT_URL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!isObix(url)) return nextLoad(url, context);
      const [fileUrl, query] = url.split('?') as [string, string | undefined];
      const params = new URLSearchParams(query ?? '');
      if (params.has('ir')) return { format: 'module', source: irModuleOf(fileURLToPath(fileUrl), ROOT).code, shortCircuit: true };
      const compiled = compiledAt(fileUrl);
      const part = params.get('obix');
      const source = part === 'script' ? compiled.script : part === 'render' ? compiled.render : glueModule(path.basename(fileURLToPath(fileUrl)));
      return { format: 'module', source: source ?? 'export default {};', shortCircuit: true };
    },
  });
}
