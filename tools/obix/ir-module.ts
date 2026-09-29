/**
 * The native runtime's module of an .obix component (Phase 6, N11): `Component.obix?ir`. The component is LOWERED — the same file, through the same OBIX Vue frontend and
 * `lowerVueToDop` that write the IR trace (trace.ts) — and so is every component it invokes, directly or not; the module's default export is the component's canonical IR
 * (`obix-dop-ir/3`), `registry` holds the IR of every component it reaches by the module specifier its source wrote (what obix-runtime-browser links an
 * application with), and `sourceSha256` is the SHA-256 of its source. No source is rewritten and no framework code is in it: plain data.
 *
 * Refused, with the reason, never a partial module: a component the IR cannot express (its lowering's own diagnostics); two components that name DIFFERENT files by one
 * specifier (one registry of specifiers could not tell them apart).
 */
import path from 'node:path';
import { traceComponent } from './trace.ts';
import type { TraceEntry } from './trace.ts';

export interface IrModule {
  /** the module's code */
  readonly code: string;
  /** every file lowered for it: the component and everything it reaches */
  readonly files: readonly TraceEntry[];
}

export function irModuleOf(file: string, root: string): IrModule {
  const lowered = new Map<string, TraceEntry>();
  const bySpecifier = new Map<string, string>();
  const registry: Record<string, unknown> = {};
  const visit = (at: string): TraceEntry => {
    const known = lowered.get(at);
    if (known !== undefined) return known;
    const entry = traceComponent(at, root);
    if (entry.status !== 'compiled' || entry.ir === null) {
      const reasons = entry.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n  ');
      throw new Error(`${path.basename(at)} is not lowered to the IR (${entry.status}): the native runtime runs only canonical IR\n  ${reasons}`);
    }
    lowered.set(at, entry);
    for (const dependency of entry.ir.dependencies as { specifier: string }[]) {
      const target = path.resolve(path.dirname(at), dependency.specifier);
      const named = bySpecifier.get(dependency.specifier);
      if (named !== undefined && named !== target) {
        throw new Error(`${dependency.specifier} names two files — ${path.relative(root, named)} and ${path.relative(root, target)} — and one registry of specifiers cannot tell them apart`);
      }
      bySpecifier.set(dependency.specifier, target);
      registry[dependency.specifier] = visit(target).ir;
    }
    return entry;
  };
  const entry = visit(path.resolve(file));
  const code = [
    `// ${entry.source}, lowered by the OBIX Vue frontend to canonical DOP IR (tools/obix/ir-module.ts) — plain data for OBIX's native runtime`,
    `export const sourceSha256 = ${JSON.stringify(entry.sourceSha256)};`,
    `const ir = ${JSON.stringify(entry.ir, null, 2)};`,
    'export default ir;',
    `export const registry = ${JSON.stringify(registry, null, 2)};`,
    '',
  ].join('\n');
  return { code, files: [...lowered.values()] };
}
