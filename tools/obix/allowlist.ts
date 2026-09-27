/**
 * The build-time allowlist of the demo's "obix" → "vue" compatibility alias: the OBIX authoring primitives currently defined as Vue-compatible. Anything else
 * imported from "obix" is a build error — an OBIX-owned export must never be resolved from Vue by accident. This is the demo harness, not the OBIX runtime.
 */
import ts from 'typescript';
import { scriptOf } from '../architecture/check.ts';

export const OBIX_VUE_COMPATIBLE: readonly string[] = Object.freeze(['computed', 'nextTick', 'onMounted', 'onUnmounted', 'reactive', 'ref', 'shallowRef', 'toRef', 'toRefs', 'unref', 'watch', 'watchEffect']);

/** The problems of a component's imports from "obix", as `file:line: message` — empty when every import is an allowlisted primitive imported by name. */
export function checkObixImports(source: string, filename: string): string[] {
  const text = scriptOf({ path: filename, text: source.replace(/\r\n/g, '\n') });
  const sf = ts.createSourceFile(`${filename}.ts`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (node: ts.Node): string => `${filename}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'obix') {
      problems.push(`${at(statement)}: a re-export from "obix" is not allowed`);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'obix') continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (clause.name !== undefined) problems.push(`${at(statement)}: a default import of "obix" is not allowed: import the primitives by name`);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) problems.push(`${at(statement)}: a namespace import of "obix" is not allowed: import the primitives by name`);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        if (!OBIX_VUE_COMPATIBLE.includes(name)) problems.push(`${at(statement)}: \`${name}\` is not a Vue-compatible OBIX primitive — an OBIX-owned export is never resolved from Vue`);
      }
    }
  }
  return problems;
}
