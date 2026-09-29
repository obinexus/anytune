/**
 * AnyTune's .obix components through the REAL OBIX Vue frontend — the chain of stages the OBIX repository composes (tests/vuets/compose.mjs there):
 *
 *   .obix ─► parseObix ─► toObixSfc ─► compileObixScriptSetup ─► binding metadata ─► compileObixTemplate (with it) ─► transpileObixTypeScript ─► JavaScript
 *
 * The EXECUTION path runs that JavaScript on the official Vue runtime (the demo harness: register.ts for Node, the Vite plugin for the browser); the SEMANTIC
 * path gives the same stages to lowerVueToDop (trace.ts). No stage is replaced, and no source is rewritten.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseObix } from 'obix-compiler-parser';
import { toObixSfc } from 'obix-compiler-sfc';
import { compileObixScript } from 'obix-compiler-script';
import { compileObixScriptSetup } from 'obix-compiler-script-setup';
import { compileObixTemplate } from 'obix-compiler-template';
import { transpileObixTypeScript } from 'obix-compiler-typescript';

export const normalize = (source: string): string => source.replace(/\r\n/g, '\n');
export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/** Every stage's result for one component — what both paths start from. */
export function stagesOf(source: string, filename: string) {
  const parsed = parseObix(normalize(source), filename);
  const sfc = toObixSfc(parsed);
  const setup = compileObixScriptSetup(sfc);
  const script = setup.status === 'absent' ? compileObixScript(sfc) : setup;
  const bindingMetadata = script.artifact ? script.artifact.bindings : undefined;
  const template = compileObixTemplate(sfc, bindingMetadata ? { bindingMetadata } : undefined);
  const scriptJs = script.artifact ? transpileObixTypeScript({ filename, code: script.artifact.content, lang: script.artifact.lang }) : null;
  const templateJs = template.artifact ? transpileObixTypeScript({ filename, code: template.artifact.code, lang: 'ts' }) : null;
  return { parsed, sfc, script, template, scriptJs, templateJs };
}

export interface CompiledObix {
  /** the component's script module, JavaScript */
  readonly script: string | null;
  /** its render function module, JavaScript */
  readonly render: string | null;
  /** every diagnostic of every stage, as `stage CODE: message` — a component with any is not built */
  readonly diagnostics: readonly string[];
  readonly sourceSha256: string;
}

export function compileObix(source: string, filename: string): CompiledObix {
  const stages = stagesOf(source, filename);
  const diagnostics: string[] = [];
  const said = (stage: string, list: readonly { code: string; message: string }[] | undefined): void => {
    for (const d of list ?? []) diagnostics.push(`${stage} ${d.code}: ${d.message}`);
  };
  said('parse', stages.parsed.diagnostics);
  said('script', stages.script.diagnostics);
  said('template', stages.template.diagnostics);
  said('typescript(script)', stages.scriptJs?.diagnostics);
  said('typescript(template)', stages.templateJs?.diagnostics);
  if (stages.script.status !== 'compiled') diagnostics.push(`script: ${stages.script.status}`);
  if (stages.template.status !== 'compiled') diagnostics.push(`template: ${stages.template.status}`);
  return { script: stages.scriptJs?.code ?? null, render: stages.templateJs?.code ?? null, diagnostics, sourceSha256: sha256(normalize(source)) };
}

/** The module that stands for a component: its script's component object, given its render function. */
export function glueModule(basename: string): string {
  return [
    `import component from "./${basename}?obix=script";`,
    `import { render } from "./${basename}?obix=render";`,
    'component.render = render;',
    `component.__name = ${JSON.stringify(basename.replace(/\.obix$/, ''))};`,
    'export default component;',
    '',
  ].join('\n');
}

/** The .obix components of the repository, sorted. */
export function componentFiles(root: string): string[] {
  const dir = path.join(root, 'src', 'components');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.obix'))
    .sort()
    .map((f) => path.join(dir, f));
}

export interface RuntimeEntry {
  readonly source: string;
  readonly sourceSha256: string;
}

/** What the runtime build compiles: every component, by path and the hash of the source it was compiled from (the Vite plugin writes the same, A9). */
export function runtimeManifest(root: string): RuntimeEntry[] {
  return componentFiles(root).map((file) => {
    const compiled = compileObix(fs.readFileSync(file, 'utf8'), path.basename(file));
    if (compiled.diagnostics.length > 0) throw new Error(`${file}: ${compiled.diagnostics.join('; ')}`);
    return { source: path.relative(root, file).split(path.sep).join('/'), sourceSha256: compiled.sourceSha256 };
  });
}
