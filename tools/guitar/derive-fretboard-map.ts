/**
 * Derives the fretboard map (assets/instruments/guitar/fretboard-map.json) from the guitar artwork's GEOMETRY — never from the order of its elements:
 *
 *   - frets: the horizontal wires (a <line>, or a <polyline> whose points share one y) that cross all six string lines between the nut and the body, joined
 *     where the artwork draws a wire in pieces; the topmost is the nut. Fret wires stop where the spacing jumps (the neck meets the body);
 *   - strings: the 3-point polylines that run from a tuning peg, through the nut, to the bridge; numbered by where they meet the bridge — for a right-handed
 *     guitar seen from the front, headstock up, the leftmost is string 6 (low E);
 *   - inlays: the small dots between fret wires, which must fall on the frets guitars mark (3, 5, 7, 9, 12, 15, 17) — a check that the frets were counted right;
 *   - targets: for each string and fret, a point on the string just behind the fret wire (62 % of the way from the wire before it); fret 0 just above the nut.
 *
 *   node tools/guitar/derive-fretboard-map.ts [--check]     (--check: fail if the committed map differs from what the artwork gives)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FretboardMap, Point } from '../../src/music/fretboard.ts';
import type { StringNumber } from '../../src/music/guitar.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const ARTWORK = path.join(ROOT, 'assets', 'instruments', 'guitar', 'yorbederycke-guitar-6755435.svg');
export const MAP = path.join(ROOT, 'assets', 'instruments', 'guitar', 'fretboard-map.json');

const numbers = (text: string): number[] => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const attribute = (element: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1] ?? null;
const round = (n: number): number => Math.round(n * 1000) / 1000;

export function deriveFretboardMap(svg: string, sha256: string): FretboardMap {
  const viewBox = numbers(attribute(svg.slice(0, svg.indexOf('>', svg.indexOf('<svg'))), 'viewBox') ?? '');
  if (viewBox.length !== 4) throw new Error('the artwork has no viewBox');
  const elements = svg.match(/<(?:line|polyline|circle)\b[^>]*>/g) ?? [];

  // horizontal segments: y, from x, to x
  const segments: { y: number; x0: number; x1: number }[] = [];
  const polylines: Point[][] = [];
  const dots: Point[] = [];
  for (const element of elements) {
    if (element.startsWith('<line')) {
      const [x1, x2, y1, y2] = ['x1', 'x2', 'y1', 'y2'].map((a) => Number(attribute(element, a)));
      if (y1 === y2) segments.push({ y: y1 as number, x0: Math.min(x1 as number, x2 as number), x1: Math.max(x1 as number, x2 as number) });
    } else if (element.startsWith('<polyline')) {
      const n = numbers(attribute(element, 'points') ?? '');
      const pts = Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i] as number, y: n[2 * i + 1] as number }));
      if (pts.length >= 2 && pts.every((p) => p.y === (pts[0] as Point).y)) segments.push({ y: (pts[0] as Point).y, x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)) });
      else polylines.push(pts);
    } else {
      const r = Number(attribute(element, 'r'));
      if (r > 0 && r <= 2) dots.push({ x: Number(attribute(element, 'cx')), y: Number(attribute(element, 'cy')) });
    }
  }
  // wires drawn in pieces are joined by their y
  const byY = new Map<number, { x0: number; x1: number }>();
  for (const s of segments) {
    const known = byY.get(s.y);
    byY.set(s.y, known === undefined ? { x0: s.x0, x1: s.x1 } : { x0: Math.min(known.x0, s.x0), x1: Math.max(known.x1, s.x1) });
  }

  // strings: three points — a peg, the nut, the bridge — the middle on a wire
  const wireYs = [...byY.keys()];
  const strings = polylines.filter((p) => p.length === 3 && wireYs.some((y) => Math.abs(y - (p[1] as Point).y) < 2) && (p[2] as Point).y > (p[1] as Point).y + 500);
  if (strings.length !== 6) throw new Error(`the artwork has ${strings.length} string lines, not 6`);
  strings.sort((a, b) => (a[2] as Point).x - (b[2] as Point).x);
  // the nut: the wire nearest the points where the strings bend over it (the artwork bends them within a pixel or two of it)
  const bends = strings.map((s) => (s[1] as Point).y);
  const meanBend = bends.reduce((a, b) => a + b, 0) / bends.length;
  const nutWire = wireYs.reduce((best, y) => (Math.abs(y - meanBend) < Math.abs(best - meanBend) ? y : best));
  const xOn = (s: Point[], y: number): number => {
    const a = s[1] as Point;
    const b = s[2] as Point;
    return a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
  };
  // frets: wires below the nut that cross every string; the list stops where the spacing jumps
  const crossing = [...byY.entries()]
    .filter(([y, span]) => y > nutWire + 1 && strings.every((s) => span.x0 <= xOn(s, y) && xOn(s, y) <= span.x1))
    .map(([y]) => y)
    .sort((a, b) => a - b);
  const fretYs: number[] = [];
  let previous = nutWire;
  for (const y of crossing) {
    const spacing = y - previous;
    const last = fretYs.length === 0 ? spacing : previous - (fretYs.length === 1 ? nutWire : (fretYs[fretYs.length - 2] as number));
    if (fretYs.length > 0 && spacing > 3 * last) break;
    fretYs.push(y);
    previous = y;
  }
  const wires = [nutWire, ...fretYs];
  const inlayFrets = [...new Set(dots.filter((d) => d.y > nutWire && d.y < (fretYs[fretYs.length - 1] as number)).map((d) => wires.findIndex((y) => y > d.y)))].sort((a, b) => a - b);

  const numbered = strings.map((s, i) => ({ string: (6 - i) as StringNumber, line: s }));
  const targets: FretboardMap['targets'][number][] = [];
  for (const { string, line } of numbered) {
    targets.push({ string, fret: 0, at: { x: round(xOn(line, nutWire)), y: round(nutWire - 22) } });
    fretYs.forEach((y, i) => {
      const before = wires[i] as number;
      const at = before + 0.62 * (y - before);
      targets.push({ string, fret: i + 1, at: { x: round(xOn(line, at)), y: round(at) } });
    });
  }
  return {
    format: 'anytune-fretboard-map/1',
    source: {
      file: 'yorbederycke-guitar-6755435.svg',
      sha256,
      viewBox: viewBox as unknown as [number, number, number, number],
      author: 'yorbederycke (Pixabay)',
      license: 'Pixabay Content License',
      url: 'https://pixabay.com/vectors/guitar-6755435/',
    },
    orientation: 'right-handed, front view, headstock up',
    nutY: nutWire,
    fretYs,
    inlayFrets,
    strings: numbered.map(({ string, line }) => ({ string, nut: { x: round(xOn(line, nutWire)), y: nutWire }, bridge: line[2] as Point })),
    targets,
  };
}

export function deriveFromArtwork(): FretboardMap {
  const bytes = fs.readFileSync(ARTWORK);
  return deriveFretboardMap(bytes.toString('utf8'), crypto.createHash('sha256').update(bytes).digest('hex'));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const map = deriveFromArtwork();
  const text = `${JSON.stringify(map, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(MAP) || fs.readFileSync(MAP, 'utf8').replace(/\r\n/g, '\n') !== text) {
      console.error('the committed fretboard map is not what the artwork gives: run node tools/guitar/derive-fretboard-map.ts');
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(MAP, text);
    console.log(`${path.relative(ROOT, MAP)}: ${map.fretYs.length} frets, inlays at ${map.inlayFrets.join(', ')}, ${map.targets.length} targets`);
  }
}
