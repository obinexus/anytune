/** `npm run trace`: write the OBIX DOP trace of every component to dist/obix-ir (or the directory given), and say what each became. */
import path from 'node:path';
import { writeTrace } from './trace.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const out = path.resolve(ROOT, process.argv[2] ?? 'dist/obix-ir');
const entries = writeTrace(ROOT, out);
for (const entry of entries) console.log(`${entry.status.padEnd(9)} ${entry.source}${entry.diagnostics.length > 0 ? `  (${entry.diagnostics.map((d) => d.code).join(', ')})` : ''}`);
console.log(`${entries.length} components -> ${path.relative(ROOT, out) || '.'}`);
