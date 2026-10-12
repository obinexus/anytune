/**
 * The guitar on screen, for Practise and Play: the supplied artwork turned horizontal, and beneath it the enlarged fretboard — the primary instructional
 * view — both drawn from one description of what to play now and what comes next.
 *
 *   The artwork   The supplied SVG is a guitar seen from the front, headstock up (its fretboard map: assets/instruments/guitar/fretboard-map.json). It is
 *                 not rotated by CSS: it is placed in an SVG whose viewBox is the guitar's horizontal bounds, under a coordinate transformation — for a
 *                 right-handed guitar, headstock left and body right; for a left-handed one, mirrored. The markers are placed in the artwork's own
 *                 coordinates, inside the same transformation, so they stay on the string and fret the map names — the PHYSICAL fret, capo included.
 *   The fretboard Drawn at one SVG unit per CSS pixel for the width it is given, so its labels keep their size: a narrow screen shows fewer frets — the
 *                 range the targets need — instead of a smaller board. High e on top, as in tablature; the nut left for a right-handed player, right for
 *                 a left-handed one; text is never mirrored. With a capo, the capo is the nut, and fret numbers count from it.
 *
 * Three kinds of number, never confused: a STRING number in a square beside its name (1 = high E … 6 = low E); a FRET number below the board; a FINGER
 * number in a filled circle on the marker's corner (1 index, 2 middle, 3 ring, 4 little). The NOTE name is on the marker itself — calculated from the tuning,
 * the capo and the fret, never copied. The target now is a solid marker ("Current"), the one after an outlined one ("Next"). An open-string target sits
 * beside the nut, its corner marked 0; a muted string of a chord is marked X. A chord shows all its positions at once, with its name.
 *
 * Positions and fingers are SUGGESTIONS — the microphone hears a pitch, never a hand — and every description says so.
 */
import { noteOf } from '../domain/pitch.ts';
import type { FretboardMap, Point } from '../music/fretboard.ts';
import { targetOf } from '../music/fretboard.ts';
import { openMidi, STANDARD_TUNING, type GuitarTuning, type StringNumber, type Voicing } from '../music/guitar.ts';

/** What to play: one note at a string and fret (counted from the capo), or a chord in a voicing. */
export type Shape =
  | { readonly kind: 'note'; readonly key: number; readonly string: StringNumber; readonly fret: number; readonly finger: number | null }
  | { readonly kind: 'chord'; readonly symbol: string; readonly voicing: Voicing };

export type Hand = 'right' | 'left';
export type MarkerKind = 'current' | 'next';

export const STRING_NAMES: Readonly<Record<StringNumber, string>> = { 1: 'high E', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'low E' };
const STRING_LABELS: Readonly<Record<StringNumber, string>> = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };
export const FINGER_NAMES: readonly string[] = ['', 'Index', 'Middle', 'Ring', 'Little'];
const ALL_STRINGS: readonly StringNumber[] = [1, 2, 3, 4, 5, 6];

/** A note's name as the learner reads it: D♯4, not D#4. */
export const noteName = (key: number): string => noteOf(key).label.replace('#', '♯');

/** The note a string sounds at a fret (counted from the capo), in a tuning — calculated, not looked up. */
export const keyAt = (tuning: GuitarTuning, string: StringNumber, fret: number): number => openMidi(tuning, string) + fret;

const stringText = (s: StringNumber): string => `${STRING_NAMES[s]} string`;
const fretText = (fret: number, capo: number): string => (fret === 0 ? (capo > 0 ? 'open at the capo (0)' : 'open (0)') : `fret ${fret}${capo > 0 ? ' above the capo' : ''}`);

/** One position of a shape: its string, fret, finger, and the note it sounds. */
interface Placed {
  readonly string: StringNumber;
  readonly fret: number;
  readonly finger: number | null;
  readonly key: number;
}

function placedOf(shape: Shape, tuning: GuitarTuning): Placed[] {
  if (shape.kind === 'note') return [{ string: shape.string, fret: shape.fret, finger: shape.finger, key: keyAt(tuning, shape.string, shape.fret) }];
  return shape.voicing.frets.flatMap((fret, i) => {
    const string = (6 - i) as StringNumber;
    return fret === null || fret === undefined ? [] : [{ string, fret, finger: shape.voicing.fingers[i] ?? null, key: keyAt(tuning, string, fret) }];
  });
}

const mutedOf = (shape: Shape): StringNumber[] => (shape.kind === 'note' ? [] : shape.voicing.frets.flatMap((fret, i) => (fret === null || fret === undefined ? [(6 - i) as StringNumber] : [])));

