/**
 * What AnyTune does with a transcription engine's notes, and how it measures them. The ENGINE is not AnyTune's (Spotify's Basic Pitch, in the import worker);
 * this is the part that is: a documented clean-up of what that engine typically gets wrong on plucked and struck strings, and the note-level metric that
 * says how close a transcription came to a known score — so that every claim of accuracy is a measurement on a declared fixture, never an impression.
 */

/** A note as an engine reports it: key, onset and duration in seconds, and its strength (the engine's activation, 0…1). */
export interface EngineNote {
  readonly key: number;
  readonly onsetSeconds: number;
  readonly durationSeconds: number;
  readonly strength: number;
}

export interface GhostFilterResult {
  readonly kept: readonly EngineNote[];
  /** the notes dropped, each with the stronger note it was taken to be a harmonic of */
  readonly dropped: readonly { readonly note: EngineNote; readonly harmonicOf: EngineNote }[];
}

/**
 * Octave "ghosts": a polyphonic engine often reports a string's 2nd, 3rd or 4th harmonic as a note of its own — 12, 19 or 24 semitones above the note
 * played, starting with it, weaker and no longer. A note is dropped as such a ghost when a note 12, 19 or 24 semitones below it starts within 50 ms, is at
 * least 1.5 times as strong, and lasts at least as long. This is a heuristic, AnyTune's, and it can drop a real octave played softly over a louder note:
 * every drop is listed, and a transcription is reviewed before it teaches.
 */
export function dropOctaveGhosts(notes: readonly EngineNote[]): GhostFilterResult {
  const kept: EngineNote[] = [];
  const dropped: { note: EngineNote; harmonicOf: EngineNote }[] = [];
  for (const n of notes) {
    const parent = notes.find((m) => m !== n && [12, 19, 24].includes(n.key - m.key) && Math.abs(m.onsetSeconds - n.onsetSeconds) <= 0.05 && m.strength >= 1.5 * n.strength && m.durationSeconds >= n.durationSeconds);
    if (parent === undefined) kept.push(n);
    else dropped.push({ note: n, harmonicOf: parent });
  }
  return { kept, dropped };
}

export interface NoteScore {
  readonly reference: number;
  readonly estimated: number;
  readonly matched: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** of the matched notes: |onset error| in ms */
  readonly onsetErrorMs: { readonly median: number | null; readonly p95: number | null };
}

/**
 * Onset-only note accuracy, as transcription research reports it (mir_eval's "onset" note metric): a reference note and an estimated note match when their
 * keys are equal and their onsets are within `toleranceSeconds` (50 ms); each note matches at most once. For each key the notes are swept left to right,
 * pairing the earliest unmatched reference and estimate when they are close enough and otherwise dropping the earlier — which, for a fixed tolerance on a
 * line, matches as many notes as any matching can.
 */
export function scoreNotes(reference: readonly { key: number; onsetSeconds: number }[], estimated: readonly { key: number; onsetSeconds: number }[], toleranceSeconds = 0.05): NoteScore {
  const errors: number[] = [];
  const keys = new Set([...reference.map((n) => n.key), ...estimated.map((n) => n.key)]);
  for (const key of keys) {
    const r = reference.filter((n) => n.key === key).map((n) => n.onsetSeconds).sort((a, b) => a - b);
    const e = estimated.filter((n) => n.key === key).map((n) => n.onsetSeconds).sort((a, b) => a - b);
    let i = 0;
    let j = 0;
    while (i < r.length && j < e.length) {
      const d = (e[j] as number) - (r[i] as number);
      if (Math.abs(d) <= toleranceSeconds + 1e-12) {
        errors.push(Math.abs(d) * 1000);
        i++;
        j++;
      } else if (d < 0) j++;
      else i++;
    }
  }
  errors.sort((a, b) => a - b);
  const matched = errors.length;
  const precision = estimated.length === 0 ? 0 : matched / estimated.length;
  const recall = reference.length === 0 ? 0 : matched / reference.length;
  return {
    reference: reference.length,
    estimated: estimated.length,
    matched,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    onsetErrorMs: { median: errors[Math.floor(errors.length / 2)] ?? null, p95: errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.95))] ?? null },
  };
}
