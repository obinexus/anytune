/**
 * The capo choices offered on every screen that shows the guitar: none, or a fret. Positions then count frets from the capo (as tablature does), and every
 * note name is calculated from the tuning with it (src/app/guitar-view.ts).
 */
import type { Option } from './practice-view.ts';

export const CAPO_FRETS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 7]);

export const capoOptions = (capo: number): Option[] => CAPO_FRETS.map((c) => ({ value: String(c), label: c === 0 ? 'No capo' : `Capo at fret ${c}`, selected: capo === c }));
