/**
 * Für Elise's opening as a reference — tests/fixtures/midi/fur-elise-opening.mid (the public-domain score, encoded for AnyTune), read as practice reads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { referenceFromMidi, type Reference } from '../../src/music/reference.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export function furElise(): Reference {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid')));
  const made = referenceFromMidi(bytes, { song: { id: 'fur-elise', title: 'Für Elise', composer: 'Beethoven' }, arrangement: { id: 'fe', version: 1, instrument: 'piano', part: 'full' }, provenance: { kind: 'midi-import', midi: { role: 'midi', fileName: 'fe.mid', mediaType: 'audio/midi', sha256: 'c821', bytes: 495 } } });
  if (!made.ok) throw new Error(made.reason);
  return made.reference;
}
