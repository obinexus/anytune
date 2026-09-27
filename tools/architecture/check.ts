/**
 * The architecture checker of AnyTune: reads the imports and the free identifiers of every source of src/ — TypeScript files, and the <script> blocks of .obix
 * components — with the TypeScript compiler API, and holds them to the layers of architecture.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface SourceText {
  /** POSIX path relative to the repository root, e.g. `src/domain/pitch.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface Layer {
  readonly name: string;
  readonly paths: readonly string[];
  readonly mayImport: readonly string[];
  readonly modules: readonly string[];
  readonly forbiddenGlobals: readonly string[] | 'domGlobals';
  readonly why: string;
}

export interface Rules {
  readonly domGlobals: readonly string[];
  readonly layers: readonly Layer[];
  globalsOf(layer: Layer): readonly string[];
}

export type ViolationKind = 'layer-import' | 'module' | 'global' | 'unassigned' | 'unresolved' | 'extension';

export interface Violation {
  readonly kind: ViolationKind;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface ImportRef {
  readonly specifier: string;
  readonly line: number;
}

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export function loadRules(file = path.join(ROOT, 'architecture.json')): Rules {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { domGlobals: string[]; layers: Layer[] };
  return {
    domGlobals: data.domGlobals,
    layers: data.layers,
    globalsOf: (layer) => (layer.forbiddenGlobals === 'domGlobals' ? data.domGlobals : layer.forbiddenGlobals),
  };
}

/** The script of a source as TypeScript text, with the lines of the whole file kept: an .obix file's markup outside its <script> blocks becomes blank lines. */
export function scriptOf(file: SourceText): string {
  if (!file.path.endsWith('.obix')) return file.text;
  const lines = file.text.split('\n');
  let inside = false;
  return lines
    .map((line) => {
      if (!inside && /^\s*<script\b[^>]*>\s*$/.test(line)) {
        inside = true;
        return '';
      }
      if (inside && /^\s*<\/script>\s*$/.test(line)) {
        inside = false;
        return '';
      }
      return inside ? line : '';
    })
    .join('\n');
}

const parse = (file: SourceText): ts.SourceFile => ts.createSourceFile(file.path.replace(/\.obix$/, '.ts'), scriptOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Every module a source names: static imports (type-only too), re-exports, dynamic `import('…')` with a literal. */
export function importsOf(file: SourceText): ImportRef[] {
  const sf = parse(file);
  const found: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, line: lineOf(sf, node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ specifier: node.arguments[0].text, line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Names the file declares itself — a use of one of those is the file's own, not the global. */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && node.name !== undefined) bind(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name !== undefined) names.add(node.name.text);
    else if (ts.isImportClause(node) && node.name !== undefined) names.add(node.name.text);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Whether an identifier is a name of something else than a variable reference: a property, a member, a declaration, a label. */
function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isLabeledStatement(parent)) return true;
  return false;
}

function globalsUsed(file: SourceText, forbidden: readonly string[]): { name: string; line: number }[] {
  if (forbidden.length === 0) return [];
  const sf = parse(file);
  const own = declaredNames(sf);
  const wanted = new Set(forbidden.filter((name) => !own.has(name)));
  const found: { name: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && wanted.has(node.text) && !isNameOnly(node)) found.push({ name: node.text, line: lineOf(sf, node) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

export function layerOf(file: string, rules: Rules): Layer | undefined {
  return rules.layers.find((layer) => layer.paths.some((prefix) => file.startsWith(prefix)));
}

/** Hold the sources to the rules. Violations come in the order of the files, then of the lines. */
export function check(files: readonly SourceText[], rules: Rules): Violation[] {
  const known = new Set(files.map((f) => f.path));
  const violations: Violation[] = [];
  for (const file of files) {
    const layer = layerOf(file.path, rules);
    if (layer === undefined) {
      violations.push({ kind: 'unassigned', file: file.path, line: 1, detail: 'the file belongs to no layer of architecture.json' });
      continue;
    }
    for (const ref of importsOf(file)) {
      if (ref.specifier.startsWith('.')) {
        if (!/\.(ts|obix|css|json|svg)$/.test(ref.specifier)) {
          violations.push({ kind: 'extension', file: file.path, line: ref.line, detail: `${ref.specifier}: a relative import names its file, with its extension` });
          continue;
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), ref.specifier));
        if (!known.has(target)) {
          violations.push({ kind: 'unresolved', file: file.path, line: ref.line, detail: `${ref.specifier} is no source file (${target})` });
          continue;
        }
        const to = layerOf(target, rules);
        if (to === undefined || (to.name !== layer.name && !layer.mayImport.includes(to.name))) {
          violations.push({ kind: 'layer-import', file: file.path, line: ref.line, detail: `${layer.name} may not import ${to?.name ?? 'an unassigned file'} (${target})` });
        }
      } else if (!layer.modules.includes(ref.specifier)) {
        violations.push({ kind: 'module', file: file.path, line: ref.line, detail: `${layer.name} may not import the module "${ref.specifier}"` });
      }
    }
    for (const use of globalsUsed(file, rules.globalsOf(layer))) {
      violations.push({ kind: 'global', file: file.path, line: use.line, detail: `${layer.name} may not use the global ${use.name}` });
    }
  }
  return violations;
}

/** The sources of src/: TypeScript and .obix files (stylesheets and assets have no imports to check). */
export function readSources(root = ROOT): SourceText[] {
  const src = path.join(root, 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  return walk(src)
    .filter((f) => /\.(ts|obix)$/.test(f))
    .sort()
    .map((f) => ({ path: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') }));
}
