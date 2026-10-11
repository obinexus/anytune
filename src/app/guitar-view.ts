/**
 * The guitar on screen, for Practise and Play: the supplied artwork turned horizontal, and beneath it the enlarged fretboard — the primary instructional
 * view — both drawn from one description of what to play now and what comes next.
 *
 *   The artwork   The supplied SVG is a guitar seen from the front, headstock up (its fretboard map: assets/instruments/guitar/fretboard-map.json). It is
 *                 not rotated by CSS: it is placed in an SVG whose viewBox is the guitar's horizontal bounds, under a coordinate transformation — for a
 *                 right-handed guitar, headstock left and body right; for a left-handed one, mirrored. The markers are placed in the artwork's own
 *                 coordinates, inside the same transformation, so they stay on the string and fret the map names.
 *   The fretboard Drawn at one SVG unit per CSS pixel for the width it is given, so its labels keep their size (18 px string names, 16 px numbers): a narrow
 *                 screen shows fewer frets — the range the targets need — instead of a smaller board. High e on top, as in tablature; the nut left for a
 *                 right-handed player, right for a left-handed one; text is never mirrored.
 *
 * What it shows: the target now (a filled marker with its suggested finger), the next one (a dashed outline), open (○) and muted (×) strings. Positions and
 * fingers are SUGGESTIONS — the microphone hears a pitch, never a hand — and every description says so.
 */
import { noteOf } from '../domain/pitch.ts';
import type { FretboardMap, Point } from '../music/fretboard.ts';
import { targetOf } from '../music/fretboard.ts';
import type { StringNumber, Voicing } from '../music/guitar.ts';

/** What to play: one note at a string and fret, or a chord in a voicing. */
export type Shape =
  | { readonly kind: 'note'; readonly key: number; readonly string: StringNumber; readonly fret: number; readonly finger: number | null }
  | { readonly kind: 'chord'; readonly symbol: string; readonly voicing: Voicing };

export type Hand = 'right' | 'left';
export type MarkerKind = 'now' | 'next';

const STRING_NAMES: Readonly<Record<StringNumber, string>> = { 1: 'high E', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'low E' };
const STRING_LABELS: Readonly<Record<StringNumber, string>> = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };
const FINGER_NAMES = ['', 'index', 'middle', 'ring', 'little'];
const ALL_STRINGS: readonly StringNumber[] = [1, 2, 3, 4, 5, 6];

/** Where a note goes, in words — always a suggestion. */
export function shapeText(shape: Shape | null): string {
  if (shape === null) return '';
  if (shape.kind === 'chord') {
    const v = shape.voicing;
    const parts = [6, 5, 4, 3, 2, 1].map((s, i) => {
      const fret = v.frets[i];
      return fret === null || fret === undefined ? `${STRING_LABELS[s as StringNumber]} muted` : fret === 0 ? `${STRING_LABELS[s as StringNumber]} open` : `${STRING_LABELS[s as StringNumber]} fret ${fret}${v.fingers[i] ? ` (finger ${v.fingers[i]})` : ''}`;
    });
    return `${shape.symbol}: ${parts.join(', ')} — a suggested fingering`;
  }
  return shape.fret === 0
    ? `${STRING_NAMES[shape.string]} string, open — a suggestion`
    : `${STRING_NAMES[shape.string]} string, fret ${shape.fret}, ${FINGER_NAMES[shape.finger ?? 0] ?? ''} finger (${shape.finger ?? ''}) — a suggestion`;
}

export const shapeName = (shape: Shape | null): string => (shape === null ? '' : shape.kind === 'chord' ? shape.symbol : noteOf(shape.key).label);

/** Every string and fret a shape presses (fret ≥ 1), with its suggested finger. */
function fretted(shape: Shape): { string: StringNumber; fret: number; finger: number | null }[] {
  if (shape.kind === 'note') return shape.fret > 0 ? [{ string: shape.string, fret: shape.fret, finger: shape.finger }] : [];
  return shape.voicing.frets.flatMap((fret, i) => (fret !== null && fret !== undefined && fret > 0 ? [{ string: (6 - i) as StringNumber, fret, finger: shape.voicing.fingers[i] ?? null }] : []));
}

