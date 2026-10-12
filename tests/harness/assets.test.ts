/**
 * src/harness/assets.generated.ts is generated (tools/fixtures/write-harness-assets.ts): it must still be what its sources are — the bundled song's MIDI, the
 * supplied guitar artwork byte for byte, and the fretboard map — so that a source changed without regenerating is caught here, not on a device.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { FUR_ELISE_MIDI_BASE64, GUITAR_ARTWORK_DATA_URL } from '../../src/harness/assets.generated.ts';
import { OUT, harnessAssets } from '../../tools/fixtures/write-harness-assets.ts';

const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');

test('the generated module is what the generator writes from the sources today (npm run assets:harness regenerates it)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), harnessAssets());
});

test('the artwork is the supplied file, unchanged; the song is the encoded score the bundled reference names', () => {
  const svg = Buffer.from(GUITAR_ARTWORK_DATA_URL.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64');
  assert.equal(sha256(svg), '8e2a36241e2eb838bb48a134798859b7217debf908dc132b58a2c18ad7e19df3', 'the hash assets/instruments/guitar/README.md records');
  assert.equal(sha256(Buffer.from(FUR_ELISE_MIDI_BASE64, 'base64')), 'c82120509bb3bec94baab0ab8857f33c72d3eff1d6bb971dcf4711e5916e78fd', 'the hash bundledSongs() records');
});