/** What to play, by name: the note (calculated from the tuning) or the chord. */
export function shapeName(shape: Shape | null, tuning: GuitarTuning = STANDARD_TUNING): string {
  if (shape === null) return '';
  return shape.kind === 'chord' ? shape.symbol : noteName(keyAt(tuning, shape.string, shape.fret));
}

/** "Play D♯4 — B string, fret 4." — or, for a chord, every string. */
export function instructionOf(shape: Shape | null, tuning: GuitarTuning = STANDARD_TUNING): string {
  if (shape === null) return '';
  if (shape.kind === 'note') return `Play ${shapeName(shape, tuning)} — ${stringText(shape.string)}, ${fretText(shape.fret, tuning.capo)}.`;
  const parts = placedOf(shape, tuning).map((p) => `${stringText(p.string)} ${fretText(p.fret, tuning.capo)}`);
  const muted = mutedOf(shape).map((s) => `${STRING_NAMES[s]} muted (X)`);
  return `Play the ${shape.symbol} chord — ${[...parts, ...muted].join(', ')}.`;
}

/** "Little finger (4)" — said apart from the note and the fret; a suggestion. */
export function fingerTextOf(shape: Shape | null): string {
  if (shape === null) return '';
  if (shape.kind === 'note') return shape.fret === 0 || shape.finger === null ? 'No finger: an open string' : `${FINGER_NAMES[shape.finger] ?? ''} finger (${shape.finger})`;
  const fingers = shape.voicing.fingers.flatMap((f, i) => (f === null || f === undefined ? [] : [`${(FINGER_NAMES[f] ?? '').toLowerCase()} (${f}) on the ${STRING_NAMES[(6 - i) as StringNumber]} string`]));
  return fingers.length === 0 ? 'No fingers: open strings only' : `Fingers: ${fingers.join(', ')}`;
}

/** Where a shape goes, in words — always a suggestion (kept for screens that say it in one line). */
export function shapeText(shape: Shape | null, tuning: GuitarTuning = STANDARD_TUNING): string {
  if (shape === null) return '';
  if (shape.kind === 'chord') {
    const v = shape.voicing;
    const parts = [6, 5, 4, 3, 2, 1].map((s, i) => {
      const fret = v.frets[i];
      return fret === null || fret === undefined ? `${STRING_LABELS[s as StringNumber]} muted` : fret === 0 ? `${STRING_LABELS[s as StringNumber]} open` : `${STRING_LABELS[s as StringNumber]} fret ${fret}${v.fingers[i] ? ` (finger ${v.fingers[i]})` : ''}`;
    });
    return `${shape.symbol}: ${parts.join(', ')} — a suggested fingering`;
  }
  void tuning;
  return shape.fret === 0
    ? `${stringText(shape.string)}, open — a suggestion`
    : `${stringText(shape.string)}, fret ${shape.fret}, ${(FINGER_NAMES[shape.finger ?? 0] ?? '').toLowerCase()} finger (${shape.finger ?? ''}) — a suggestion`;
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
  /** "nut", "capo" or "fret" for wires; "string" for strings */
  readonly kind: string;
  readonly key: string;
  readonly labelKey: string;
}

export interface StringLabel {
  readonly y: number;
  /** 1 … 6, in a square */
  readonly number: string;
  readonly boxX: number;
  readonly boxY: number;
  readonly numberX: number;
  /** e, B, G, D, A, E */
  readonly name: string;
  readonly nameX: number;
  readonly textY: number;
  readonly key: string;
  readonly numberKey: string;
  readonly nameKey: string;
}

/** A marker: a rounded box on the string, between its frets (or beside the nut for an open string), with the note name inside. */
export interface NoteMarker {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: MarkerKind;
  /** the note name: D♯4 */
  readonly text: string;
  readonly textX: number;
  readonly textY: number;
  readonly key: string;
  readonly textKey: string;
}

/** A finger number in a filled circle on a marker's corner — or 0 in a ring for an open string. */
export interface CornerBadge {
  readonly cx: number;
  readonly cy: number;
  readonly textY: number;
  readonly kind: MarkerKind;
  /** finger: 1–4; open: 0 */
  readonly role: string;
  readonly label: string;
  readonly key: string;
  readonly textKey: string;
}