/** Each string's open (0) or muted (null) state in a shape; strings a single note does not use are neither. */
function openOrMuted(shape: Shape): { string: StringNumber; state: 'open' | 'muted' }[] {
  if (shape.kind === 'note') return shape.fret === 0 ? [{ string: shape.string, state: 'open' }] : [];
  return shape.voicing.frets.flatMap((fret, i): { string: StringNumber; state: 'open' | 'muted' }[] => (fret === 0 ? [{ string: (6 - i) as StringNumber, state: 'open' }] : fret === null || fret === undefined ? [{ string: (6 - i) as StringNumber, state: 'muted' }] : []));
}

// ------------------------------------------------------------------------------------------------------------------------------------ the fretboard

export interface FretboardLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly label: string;
  readonly labelX: number;
  readonly labelY: number;
  /** "nut" for the nut, "fret" otherwise; "string" for strings */
  readonly kind: string;
  readonly key: string;
  readonly labelKey: string;
}

export interface FretboardMarker {
  readonly x: number;
  readonly y: number;
  readonly textY: number;
  readonly kind: MarkerKind;
  /** the suggested finger number, or "" */
  readonly label: string;
  readonly key: string;
  readonly labelKey: string;
}

export interface StringMark {
  readonly x: number;
  readonly y: number;
  readonly textY: number;
  readonly kind: MarkerKind;
  /** open or muted */
  readonly state: string;
  /** ○ or × */
  readonly label: string;
  readonly key: string;
}

export interface FretboardView {
  readonly width: number;
  readonly height: number;
  readonly viewBox: string;
  readonly hand: Hand;
  readonly strings: readonly FretboardLine[];
  readonly frets: readonly FretboardLine[];
  readonly markers: readonly FretboardMarker[];
  readonly marks: readonly StringMark[];
  /** the first and last fret shown */
  readonly firstFret: number;
  readonly lastFret: number;
  /** what the board shows, in words: the frets, now and next */
  readonly caption: string;
  readonly description: string;
}

/** The geometry, in CSS pixels. Labels: 18 px string names, 16 px fret and finger numbers — never scaled down. */
export const FRETBOARD = Object.freeze({ labelColumn: 34, openColumn: 34, rightPad: 14, top: 26, stringGap: 34, fretNumberRow: 34, minFretSpacing: 56, maxFrets: 12, minFrets: 3, markerRadius: 15 });

