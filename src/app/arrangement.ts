/**
 * What the learner plays from a reference: an ARRANGEMENT for their instrument. Today, one kind: the melody on guitar — one track's notes, moved an octave
 * when that is what puts them low on the neck (said, never hidden), each with a suggested string, fret and finger. Practise and Play use the same
 * arrangement, and everything is assessed against it — its keys, not the reference's written ones.
 */
import type { ExpectedNote } from '../lesson/assessment.ts';
import { melodyTargets } from '../lesson/practice.ts';
import { fingerMelody, STANDARD_TUNING, type GuitarTuning, type SuggestedPosition } from '../music/guitar.ts';
import type { Reference } from '../music/reference.ts';

export interface Target extends ExpectedNote {
  /** where the arrangement suggests playing it — a suggestion, never observed */
  readonly position: SuggestedPosition | null;
}

export interface Arrangement {
  readonly id: string;
  /** for a selector, short enough for a phone: "Guitar — melody (octave lower)" */
  readonly label: string;
  /** for the screen: "Melody on guitar, an octave lower than written" */
  readonly text: string;
  readonly octaveShift: number;
  /** the tuning the positions are for — its capo included: positions count frets from the capo */
  readonly tuning: GuitarTuning;
  readonly targets: readonly Target[];
}

const shiftText = (shift: number): string => (shift === 0 ? '' : shift < 0 ? ', an octave lower than written' : ', an octave higher than written');

export function melodyArrangement(reference: Reference, track: number, pickupTicks = 0, tuning: GuitarTuning = STANDARD_TUNING): Arrangement {
  const keys = reference.notes.filter((n) => n.track === track).map((n) => n.key);
  const fingering = fingerMelody(keys, tuning);
  const { targets: raw } = melodyTargets(reference, track, fingering.octaveShift, pickupTicks);
  const unreviewed = reference.review.state === 'unreviewed' ? ' — from an unreviewed transcription' : '';
  return {
    id: `guitar-melody-${track}`,
    label: `Guitar — melody${fingering.octaveShift === 0 ? '' : fingering.octaveShift < 0 ? ' (octave lower)' : ' (octave higher)'}`,
    text: `Melody on guitar${shiftText(fingering.octaveShift)}${tuning.capo > 0 ? `, capo at fret ${tuning.capo}` : ''}${unreviewed}`,
    octaveShift: fingering.octaveShift,
    tuning,
    targets: raw.map((t, i) => ({ ...t, position: fingering.positions[i] ?? null })),
  };
}
