/**
 * Chord identity, guitar voicings and suggested fingerings, melody positions, and the fretboard map derived from the supplied artwork. Each checked against
 * the music it must sound — a voicing's notes ARE its chord's pitch classes — or against the artwork's own geometry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MVP_CHORDS, chordTemplate, parseChord, soundsAs } from '../../src/music/chords.ts';
import { mirrored, targetOf, type FretboardMap } from '../../src/music/fretboard.ts';
import { OPEN_VOICINGS, STANDARD_TUNING, fingerMelody, openMidi, positionsOf, soundingKeys, voicingSoundsItsChord, type GuitarTuning } from '../../src/music/guitar.ts';
import { referenceFromMidi } from '../../src/music/reference.ts';
import { MAP, deriveFromArtwork } from '../../tools/guitar/derive-fretboard-map.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('a chord’s identity is its pitch classes: C is C E G, Am is A C E, F♯m is F♯ A C♯, B♭ is B♭ D F; anything else is no chord, never a guess', () => {
  assert.deepEqual(parseChord('C')?.pitchClasses, [0, 4, 7]);
  assert.deepEqual(parseChord('Am')?.pitchClasses, [9, 0, 4]);
  assert.deepEqual(parseChord('F#m')?.pitchClasses, [6, 9, 1]);
  assert.deepEqual(parseChord('Bb')?.pitchClasses, [10, 2, 5]);
  for (const bad of ['', 'H', 'Cmaj7', 'am', 'C#b', 'Am7']) assert.equal(parseChord(bad), null, bad);
  // identity, not voicing: any octave, any order, doubled notes
  assert.ok(soundsAs([64, 48, 55, 60, 76], parseChord('C') as NonNullable<ReturnType<typeof parseChord>>));
  assert.ok(!soundsAs([48, 52, 55, 58], parseChord('C') as NonNullable<ReturnType<typeof parseChord>>), 'C7 is not C');
  assert.deepEqual(chordTemplate(parseChord('Em') as NonNullable<ReturnType<typeof parseChord>>), [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1]);
});

test('every chord of the MVP has an open voicing that sounds exactly that chord in standard tuning — C x32010 is C E G C E', () => {
  assert.deepEqual([...MVP_CHORDS].sort(), Object.keys(OPEN_VOICINGS).sort());
  for (const symbol of MVP_CHORDS) {
    const v = OPEN_VOICINGS[symbol];
    assert.ok(v, symbol);
    assert.ok(voicingSoundsItsChord(v), `${symbol}: ${soundingKeys(v).join(' ')}`);
  }
  assert.deepEqual(soundingKeys(OPEN_VOICINGS['C'] as NonNullable<(typeof OPEN_VOICINGS)['C']>), [48, 52, 55, 60, 64]);
  assert.deepEqual(soundingKeys(OPEN_VOICINGS['Em'] as NonNullable<(typeof OPEN_VOICINGS)['Em']>), [40, 47, 52, 55, 59, 64]);
});

test('a suggested fingering is a playable suggestion: a finger on every fretted string and on nothing else, four fingers at most, within one hand span', () => {
  for (const v of Object.values(OPEN_VOICINGS)) {
    v.frets.forEach((fret, i) => {
      const finger = v.fingers[i];
      if (fret === null || fret === 0) assert.equal(finger, null, `${v.chord} string ${6 - i}: no finger on an open or muted string`);
      else assert.ok(finger !== null && finger !== undefined && finger >= 1 && finger <= 4, `${v.chord} string ${6 - i}`);
    });
    const fretted = v.frets.filter((f): f is number => f !== null && f > 0);
    assert.ok(Math.max(...fretted) - Math.min(...fretted) <= 3, `${v.chord}: within four frets`);
    assert.equal(v.frets.length, 6);
  }
});

test('a pitch has several places on the neck — E4 is string 1 open, string 2 fret 5, string 3 fret 9, string 4 fret 14 — so a heard pitch never says which was played', () => {
  assert.deepEqual(positionsOf(64), [{ string: 4, fret: 14 }, { string: 3, fret: 9 }, { string: 2, fret: 5 }, { string: 1, fret: 0 }]);
  assert.deepEqual(positionsOf(39), [], 'below the low E string: nowhere');
  const capo2: GuitarTuning = { ...STANDARD_TUNING, capo: 2 };
  assert.equal(openMidi(capo2, 6), 42);
  assert.deepEqual(positionsOf(42, capo2), [{ string: 6, fret: 0 }]);
});

test('Für Elise’s melody on guitar: moved an octave down — said, not hidden — it sits in first position, every note playable where it is suggested', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid')));
  const made = referenceFromMidi(bytes, { song: { id: 'fe', title: 'Für Elise', composer: null }, arrangement: { id: 'fe', version: 1, instrument: 'piano', part: 'full' }, provenance: { kind: 'midi-import', midi: { role: 'midi', fileName: 'x.mid', mediaType: 'audio/midi', sha256: 'x', bytes: 1 } } });
  assert.ok(made.ok);
  const melody = made.reference.notes.filter((n) => n.track === 1).map((n) => n.key);
  const fingering = fingerMelody(melody);
  assert.equal(fingering.octaveShift, -12);
  fingering.positions.forEach((p, i) => {
    assert.ok(p !== null, `note ${i}`);
    assert.equal(openMidi(STANDARD_TUNING, p.string) + p.fret, (melody[i] as number) - 12, `note ${i} sounds where it is suggested`);
    assert.ok(p.fret <= 4, `note ${i}: first position`);
    assert.ok(p.fret === 0 ? p.finger === null : p.finger !== null && p.finger >= 1 && p.finger <= 4);
  });
  // E4 D♯4 E4 …: string 1 open, then D♯4 on string 2, fret 4
  assert.deepEqual(fingering.positions.slice(0, 2).map((p) => [p?.string, p?.fret]), [[1, 0], [2, 4]]);
});

test('the fretboard map is the artwork’s geometry: regenerated, it is the committed map — 20 frets below the nut, inlays on 3 5 7 9 12 15 17, string 6 on the left', () => {
  const committed = JSON.parse(fs.readFileSync(MAP, 'utf8')) as FretboardMap;
  assert.deepEqual(deriveFromArtwork(), committed);
  assert.equal(committed.source.license, 'Pixabay Content License');
  assert.equal(committed.fretYs.length, 20);
  assert.deepEqual(committed.inlayFrets, [3, 5, 7, 9, 12, 15, 17], 'the dots the artwork draws fall on the frets guitars mark: the frets were counted right');
  assert.deepEqual(committed.strings.map((s) => s.string), [6, 5, 4, 3, 2, 1]);
  for (let i = 1; i < committed.strings.length; i++) assert.ok((committed.strings[i]?.bridge.x as number) > (committed.strings[i - 1]?.bridge.x as number));
  assert.equal(committed.targets.length, 6 * 21);
});

test('every target lies on its string, between the fret wires it belongs between; the left-handed map mirrors x and keeps strings, frets and heights', () => {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8')) as FretboardMap;
  for (const s of map.strings) {
    let lastY = -Infinity;
    for (let fret = 0; fret <= 20; fret++) {
      const at = targetOf(map, s.string, fret);
      assert.ok(at, `string ${s.string} fret ${fret}`);
      assert.ok(at.y > lastY, 'higher frets are further down the neck');
      lastY = at.y;
      if (fret > 0) {
        assert.ok(at.y > (fret === 1 ? map.nutY : (map.fretYs[fret - 2] as number)) && at.y < (map.fretYs[fret - 1] as number), `string ${s.string} fret ${fret} between its wires`);
        const along = (at.y - s.nut.y) / (s.bridge.y - s.nut.y);
        assert.ok(Math.abs(at.x - (s.nut.x + along * (s.bridge.x - s.nut.x))) < 0.01, 'on the string');
      }
    }
  }
  const left = mirrored(map);
  assert.match(left.orientation, /left-handed/);
  const [minX, , width] = map.source.viewBox;
  const a = targetOf(map, 6, 3) as { x: number; y: number };
  const b = targetOf(left, 6, 3) as { x: number; y: number };
  assert.deepEqual([b.y, Math.abs(a.x + b.x - (2 * minX + width)) < 1e-9], [a.y, true]);
});