export function fretboardView(now: Shape | null, next: Shape | null, width: number, hand: Hand): FretboardView {
  const g = FRETBOARD;
  const usable = Math.max(0, width - g.labelColumn - g.openColumn - g.rightPad);
  const count = Math.max(g.minFrets, Math.min(g.maxFrets, Math.floor(usable / g.minFretSpacing)));
  const spacing = Math.max(g.minFretSpacing, usable / count);
  const boardWidth = Math.round(g.labelColumn + g.openColumn + spacing * count + g.rightPad);
  // the window: from fret 1 when the targets fit; otherwise from the lowest fret pressed now (then next, as room allows)
  const used = [now, next].flatMap((s) => (s === null ? [] : fretted(s).map((f) => f.fret)));
  const nowFrets = now === null ? [] : fretted(now).map((f) => f.fret);
  let first = 1;
  if (used.length > 0 && Math.max(...used) > count) {
    const low = Math.min(...(nowFrets.length > 0 ? nowFrets : used));
    first = Math.max(1, Math.min(low, Math.max(...used) - count + 1));
  }
  const last = first + count - 1;
  const top = g.top;
  const bottom = top + 5 * g.stringGap;
  const height = bottom + g.fretNumberRow;
  const nutX = g.labelColumn + g.openColumn;
  const wireX = (k: number): number => nutX + spacing * k; // k = 0 … count: the wires bounding the window's frets
  const flip = (x: number): number => (hand === 'left' ? boardWidth - x : x);
  const yOf = (s: StringNumber): number => top + (s - 1) * g.stringGap;
  const r = (n: number): number => Math.round(n * 10) / 10;

  const strings = ALL_STRINGS.map((s) => ({ x1: r(flip(nutX)), y1: yOf(s), x2: r(flip(wireX(count))), y2: yOf(s), label: STRING_LABELS[s], labelX: r(flip(g.labelColumn / 2)), labelY: yOf(s) + 6, kind: 'string', key: `string-${s}`, labelKey: `string-label-${s}` }));
  const frets = Array.from({ length: count + 1 }, (_, k) => ({
    x1: r(flip(wireX(k))),
    y1: top - 6,
    x2: r(flip(wireX(k))),
    y2: bottom + 6,
    label: k === 0 ? '' : String(first + k - 1),
    labelX: r(flip(k === 0 ? 0 : (wireX(k - 1) + wireX(k)) / 2)),
    labelY: bottom + 28,
    kind: k === 0 && first === 1 ? 'nut' : 'fret',
    key: `wire-${k}`,
    labelKey: `fret-label-${k}`,
  }));
  const markers: FretboardMarker[] = [];
  const marks: StringMark[] = [];
  for (const [shape, kind] of [[now, 'now'], [next, 'next']] as const) {
    if (shape === null) continue;
    for (const f of fretted(shape)) {
      if (f.fret < first || f.fret > last) continue;
      const k = f.fret - first + 1;
      const x = r(flip((wireX(k - 1) + wireX(k)) / 2));
      markers.push({ x, y: yOf(f.string), textY: yOf(f.string) + 6, kind, label: f.finger === null ? '' : String(f.finger), key: `${kind}-${f.string}-${f.fret}`, labelKey: `${kind}-${f.string}-${f.fret}-finger` });
    }
    // open and muted strings are marked in the column before the nut — for the target now; the next one's are said in words
    if (kind === 'now') for (const m of openOrMuted(shape)) marks.push({ x: r(flip(g.labelColumn + g.openColumn / 2)), y: yOf(m.string), textY: yOf(m.string) + 6, kind, state: m.state, label: m.state === 'open' ? '○' : '×', key: `${kind}-${m.string}-${m.state}` });
    if (kind === 'next' && shape.kind === 'note' && shape.fret === 0) marks.push({ x: r(flip(g.labelColumn + g.openColumn / 2)), y: yOf(shape.string), textY: yOf(shape.string) + 6, kind, state: 'open', label: '○', key: `next-${shape.string}-open` });
  }
  const range = first === last ? `fret ${first}` : `frets ${first} to ${last}`;
  const caption = `${hand === 'left' ? 'Left' : 'Right'}-handed, ${range}${first > 1 ? ' (the nut is off to the side)' : ''}`;
  const parts = [now === null ? '' : `Now: ${shapeName(now)}, ${shapeText(now)}`, next === null ? '' : `Next: ${shapeName(next)}, ${shapeText(next)}`].filter((p) => p !== '');
  return { width: boardWidth, height, viewBox: `0 0 ${boardWidth} ${height}`, hand, strings, frets, markers, marks, firstFret: first, lastFret: last, caption, description: `Fretboard, ${caption}.${parts.length > 0 ? ` ${parts.join('. ')}.` : ''}` };
}

// -------------------------------------------------------------------------------------------------------------------------------------- the artwork

export interface ArtworkMarker {
  readonly x: number;
  readonly y: number;
  readonly kind: MarkerKind;
  readonly key: string;
}

export interface ArtworkView {
  readonly url: string;
  /** the horizontal guitar's bounds */
  readonly viewBox: string;
  readonly width: number;
  readonly height: number;
  /** the supplied (vertical) artwork's size, placed under `transform` */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** from the artwork's coordinates to the horizontal view's */
  readonly transform: string;
  readonly hand: Hand;
  /** in the artwork's own coordinates (they are drawn under `transform`) */
  readonly markers: readonly ArtworkMarker[];
  /** the frets the enlarged fretboard shows, outlined on the guitar — artwork coordinates */
  readonly window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly credit: string;
}

