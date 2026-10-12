/**
 * The guitar on screen (src/app/guitar-view.ts): the supplied artwork turned horizontal by a coordinate transformation — the markers under the same one,
 * checked to stay on their string and between their fret wires for every string and fret the map has, for both hands — and the enlarged fretboard, drawn
 * at one unit per CSS pixel: on a phone it shows the frets the targets need, never smaller labels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artworkPoint, artworkView, fretboardView, FRETBOARD, guitarView, keyAt, shapeText, type Hand, type Shape } from '../../src/app/guitar-view.ts';
import type { FretboardMap } from '../../src/music/fretboard.ts';
import { OPEN_VOICINGS, STANDARD_TUNING, type StringNumber } from '../../src/music/guitar.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MAP: FretboardMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'instruments', 'guitar', 'fretboard-map.json'), 'utf8'));
const [, , W, H] = MAP.source.viewBox;
const note = (key: number, string: StringNumber, fret: number, finger: number | null = null): Shape => ({ kind: 'note', key, string, fret, finger });

test('the artwork, horizontal: its view is the guitar\'s turned bounds; right-handed, the headstock is left and the body right; left-handed, mirrored', () => {
  const right = artworkView(MAP, 'data:', null, null, 'right', { first: 1, last: 4 });
  assert.equal(right.viewBox, `0 0 ${H} ${W}`, 'wider than tall: no vertical layout box left behind');
  assert.deepEqual([right.imageWidth, right.imageHeight], [W, H]);
  const headstock = { x: W / 2, y: 0 };
  const body = { x: W / 2, y: H };
  for (const [hand, headstockSide] of [['right', 'left'], ['left', 'right']] as const) {
    const a = artworkPoint(MAP, hand, headstock);
    const b = artworkPoint(MAP, hand, body);
    assert.equal(a.x < b.x, headstockSide === 'left', `${hand}-handed: the headstock is ${headstockSide}`);
    // the whole artwork lands inside the view: no clipping
    for (const corner of [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: 0, y: H }, { x: W, y: H }]) {
      const p = artworkPoint(MAP, hand, corner);
      assert.ok(p.x >= -1e-9 && p.x <= H + 1e-9 && p.y >= -1e-9 && p.y <= W + 1e-9, `${hand}: ${JSON.stringify(corner)} → ${JSON.stringify(p)}`);
    }
  }
});

test('every marker stays attached after the turn, for both hands: on its own string (the nearest line), between its fret wires, high e on top', () => {
  for (const hand of ['right', 'left'] as Hand[]) {
    for (const t of MAP.targets) {
      const p = artworkPoint(MAP, hand, t.at);
      // between its fret wires, along the turned neck
      const wire = (f: number): number => artworkPoint(MAP, hand, { x: W / 2, y: f === 0 ? MAP.nutY : (MAP.fretYs[f - 1] as number) }).x;
      if (t.fret >= 1) {
        const [lo, hi] = [wire(t.fret - 1), wire(t.fret)].sort((a, b) => a - b) as [number, number];
        assert.ok(p.x > lo && p.x < hi, `${hand}: string ${t.string} fret ${t.fret} at x ${p.x} is not between ${lo} and ${hi}`);
      } else {
        // an open string is drawn just beyond the nut, on the headstock side
        assert.ok(hand === 'right' ? p.x < wire(0) : p.x > wire(0), `${hand}: open string ${t.string}`);
      }
      // on its own string: the nearest of the six turned string lines at that point of the neck
      const sourceY = t.at.y;
      const distances = MAP.strings.map((s) => {
        const k = (sourceY - s.nut.y) / (s.bridge.y - s.nut.y);
        const onLine = artworkPoint(MAP, hand, { x: s.nut.x + k * (s.bridge.x - s.nut.x), y: sourceY });
        return { string: s.string, d: Math.abs(onLine.y - p.y) };
      });
      const nearest = distances.reduce((a, b) => (b.d < a.d ? b : a));
      assert.equal(nearest.string, t.string, `${hand}: fret ${t.fret}, string ${t.string} is nearest string ${nearest.string}`);
    }
    // high e above low E, at every fret
    for (let fret = 0; fret <= 12; fret++) {
      const e = MAP.targets.find((t) => t.string === 1 && t.fret === fret);
      const lowE = MAP.targets.find((t) => t.string === 6 && t.fret === fret);
      if (e === undefined || lowE === undefined) continue;
      assert.ok(artworkPoint(MAP, hand, e.at).y < artworkPoint(MAP, hand, lowE.at).y, `${hand}, fret ${fret}`);
    }
  }
});

test('the artwork\'s markers are in its own coordinates, drawn under the same transformation as the image; the window outlines the frets the fretboard shows', () => {
  const view = guitarView(MAP, 'data:', note(63, 2, 4, 4), note(64, 1, 0), 328, 'right');
  const at = (string: number, fret: number) => MAP.targets.find((t) => t.string === string && t.fret === fret)?.at;
  assert.deepEqual(view.artwork.markers.map((m) => [m.kind, m.x, m.y]), [['current', at(2, 4)?.x, at(2, 4)?.y], ['next', at(1, 0)?.x, at(1, 0)?.y]]);
  assert.equal(view.artwork.transform, 'matrix(0 -1 1 0 0 774.83)');
  const win = view.artwork.window;
  assert.ok(win.y < MAP.nutY && win.y + win.height >= (MAP.fretYs[view.fretboard.lastFret - 1] as number) - 1, 'from before the nut to the last fret shown');
});

test('the fretboard on a phone (328 px): frets 1–4 at one unit per pixel, labels kept their size — and the range follows a target further up the neck', () => {
  const phone = fretboardView(note(64, 1, 0), note(63, 2, 4, 4), 328, 'right');
  assert.equal(phone.width <= 328, true, 'fits the width it was given');
  assert.equal(phone.viewBox, `0 0 ${phone.width} ${phone.height}`, 'one unit per CSS pixel: nothing is scaled');
  assert.deepEqual([phone.firstFret, phone.lastFret], [1, 4]);
  assert.deepEqual(phone.frets.map((f) => f.label), ['', '1', '2', '3', '4']);
  assert.equal(phone.frets[0]?.kind, 'nut');
  const spacing = (phone.frets[2]?.x1 ?? 0) - (phone.frets[1]?.x1 ?? 0);
  assert.ok(spacing >= FRETBOARD.minFretSpacing, `a fret is at least ${FRETBOARD.minFretSpacing} px wide (${spacing})`);
  // a target at fret 7: the window moves to include it
  const high = fretboardView(note(71, 1, 7, 1), null, 328, 'right');
  assert.ok(high.firstFret <= 7 && high.lastFret >= 7, `${high.firstFret}–${high.lastFret}`);
  assert.equal(high.frets[0]?.kind, 'fret', 'the nut is not shown when the window starts further up');
  assert.match(high.caption, /frets \d+ to \d+ \(the nut is off to the side\)/);
  // a desktop: twelve frets
  const wide = fretboardView(null, null, 900, 'right');
  assert.deepEqual([wide.firstFret, wide.lastFret], [1, 12]);
});

test('D♯4 on the B string, fret 4: the note name on the marker, the little finger (4) said apart, "Play D♯4 — B string, fret 4." — and the next note outlined, named', () => {
  const view = fretboardView(note(63, 2, 4, 4), note(64, 1, 0), 328, 'right');
  assert.equal(view.instruction, 'Play D♯4 — B string, fret 4.');
  assert.equal(view.fingerText, 'Little finger (4)');
  assert.deepEqual([view.currentName, view.nextName], ['D♯4', 'E4']);
  // the current marker: solid, on string 2 between frets 3 and 4, its text the note — the finger in a circle on its corner, never the marker's text
  const current = view.markers.find((m) => m.kind === 'current');
  assert.ok(current !== undefined);
  assert.equal(current.text, 'D♯4');
  assert.equal(current.y + current.height / 2, view.strings[1]?.y1, 'on the B string');
  const [fret3, fret4] = [view.frets[3]?.x1 ?? 0, view.frets[4]?.x1 ?? 0];
  assert.ok(current.textX > fret3 && current.textX < fret4, 'between the third and fourth fret wires');
  assert.deepEqual(view.badges.filter((b) => b.kind === 'current').map((b) => [b.role, b.label]), [['finger', '4']]);
  // the next one: an open string, beside the nut, named, its corner 0
  const next = view.markers.find((m) => m.kind === 'next');
  assert.equal(next?.text, 'E4');
  assert.ok((next?.textX ?? 0) < (view.frets[0]?.x1 ?? 0), 'beside the nut');
  assert.deepEqual(view.badges.filter((b) => b.kind === 'next').map((b) => [b.role, b.label]), [['open', '0']]);
  assert.equal(view.nextInstruction, 'E4 — high E string, open (0).');
  // the three kinds of number: strings in squares (1 = high E … 6 = low E), frets below, fingers on corners
  assert.deepEqual(view.stringLabels.map((l) => `${l.number}${l.name}`), ['1e', '2B', '3G', '4D', '5A', '6E']);
  assert.ok((view.strings[0]?.y1 ?? 0) < (view.strings[5]?.y1 ?? 0), 'high e on top');
  assert.ok(view.frets.every((f) => f.labelY > (view.strings[5]?.y1 ?? 0)), 'fret numbers below the board');
  assert.match(view.description, /Current: Play D♯4 — B string, fret 4\. Little finger \(4\) — a suggestion\. Next: E4 — high E string, open \(0\)\./);
});

test('a chord: all its positions at once, each with its note, its name said; open strings beside the nut marked 0, the muted string X', () => {
  const c = fretboardView({ kind: 'chord', symbol: 'C', voicing: OPEN_VOICINGS['C'] as never }, null, 328, 'right');
  assert.equal(c.currentName, 'C');
  assert.deepEqual(c.markers.map((m) => m.text), ['C3', 'E3', 'G3', 'C4', 'E4'], 'x32010: the notes the strings sound, low to high');
  assert.deepEqual(c.badges.map((b) => b.label), ['3', '2', '0', '1', '0'], 'fingers 3 2 1; the open G and e marked 0');
  assert.deepEqual(c.mutes.map((m) => m.textY - 7), [c.strings[5]?.y1], 'the low E muted');
  assert.equal(c.instruction, 'Play the C chord — A string fret 3, D string fret 2, G string open (0), B string fret 1, high E string open (0), low E muted (X).');
  assert.equal(c.fingerText, 'Fingers: ring (3) on the A string, middle (2) on the D string, index (1) on the B string');
  assert.match(shapeText({ kind: 'chord', symbol: 'C', voicing: OPEN_VOICINGS['C'] as never }), /^C: E muted, A fret 3 \(finger 3\), D fret 2 \(finger 2\), G open, B fret 1 \(finger 1\), e open — a suggested fingering$/);
});

test('a capo: the notes are calculated from the tuning and the capo — fret numbers count from the capo, the artwork marks the physical fret', () => {
  const capo2 = { ...STANDARD_TUNING, capo: 2 };
  assert.equal(keyAt(capo2, 1, 0), 66);
  const view = fretboardView(note(66, 1, 0), note(65, 2, 4, 4), 328, 'right', capo2);
  assert.deepEqual(view.markers.map((m) => m.text), ['F♯4', 'F4'], 'the open e with a capo at 2 sounds F♯4; the B string at fret 4 above it, F4');
  assert.equal(view.instruction, 'Play F♯4 — high E string, open at the capo (0).');
  assert.equal(view.nextInstruction, 'F4 — B string, fret 4 above the capo.');
  assert.equal(view.frets[0]?.kind, 'capo');
  assert.equal(view.capoLabel.text, 'Capo 2');
  assert.match(view.caption, /counted from the capo at fret 2/);
  const art = guitarView(MAP, 'data:', note(66, 1, 0), null, 328, 'right', capo2).artwork;
  assert.deepEqual([art.markers[0]?.x, art.markers[0]?.y], [MAP.targets.find((t) => t.string === 1 && t.fret === 2)?.at.x, MAP.targets.find((t) => t.string === 1 && t.fret === 2)?.at.y], 'at the physical second fret');
});

test('left-handed: the board mirrored — the nut and the string names on the right, the frets counting leftwards — and no text mirrored', () => {
  const right = fretboardView(note(63, 2, 4, 4), null, 328, 'right');
  const left = fretboardView(note(63, 2, 4, 4), null, 328, 'left');
  assert.ok((left.stringLabels[0]?.nameX ?? 0) > left.width / 2 && (right.stringLabels[0]?.nameX ?? 0) < right.width / 2);
  const leftFrets = left.frets.slice(1).map((f) => f.labelX);
  assert.deepEqual([...leftFrets].sort((a, b) => b - a), leftFrets, 'fret 1 is rightmost');
  assert.ok(Math.abs((left.markers[0]?.textX ?? 0) - (right.width - (right.markers[0]?.textX ?? 0))) <= 0.11, 'the marker mirrored about the board');
  assert.equal(left.markers[0]?.text, 'D♯4', 'the text itself is not mirrored');
});
