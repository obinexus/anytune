/**
 * The OBIX IR names inline prop types only (docs/OBIX-GAPS.md), so a screen's view type is written out in the screen AND in the shell that passes it down.
 * The two copies must be the same text: a field added to one and not the other would reach the page untyped on one runtime and typed on the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const component = (name: string): string => fs.readFileSync(path.join(ROOT, 'src', 'components', `${name}.obix`), 'utf8').replace(/\r\n/g, '\n');

/** the prop's inline type, from its name to its closing brace at the same indentation */
function propBlock(source: string, prop: string): string {
  const start = source.indexOf(`\n  ${prop}: {`);
  assert.ok(start >= 0, `no ${prop} prop`);
  const end = source.indexOf('\n  };\n', start);
  assert.ok(end > start, `${prop}: no end`);
  return source.slice(start, end);
}

test('the shell passes each screen the view the screen declares: the inline prop types are the same text', () => {
  const shell = component('AnyTuneShell');
  for (const [screen, prop] of [['PracticeScreen', 'practice'], ['PlayScreen', 'play'], ['FollowScreen', 'follow']] as const) assert.equal(propBlock(shell, prop), propBlock(component(screen), prop), `${screen}.${prop}`);
});