export interface FretboardView {
  readonly width: number;
  readonly height: number;
  readonly viewBox: string;
  readonly hand: Hand;
  readonly strings: readonly FretboardLine[];
  readonly stringLabels: readonly StringLabel[];
  readonly frets: readonly FretboardLine[];
  readonly markers: readonly NoteMarker[];
  readonly badges: readonly CornerBadge[];
  /** the muted strings of a chord now: X beside the nut */
  readonly mutes: readonly { readonly x: number; readonly textY: number; readonly kind: MarkerKind; readonly key: string }[];
  /** the label of the fret-number row ("fret"), and the capo's label when there is one */
  readonly fretWord: { readonly x: number; readonly y: number };
  readonly capoLabel: { readonly text: string; readonly x: number; readonly y: number };
  readonly firstFret: number;
  readonly lastFret: number;
  /** "Play D♯4 — B string, fret 4." */
  readonly instruction: string;
  /** "Little finger (4)" */
  readonly fingerText: string;
  /** "D♯4", "E4" — the current and next targets by name */
  readonly currentName: string;
  readonly nextName: string;
  readonly nextInstruction: string;
  /** what the board shows, in words: the frets, the capo */
  readonly caption: string;
  readonly description: string;
}

/** The geometry, in CSS pixels. Labels: 18 px string names, 16 px numbers and note names — never scaled down. */
export const FRETBOARD = Object.freeze({ labelColumn: 46, openColumn: 54, rightPad: 12, top: 34, stringGap: 38, fretNumberRow: 34, minFretSpacing: 52, maxFrets: 12, minFrets: 3, markerHeight: 24, badgeRadius: 11 });

const markerWidth = (text: string, room: number): number => Math.min(room, Math.round(16 + 9.5 * [...text].length));

