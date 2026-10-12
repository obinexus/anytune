/**
 * Chord IDENTITY: a root and a quality, which is a set of pitch classes — nothing more. "Am" is A, C and E in any octave, in any order, on any instrument.
 * Which strings and frets sound it is a VOICING (src/music/guitar.ts); which fingers press them is a suggested FINGERING; where it is drawn is the fretboard
 * map. The four are kept apart: a chord heard is an identity (and an uncertain one, src/analysis/), never a voicing or a fingering observed.
 *
 * AnyTune's MVP declares a limited vocabulary of open-position chords (MVP_CHORDS): what it can teach and assess for acoustic guitar, and nothing beyond it is
 * claimed.
 */

export type ChordQuality = 'major' | 'minor';

export interface ChordIdentity {
  /** e.g. `C`, `F#m`, `Bbm` */
  readonly symbol: string;
  /** the root's pitch class: 0 C … 11 B */
  readonly root: number;
  readonly quality: ChordQuality;
  /** root, third, fifth, as pitch classes */
  readonly pitchClasses: readonly number[];
}

/** The chords AnyTune's guitar MVP teaches and assesses — and no others. */
export const MVP_CHORDS: readonly string[] = Object.freeze(['C', 'D', 'E', 'G', 'A', 'Am', 'Em', 'Dm']);

const LETTERS: Readonly<Record<string, number>> = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
const INTERVALS: Readonly<Record<ChordQuality, readonly number[]>> = Object.freeze({ major: [0, 4, 7], minor: [0, 3, 7] });

/** A triad symbol read: a letter, an optional ♯ (`#`) or ♭ (`b`), an optional `m`. Null for anything else — no chord is guessed. */
export function parseChord(symbol: string): ChordIdentity | null {
  const match = /^([A-G])([#b]?)(m?)$/.exec(symbol);
  if (match === null) return null;
  const [, letter, accidental, minor] = match as unknown as [string, string, string, string];
  const root = ((LETTERS[letter] as number) + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
  const quality: ChordQuality = minor === 'm' ? 'minor' : 'major';
  return { symbol, root, quality, pitchClasses: (INTERVALS[quality] as number[]).map((i) => (root + i) % 12) };
}

/** Whether a set of sounding MIDI keys is exactly this chord's pitch classes — all of them, and nothing else. */
export function soundsAs(keys: readonly number[], chord: ChordIdentity): boolean {
  const heard = new Set(keys.map((k) => ((k % 12) + 12) % 12));
  return heard.size === chord.pitchClasses.length && chord.pitchClasses.every((pc) => heard.has(pc));
}

/** The pitch-class profile of a chord: 1 on its three pitch classes, 0 elsewhere — the template src/analysis/ compares a heard chroma with. */
export function chordTemplate(chord: ChordIdentity): readonly number[] {
  return Array.from({ length: 12 }, (_, pc) => (chord.pitchClasses.includes(pc) ? 1 : 0));
}
