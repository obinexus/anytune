/**
 * The OBIX semantic proof path: every .obix component lowered by the real OBIX Vue frontend and `lowerVueToDop` into the canonical `obix-dop-ir/3`, written as a
 * reviewable trace — one JSON document per component, and an index — under dist/obix-ir. GENERATED from the sources; never written by hand. A component the
 * current IR cannot express is a `deferred` entry with the lowering's own diagnostics and no IR (never a partial one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { lowerVueToDop } from '@obinexusltd/obix-compiler-dop';
import { serializeIr, serializeIrProvenance } from '@obinexusltd/obix-compiler-ir';
import { componentFiles, normalize, sha256, stagesOf } from './compile.ts';

export const TRACE_SCHEMA = 'anytune-obix-trace/1';
const PIPELINE = ['@obinexusltd/obix-compiler-parser', '@obinexusltd/obix-compiler-script-setup', '@obinexusltd/obix-compiler-template', '@obinexusltd/obix-compiler-dop', '@obinexusltd/obix-compiler-ir'] as const;

export interface TraceEntry {
  readonly schema: typeof TRACE_SCHEMA;
  readonly source: string;
  readonly sourceSha256: string;
  readonly pipeline: Readonly<Record<string, string>>;
  readonly status: string;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  /** the canonical IR, as plain JSON (its type is the IR package's `ObixIr`) */
  readonly ir: any;
  readonly provenance: any;
}

function versions(root: string): Record<string, string> {
  return Object.fromEntries(PIPELINE.map((name) => [name, (JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version]));
}

export function traceComponent(file: string, root: string): TraceEntry {
  const source = normalize(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(root, file).split(path.sep).join('/');
  const stages = stagesOf(source, path.basename(file));
  const result = lowerVueToDop({ sfc: stages.sfc, script: stages.script, template: stages.template });
  const compiled = result.status === 'compiled' && result.artifact !== null;
  return {
    schema: TRACE_SCHEMA,
    source: rel,
    sourceSha256: sha256(source),
    pipeline: versions(root),
    status: result.status,
    diagnostics: result.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    // the IR package's canonical text of each document, back as plain JSON
    ir: compiled ? JSON.parse(serializeIr(result.artifact.ir)) : null,
    provenance: compiled ? JSON.parse(serializeIrProvenance(result.artifact.provenance)) : null,
  };
}

/** Write the trace of every component to `outDir`: `<Component>.obix.json` each, and `index.json`. Deterministic: the same sources give the same bytes. */
export function writeTrace(root: string, outDir: string): TraceEntry[] {
  fs.mkdirSync(outDir, { recursive: true });
  const entries = componentFiles(root).map((file) => traceComponent(file, root));
  for (const entry of entries) fs.writeFileSync(path.join(outDir, `${path.basename(entry.source)}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  const index = { schema: `${TRACE_SCHEMA}/index`, components: entries.map((e) => ({ source: e.source, sourceSha256: e.sourceSha256, status: e.status, diagnostics: e.diagnostics.map((d) => d.code) })) };
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return entries;
}