export function fretboardView(now: Shape | null, next: Shape | null, width: number, hand: Hand, tuning: GuitarTuning = STANDARD_TUNING): FretboardView {
  const g = FRETBOARD;
  const usable = Math.max(0, width - g.labelColumn - g.openColumn - g.rightPad);
  const count = Math.max(g.minFrets, Math.min(g.maxFrets, Math.floor(usable / g.minFretSpacing)));
  const spacing = Math.max(g.minFretSpacing, usable / count);
  const boardWidth = Math.round(g.labelColumn + g.openColumn + spacing * count + g.rightPad);
  const nowPlaced = now === null ? [] : placedOf(now, tuning);
  const nextPlaced = next === null ? [] : placedOf(next, tuning);
  // the window: from fret 1 when the targets fit; otherwise from the lowest fret pressed now (then next, as room allows)
  const used = [...nowPlaced, ...nextPlaced].filter((p) => p.fret > 0).map((p) => p.fret);
  const nowFrets = nowPlaced.filter((p) => p.fret > 0).map((p) => p.fret);
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
  const wireX = (k: number): number => nutX + spacing * k;
  const flip = (x: number): number => (hand === 'left' ? boardWidth - x : x);
  const yOf = (s: StringNumber): number => top + (s - 1) * g.stringGap;
  const r = (n: number): number => Math.round(n * 10) / 10;
  const capo = tuning.capo;

  const strings = ALL_STRINGS.map((s) => ({ x1: r(flip(nutX)), y1: yOf(s), x2: r(flip(wireX(count))), y2: yOf(s), label: '', labelX: 0, labelY: 0, kind: 'string', key: `string-${s}`, labelKey: `string-label-${s}` }));
  const stringLabels: StringLabel[] = ALL_STRINGS.map((s) => {
    const boxCentre = flip(14);
    return { y: yOf(s), number: String(s), boxX: r(boxCentre - 10), boxY: yOf(s) - 10, numberX: r(boxCentre), name: STRING_LABELS[s], nameX: r(flip(36)), textY: yOf(s) + 6, key: `string-box-${s}`, numberKey: `string-number-${s}`, nameKey: `string-name-${s}` };
  });
  const frets = Array.from({ length: count + 1 }, (_, k) => ({
    x1: r(flip(wireX(k))),
    y1: top - 8,
    x2: r(flip(wireX(k))),
    y2: bottom + 8,
    label: k === 0 ? '' : String(first + k - 1),
    labelX: r(flip(k === 0 ? 0 : (wireX(k - 1) + wireX(k)) / 2)),
    labelY: bottom + 28,
    kind: k === 0 && first === 1 ? (capo > 0 ? 'capo' : 'nut') : 'fret',
    key: `wire-${k}`,
    labelKey: `fret-label-${k}`,
  }));

  const markers: NoteMarker[] = [];
  const badges: CornerBadge[] = [];
  const nowSpots = new Set(nowPlaced.map((p) => `${p.string}:${p.fret}`));
  for (const [placed, kind] of [[nowPlaced, 'current'], [nextPlaced, 'next']] as const) {
    for (const p of placed) {
      // the next target at the very spot of the current one: the current marker says it
      if (kind === 'next' && nowSpots.has(`${p.string}:${p.fret}`)) continue;
      let centre: number;
      let room: number;
      if (p.fret === 0) {
        centre = g.labelColumn + g.openColumn / 2;
        room = g.openColumn - 6;
      } else {
        if (p.fret < first || p.fret > last) continue;
        const k = p.fret - first + 1;
        centre = (wireX(k - 1) + wireX(k)) / 2;
        room = spacing - 6;
      }
      const text = noteName(p.key);
      const w = markerWidth(text, room);
      const cx = flip(centre);
      const y = yOf(p.string);
      markers.push({ x: r(cx - w / 2), y: y - g.markerHeight / 2, width: w, height: g.markerHeight, kind, text, textX: r(cx), textY: y + 6, key: `${kind}-${p.string}-${p.fret}`, textKey: `${kind}-${p.string}-${p.fret}-note` });
      // the corner: a finger number in a filled circle — or 0 in a ring for an open string
      const corner = hand === 'left' ? cx - w / 2 + 2 : cx + w / 2 - 2;
      const role = p.fret === 0 ? 'open' : p.finger === null ? '' : 'finger';
      if (role !== '') badges.push({ cx: r(corner), cy: y - g.markerHeight / 2 - 2, textY: y - g.markerHeight / 2 + 4, kind, role, label: p.fret === 0 ? '0' : String(p.finger), key: `${kind}-${p.string}-${p.fret}-badge`, textKey: `${kind}-${p.string}-${p.fret}-badge-text` });
    }
  }
  const mutes = now === null ? [] : mutedOf(now).map((s) => ({ x: r(flip(g.labelColumn + g.openColumn / 2)), textY: yOf(s) + 7, kind: 'current' as const, key: `current-${s}-muted` }));

  const range = first === last ? `fret ${first}` : `frets ${first} to ${last}`;
  const caption = `${hand === 'left' ? 'Left' : 'Right'}-handed, ${range}${capo > 0 ? `, counted from the capo at fret ${capo}` : ''}${first > 1 ? ' (the nut is off to the side)' : ''}`;
  const currentName = shapeName(now, tuning);
  const nextName = shapeName(next, tuning);
  const instruction = instructionOf(now, tuning);
  const nextInstruction = instructionOf(next, tuning).replace(/^Play /, '');
  const fingerText = fingerTextOf(now);
  const parts = [now === null ? '' : `Current: ${instruction} ${fingerText} — a suggestion.`, next === null ? '' : `Next: ${nextInstruction}`].filter((p) => p !== '');
  return {
    width: boardWidth,
    height,
    viewBox: `0 0 ${boardWidth} ${height}`,
    hand,
    strings,
    stringLabels,
    frets,
    markers,
    badges,
    mutes,
    fretWord: { x: r(flip(g.labelColumn / 2)), y: bottom + 28 },
    capoLabel: { text: capo > 0 && first === 1 ? `Capo ${capo}` : '', x: r(flip(nutX)), y: 14 },
    firstFret: first,
    lastFret: last,
    instruction,
    fingerText,
    currentName,
    nextName,
    nextInstruction,
    caption,
    description: `Fretboard, ${caption}.${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`,
  };
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

export function artworkView(map: FretboardMap, url: string, now: Shape | null, next: Shape | null, hand: Hand, window: { first: number; last: number }, tuning: GuitarTuning = STANDARD_TUNING): ArtworkView {
  const [, , w, h] = map.source.viewBox;
  const capo = tuning.capo;
  const markers: ArtworkMarker[] = [];
  for (const [shape, kind] of [[now, 'current'], [next, 'next']] as const) {
    if (shape === null) continue;
    for (const p of placedOf(shape, tuning)) {
      // the physical fret: the capo's, plus the fret above it
      const at = targetOf(map, p.string, capo + p.fret);
      if (at !== null) markers.push({ x: at.x, y: at.y, kind, key: `${kind}-${p.string}-${p.fret}` });
    }
  }
  const physFirst = capo + window.first;
  const physLast = capo + window.last;
  const y1 = physFirst <= 1 ? map.nutY - 40 : (map.fretYs[physFirst - 2] ?? map.nutY);
  const y2 = map.fretYs[Math.min(physLast, map.fretYs.length) - 1] ?? map.nutY;
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
export function guitarView(map: FretboardMap, url: string, now: Shape | null, next: Shape | null, width: number, hand: Hand, tuning: GuitarTuning = STANDARD_TUNING): GuitarView {
  const fretboard = fretboardView(now, next, width, hand, tuning);
  return { fretboard, artwork: artworkView(map, url, now, next, hand, { first: fretboard.firstFret, last: fretboard.lastFret }, tuning) };
}
