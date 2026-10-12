/**
 * The guitar as music: a tuning (the open strings, and a capo), the open-position VOICINGS of the MVP chords with SUGGESTED fingerings, and a melody's
 * suggested positions on the neck. Strings are numbered as guitarists number them: 1 is the highest (E4 in standard tuning), 6 the lowest (E2).
 *
 * What a microphone cannot tell, this module never claims to: a pitch can be played on several strings, so a position is a SUGGESTION chosen for a learner
 * (low frets, little hand movement), and a fingering is a suggestion for a player — never something AnyTune observed. Where the strings and frets are drawn
 * is the fretboard map (src/music/fretboard.ts, assets/instruments/guitar/).
 */
import { parseChord, soundsAs } from './chords.ts';

export type StringNumber = 1 | 2 | 3 | 4 | 5 | 6;
export const STRINGS: readonly StringNumber[] = Object.freeze([6, 5, 4, 3, 2, 1] as const);

export interface GuitarTuning {
  readonly id: string;
  readonly name: string;
  /** the open strings' MIDI notes, string 1 first: standard is E4 B3 G3 D3 A2 E2 */
  readonly open: readonly [number, number, number, number, number, number];
  /** the fret the capo is at; 0 for none. Positions count frets FROM THE CAPO (as tablature does): fret 0 is the string stopped by the capo */
  readonly capo: number;
}

export const STANDARD_TUNING: GuitarTuning = Object.freeze({ id: 'standard', name: 'Standard (E2 A2 D3 G3 B3 E4)', open: Object.freeze([64, 59, 55, 50, 45, 40]) as GuitarTuning['open'], capo: 0 });

export const openMidi = (tuning: GuitarTuning, string: StringNumber): number => (tuning.open[string - 1] as number) + tuning.capo;

export interface Voicing {
  readonly id: string;
  /** the chord identity this voicing sounds (src/music/chords.ts) */
  readonly chord: string;
  /** per string, from 6 down to 1: the fret above the capo, 0 open, null not played (muted) */
  readonly frets: readonly (number | null)[];
  /** per string, from 6 down to 1: the SUGGESTED finger — 1 index, 2 middle, 3 ring, 4 little — or null for an open or muted string */
  readonly fingers: readonly (number | null)[];
}

/** A voicing from guitar shorthand: frets string 6 → 1 (`x32010`), fingers likewise (`-32-1-`, a dash for none). */
function voicing(chord: string, frets: string, fingers: string): Voicing {
  return Object.freeze({
    id: `${chord}-open`,
    chord,
    frets: Object.freeze([...frets].map((c) => (c === 'x' ? null : Number(c)))),
    fingers: Object.freeze([...fingers].map((c) => (c === '-' ? null : Number(c)))),
  });
}

/** The open-position voicings of the MVP chords, with common beginner fingerings (suggestions; other fingerings are as right). */
export const OPEN_VOICINGS: Readonly<Record<string, Voicing>> = Object.freeze({
  C: voicing('C', 'x32010', '-32-1-'),
  D: voicing('D', 'xx0232', '---132'),
  E: voicing('E', '022100', '-231--'),
  G: voicing('G', '320003', '21---3'),
  A: voicing('A', 'x02220', '--123-'),
  Am: voicing('Am', 'x02210', '--231-'),
  Em: voicing('Em', '022000', '-23---'),
  Dm: voicing('Dm', 'xx0231', '---231'),
});

/** The MIDI notes a voicing sounds in a tuning, low string to high; muted strings sound nothing. */
export function soundingKeys(v: Voicing, tuning: GuitarTuning = STANDARD_TUNING): number[] {
  const keys: number[] = [];
  STRINGS.forEach((string, i) => {
    const fret = v.frets[i];
    if (fret !== null && fret !== undefined) keys.push(openMidi(tuning, string) + fret);
  });
  return keys;
}

/** Whether a voicing really sounds its chord — every pitch class of the identity, nothing else. */
export const voicingSoundsItsChord = (v: Voicing, tuning: GuitarTuning = STANDARD_TUNING): boolean => {
  const chord = parseChord(v.chord);
  return chord !== null && soundsAs(soundingKeys(v, tuning), chord);
};

