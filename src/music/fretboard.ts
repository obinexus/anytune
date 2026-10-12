/**
 * Where a guitar's strings and frets are on a drawing: a FRETBOARD MAP, derived once from the artwork's geometry (tools/guitar/derive-fretboard-map.ts) and
 * kept beside it as data (assets/instruments/guitar/fretboard-map.json). The drawing code reads targets from the map; it never computes music, and the music
 * model never reads the drawing. The map names strings by number and frets by count — never by the order of elements in the SVG.
 *
 * Orientation is explicit. The supplied artwork is a guitar seen from the front, headstock up; for a right-handed guitar, string 6 (low E) is then on the
 * viewer's left. A left-handed view mirrors the map horizontally (`mirrored`), and says so — labels follow the strings, not the side.
 */
import type { StringNumber } from './guitar.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface FretboardMap {
  readonly format: 'anytune-fretboard-map/1';
  readonly source: { readonly file: string; readonly sha256: string; readonly viewBox: readonly [number, number, number, number]; readonly author: string; readonly license: string; readonly url: string };
  readonly orientation: 'right-handed, front view, headstock up' | 'left-handed (mirrored), front view, headstock up';
  /** the nut's y, and each fret wire's, fret 1 first */
  readonly nutY: number;
  readonly fretYs: readonly number[];
  /** the frets marked by inlays on the artwork */
  readonly inlayFrets: readonly number[];
  /** each string's line: at the nut, and at the bridge */
  readonly strings: readonly { readonly string: StringNumber; readonly nut: Point; readonly bridge: Point }[];
  /** where a finger goes for each string and fret (fret 0: the open string, drawn just above the nut) */
  readonly targets: readonly { readonly string: StringNumber; readonly fret: number; readonly at: Point }[];
}

export function targetOf(map: FretboardMap, string: StringNumber, fret: number): Point | null {
  return map.targets.find((t) => t.string === string && t.fret === fret)?.at ?? null;
}

/** The same map for a left-handed guitar: mirrored about the artwork's vertical centre. */
export function mirrored(map: FretboardMap): FretboardMap {
  const [minX, , width] = map.source.viewBox;
  const flip = (p: Point): Point => ({ x: 2 * minX + width - p.x, y: p.y });
  return {
    ...map,
    orientation: 'left-handed (mirrored), front view, headstock up',
    strings: map.strings.map((s) => ({ ...s, nut: flip(s.nut), bridge: flip(s.bridge) })),
    targets: map.targets.map((t) => ({ ...t, at: flip(t.at) })),
  };
}