/** The transformation of the artwork's point (x, y) — headstock up — into the horizontal view: [a, b, c, d, e, f] of an SVG matrix. */
export function artworkMatrix(map: FretboardMap, hand: Hand): readonly [number, number, number, number, number, number] {
  const [, , w, h] = map.source.viewBox;
  // right-handed: turned a quarter anticlockwise — the headstock (top) goes left, string 6 (the viewer's left) goes to the bottom: x' = y, y' = w − x
  // left-handed: that, mirrored left to right: x' = h − y
  return hand === 'right' ? [0, -1, 1, 0, 0, w] : [0, -1, -1, 0, h, w];
}

/** A point of the artwork, where it is drawn in the horizontal view. */
export function artworkPoint(map: FretboardMap, hand: Hand, p: Point): Point {
  const [a, b, c, d, e, f] = artworkMatrix(map, hand);
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

/** A string's x across the artwork at height y (the strings converge towards the nut). */
function stringXAt(map: FretboardMap, s: StringNumber, y: number): number {
  const line = map.strings.find((l) => l.string === s);
  if (line === undefined) return 0;
  const t = (y - line.nut.y) / (line.bridge.y - line.nut.y);
  return line.nut.x + t * (line.bridge.x - line.nut.x);
}

export function artworkView(map: FretboardMap, url: string, now: Shape | null, next: Shape | null, hand: Hand, window: { first: number; last: number }): ArtworkView {
  const [, , w, h] = map.source.viewBox;
  const markers: ArtworkMarker[] = [];
  for (const [shape, kind] of [[now, 'now'], [next, 'next']] as const) {
    if (shape === null) continue;
    const points = shape.kind === 'note' ? [{ string: shape.string, fret: shape.fret }] : shape.voicing.frets.flatMap((fret, i) => (fret === null || fret === undefined ? [] : [{ string: (6 - i) as StringNumber, fret }]));
    for (const p of points) {
      const at = targetOf(map, p.string, p.fret);
      if (at !== null) markers.push({ x: at.x, y: at.y, kind, key: `${kind}-${p.string}-${p.fret}` });
    }
  }
  const y1 = window.first <= 1 ? map.nutY - 40 : (map.fretYs[window.first - 2] ?? map.nutY);
  const y2 = map.fretYs[Math.min(window.last, map.fretYs.length) - 1] ?? map.nutY;
  const x1 = Math.min(stringXAt(map, 6, y2), stringXAt(map, 1, y2), stringXAt(map, 6, y1), stringXAt(map, 1, y1)) - 22;
  const x2 = Math.max(stringXAt(map, 6, y2), stringXAt(map, 1, y2), stringXAt(map, 6, y1), stringXAt(map, 1, y1)) + 22;
  return {
    url,
    viewBox: `0 0 ${h} ${w}`,
    width: h,
    height: w,
    imageWidth: w,
    imageHeight: h,
    transform: `matrix(${artworkMatrix(map, hand).join(' ')})`,
    hand,
    markers,
    window: { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) },
    credit: `Guitar artwork: “Guitar, Music, Musical Instrument” by ${map.source.author}, ${map.source.license}`,
  };
}

export interface GuitarView {
  readonly artwork: ArtworkView;
  readonly fretboard: FretboardView;
}

/** Both views of one moment: the fretboard sized for `width` CSS pixels, the artwork outlining the frets it shows. */
export function guitarView(map: FretboardMap, url: string, now: Shape | null, next: Shape | null, width: number, hand: Hand): GuitarView {
  const fretboard = fretboardView(now, next, width, hand);
  return { fretboard, artwork: artworkView(map, url, now, next, hand, { first: fretboard.firstFret, last: fretboard.lastFret }) };
}