export interface Position {
  readonly string: StringNumber;
  /** above the capo; 0 is the open string */
  readonly fret: number;
}

/** Every place a MIDI note can be played, up to `maxFret`: a pitch heard does not say which of these was used. */
export function positionsOf(key: number, tuning: GuitarTuning = STANDARD_TUNING, maxFret = 15): Position[] {
  const out: Position[] = [];
  for (const string of STRINGS) {
    const fret = key - openMidi(tuning, string);
    if (fret >= 0 && fret <= maxFret) out.push({ string, fret });
  }
  return out;
}

export interface SuggestedPosition extends Position {
  /** the suggested finger, 1…4, or null for an open string */
  readonly finger: number | null;
}

export interface MelodyFingering {
  /** the octave transposition applied so that the melody sits low on the neck: 0, −12 or +12 semitones */
  readonly octaveShift: number;
  /** per note of the melody, in order: where to play it, or null when no octave choice puts it on the neck */
  readonly positions: readonly (SuggestedPosition | null)[];
}

/**
 * Suggested positions for a melody: the path through the possible positions that keeps the hand still and low on the neck (a dynamic program over each
 * note's positions — cost: frets moved, strings crossed, and height on the neck; an open string costs no movement). The whole melody may be moved an octave
 * (−12, 0, +12) to the cheapest playable range — said in `octaveShift`, never hidden. Fingers follow a four-fret hand position that moves only when it must.
 */
export function fingerMelody(keys: readonly number[], tuning: GuitarTuning = STANDARD_TUNING, maxFret = 15): MelodyFingering {
  let best: { shift: number; path: (Position | null)[]; cost: number; missing: number } | null = null;
  for (const shift of [0, -12, 12]) {
    const options = keys.map((k) => positionsOf(k + shift, tuning, maxFret));
    const missing = options.filter((o) => o.length === 0).length;
    // an open string, played or left, moves no hand
    const step = (from: Position | null, to: Position): number =>
      (from === null || from.fret === 0 || to.fret === 0 ? 0 : Math.abs(to.fret - from.fret)) + 0.5 * Math.abs(to.string - (from?.string ?? to.string)) + 0.25 * to.fret;
    // dynamic programming: the cheapest path ending at each position of each note
    let layer: { pos: Position | null; cost: number; back: number }[] = [{ pos: null, cost: 0, back: -1 }];
    const layers: (typeof layer)[] = [];
    for (const choices of options) {
      const next = (choices.length === 0 ? [null] : choices).map((pos) => {
        let cost = Number.POSITIVE_INFINITY;
        let back = 0;
        layer.forEach((prev, i) => {
          const c = prev.cost + (pos === null ? 0 : step(prev.pos, pos));
          if (c < cost) {
            cost = c;
            back = i;
          }
        });
        return { pos, cost, back };
      });
      layers.push(next);
      layer = next;
    }
    let at = layer.reduce((b, x, i) => (x.cost < (layer[b] as { cost: number }).cost ? i : b), 0);
    const path: (Position | null)[] = [];
    for (let n = layers.length - 1; n >= 0; n--) {
      const node = (layers[n] as typeof layer)[at] as { pos: Position | null; back: number };
      path.unshift(node.pos);
      at = node.back;
    }
    const cost = layer.length === 0 ? 0 : Math.min(...layer.map((x) => x.cost));
    if (best === null || missing < best.missing || (missing === best.missing && cost < best.cost - 1e-9)) best = { shift, path, cost, missing };
  }
  const chosen = best as { shift: number; path: (Position | null)[] };
  // fingers: a hand position (the index finger's fret) that covers four frets and moves only when a note falls outside it
  let hand = 1;
  const positions = chosen.path.map((pos): SuggestedPosition | null => {
    if (pos === null) return null;
    if (pos.fret === 0) return { ...pos, finger: null };
    if (pos.fret < hand) hand = pos.fret;
    else if (pos.fret > hand + 3) hand = pos.fret - 3;
    return { ...pos, finger: pos.fret - hand + 1 };
  });
  return { octaveShift: chosen.shift, positions };
}
