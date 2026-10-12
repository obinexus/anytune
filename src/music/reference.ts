/**
 * The teaching reference: what a learner practises against. It is AnyTune's own document, `anytune-reference/1` (JSON), kept beside — never instead of — the
 * assets it came from: the source audio or video, and the Standard MIDI File, which stays the musical reference. It holds what AnyTune must not lose:
 *
 * - stable ids (the song, the reference, every note), the arrangement and its version, the instrument profile;
 * - the provenance: which asset, by its SHA-256; how it became notes (a MIDI import, or a named transcription engine with its version and parameters);
 * - the timing exactly as the MIDI file has it (division, tempo map, time and key signatures), and every note both in ticks and in seconds;
 * - what is uncertain: an estimated note says so, with the engine's confidence; a reference made by transcription is `unreviewed` until a person has checked
 *   it, and the lesson says so.
 *
 * Notes, chords and fingerings are separate annotations: a chord symbol says nothing about which strings play it, and a fingering is a suggestion for a
 * player, never something AnyTune observed. A learner's attempt is never written into a reference (src/lesson/ keeps attempts apart).
 */
import { readMidiFile, writeMidiFile, type Division, type MidiFile, type TimedEvent } from './midi-file.ts';
import { TempoMap, timelineOf, type NoteFlag, type TempoSegment } from './timeline.ts';

export const REFERENCE_FORMAT = 'anytune-reference/1';

/** The instrument profiles a reference may be arranged for (src/music/instruments.ts says which are available). */
export type InstrumentProfileId = 'acoustic-guitar' | 'electric-guitar' | 'piano' | 'bass-guitar' | 'violin' | 'ukulele' | 'voice';

/** A file AnyTune was given or made, by content. The file itself is kept as it was; the reference only points at it. */
export interface SourceAsset {
  readonly role: 'source-media' | 'midi' | 'obr';
  readonly fileName: string;
  /** e.g. `video/mp4`, `audio/mp4`, `audio/midi` */
  readonly mediaType: string;
  /** hex SHA-256 of the file's bytes */
  readonly sha256: string;
  readonly bytes: number;
}

export interface TranscriptionEngine {
  readonly name: string;
  readonly version: string;
  /** the parameters it ran with, so that a reference can be re-made and compared */
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
}

export type Provenance =
  /** a MIDI file given by the user: its notes are what the file says, not estimates */
  | { readonly kind: 'midi-import'; readonly midi: SourceAsset }
  /** notes estimated from recorded sound by a transcription engine, written to a MIDI file: every note is an estimate */
  | { readonly kind: 'transcription'; readonly source: SourceAsset; readonly engine: TranscriptionEngine; readonly midi: SourceAsset };

export interface ReferenceNote {
  /** stable within the reference: `n` and the note's index in the reference's order (onset, track, key) */
  readonly id: string;
  /** MIDI note number, 60 = C4 */
  readonly key: number;
  readonly onsetSeconds: number;
  /** the key's release */
  readonly releaseSeconds: number;
  /** the end of the sound with the sustain pedal; releaseSeconds without one */
  readonly sustainedReleaseSeconds: number;
  readonly onsetTick: number;
  readonly releaseTick: number;
  /** 1…127, or null when unknown */
  readonly velocity: number | null;
  readonly track: number;
  /** 0…15 */
  readonly channel: number;
  /** the engine's confidence in this note, 0…1; null for a note a MIDI file states */
  readonly confidence: number | null;
  /** true for every note a transcription engine estimated */
  readonly estimated: boolean;
  readonly flags: readonly NoteFlag[];
}

export interface ChordAnnotation {
  readonly id: string;
  readonly onsetSeconds: number;
  readonly endSeconds: number;
  /** a chord identity from src/music/chords.ts, e.g. `Am` — never a voicing */
  readonly symbol: string;
  /** null when a person wrote it; an estimate's confidence otherwise */
  readonly confidence: number | null;
}

/** A suggested way to play a note or chord: a suggestion shown to the player, never an observation. */
export interface FingeringAnnotation {
  /** the note or chord annotated */
  readonly target: string;
  /** a voicing id from src/music/guitar.ts, or positions */
  readonly voicing: string;
}

export interface ReferenceTiming {
  readonly division: Division;
  /** the tempo map exactly as the MIDI file has it, with the seconds at which each tempo takes effect */
  readonly tempo: readonly TempoSegment[];
  readonly timeSignatures: readonly { readonly tick: number; readonly seconds: number; readonly numerator: number; readonly denominator: number }[];
  readonly keySignatures: readonly { readonly tick: number; readonly seconds: number; readonly sharpsOrFlats: number; readonly minor: boolean }[];
  readonly endTick: number;
  readonly endSeconds: number;
}

export interface Reference {
  readonly format: typeof REFERENCE_FORMAT;
  /** stable: `ref-` and the SHA-256 of the MIDI file the notes are in, so that the same notes are the same reference */
  readonly id: string;
  readonly song: { readonly id: string; readonly title: string; readonly composer: string | null };
  readonly arrangement: {
    readonly id: string;
    readonly version: number;
    readonly instrument: InstrumentProfileId;
    /** what of the music this is: a melody to play on its own, chords, or everything the file holds */
    readonly part: 'melody' | 'chords' | 'full';
  };
  readonly provenance: Provenance;
  /** a transcription is `unreviewed` until a person has checked it */
  readonly review: { readonly state: 'unreviewed' | 'reviewed'; readonly corrections: number };
  readonly timing: ReferenceTiming;
  /** by onset, then track, then key */
  readonly notes: readonly ReferenceNote[];
  readonly chords: readonly ChordAnnotation[];
  readonly fingerings: readonly FingeringAnnotation[];
  /** what the MIDI file needed tolerated, in words */
  readonly diagnostics: readonly string[];
}

export type ReferenceResult = { readonly ok: true; readonly reference: Reference } | { readonly ok: false; readonly reason: string };

export interface ReferenceDescription {
  readonly song: Reference['song'];
  readonly arrangement: Reference['arrangement'];
  readonly provenance: Provenance;
  /** per note, in the order of the reference (onset, track, key): the engine's confidence; only for a transcription */
  readonly confidences?: readonly number[];
}

/** A reference from the bytes of a MIDI file and what is known of where it came from — or why the file cannot be one. */
export function referenceFromMidi(bytes: Uint8Array, description: ReferenceDescription): ReferenceResult {
  const read = readMidiFile(bytes);
  if (!read.ok) return { ok: false, reason: `the MIDI file is not readable at byte ${read.offset}: ${read.reason}` };
  const made = timelineOf(read.file);
  if (!made.ok) return { ok: false, reason: made.reason };
  const t = made.timeline;
  const estimated = description.provenance.kind === 'transcription';
  if (estimated && description.confidences !== undefined && description.confidences.length !== t.notes.length) {
    return { ok: false, reason: `the transcription gave ${description.confidences.length} confidences for ${t.notes.length} notes` };
  }
  if (t.notes.length === 0) return { ok: false, reason: 'the MIDI file has no notes to practise' };
  return {
    ok: true,
    reference: {
      format: REFERENCE_FORMAT,
      id: `ref-${description.provenance.midi.sha256}`,
      song: description.song,
      arrangement: description.arrangement,
      provenance: description.provenance,
      review: { state: estimated ? 'unreviewed' : 'reviewed', corrections: 0 },
      timing: {
        division: read.file.division,
        tempo: t.tempoMap.segments,
        timeSignatures: t.timeSignatures,
        keySignatures: t.keySignatures,
        endTick: t.endTick,
        endSeconds: t.endSeconds,
      },
      notes: t.notes.map((note, index) => ({
        id: `n${index}`,
        key: note.key,
        onsetSeconds: note.onSeconds,
        releaseSeconds: note.offSeconds,
        sustainedReleaseSeconds: note.sustainedOffSeconds,
        onsetTick: note.onTick,
        releaseTick: note.offTick,
        velocity: note.velocity,
        track: note.track,
        channel: note.channel,
        confidence: estimated ? (description.confidences?.[index] ?? null) : null,
        estimated,
        flags: note.flags,
      })),
      chords: [],
      fingerings: [],
      diagnostics: [...read.warnings.map((w) => `byte ${w.offset}: ${w.message}`), ...t.diagnostics],
    },
  };
}

/** The tempo map of a reference, to convert between its ticks and seconds. */
export function tempoMapOf(reference: Reference): TempoMap {
  return new TempoMap(
    reference.timing.division,
    reference.timing.tempo.map((s) => ({ tick: s.tick, microsecondsPerQuarter: s.microsecondsPerQuarter })),
  );
}

/** An estimated note, in seconds, as a transcription engine reports it. */
export interface EstimatedNote {
  readonly key: number;
  readonly onsetSeconds: number;
  readonly releaseSeconds: number;
  /** 1…127 */
  readonly velocity: number;
  readonly confidence: number;
}

export interface TranscriptionMidi {
  readonly bytes: Uint8Array;
  /** per note, in the order the reference made from these bytes will have: the engine's confidence */
  readonly confidences: readonly number[];
  /** the largest |seconds written − seconds estimated| of an onset, or of a release left as estimated: the tick rounding, at most half a tick */
  readonly maxRoundingSeconds: number;
  /** what had to change for MIDI to hold the estimate, counted: each change is a known limit of the representation, never silent */
  readonly adjustments: {
    /** two estimates of one key at one tick: the more confident is kept */
    readonly mergedDuplicates: number;
    /** a release moved earlier, to where the same key is struck again */
    readonly releasesShortened: number;
    /** a release moved to one tick after its onset: a note lasts at least one tick */
    readonly releasesLengthened: number;
  };
}

/**
 * A Standard MIDI File (format 1, one conductor track and one note track) for notes a transcription engine estimated in seconds. One tempo is written (the
 * engine estimates no tempo map; the default is 120 BPM), so a tick is a fixed time and every onset and release is rounded to the nearest tick — at 480 PPQ
 * and 120 BPM, to within 0.52 ms. MIDI holds one sounding note per key and channel, so: two estimates of one key on one tick become the more confident one; an
 * estimate that strikes a key still sounding releases the earlier note there (otherwise MIDI's first-in, first-out pairing would give the releases to the
 * wrong notes); a note lasts at least one tick. Each is counted in `adjustments`. The confidences come back in the order of the notes the file will be read as.
 */
export function transcriptionToMidi(
  notes: readonly EstimatedNote[],
  options: { readonly ticksPerQuarter?: number; readonly microsecondsPerQuarter?: number; readonly channel?: number; readonly title?: string } = {},
): TranscriptionMidi {
  const ppq = options.ticksPerQuarter ?? 480;
  const us = options.microsecondsPerQuarter ?? 500_000;
  const channel = options.channel ?? 0;
  const map = new TempoMap({ kind: 'ppq', ticksPerQuarter: ppq }, [{ tick: 0, microsecondsPerQuarter: us }]);
  interface Placed {
    readonly note: EstimatedNote;
    readonly onTick: number;
    offTick: number;
    releaseAsEstimated: boolean;
  }
  const all: Placed[] = notes.map((note, order) => {
    if (!(note.onsetSeconds >= 0) || !(note.releaseSeconds >= note.onsetSeconds)) throw new RangeError(`note ${order} starts before 0 or ends before it starts`);
    if (!Number.isInteger(note.key) || note.key < 0 || note.key > 127) throw new RangeError(`note ${order} has key ${note.key}, not a MIDI note number`);
    if (!(note.confidence >= 0 && note.confidence <= 1)) throw new RangeError(`note ${order} has confidence ${note.confidence}, not 0…1`);
    return { note, onTick: Math.round(map.tickAt(note.onsetSeconds)), offTick: Math.round(map.tickAt(note.releaseSeconds)), releaseAsEstimated: true };
  });
  // the order the reference will have: onset, then key (one track), then release
  all.sort((a, b) => a.onTick - b.onTick || a.note.key - b.note.key || b.note.confidence - a.note.confidence || a.offTick - b.offTick);
  let mergedDuplicates = 0;
  let releasesShortened = 0;
  let releasesLengthened = 0;
  const placed: Placed[] = [];
  const lastOfKey = new Map<number, Placed>();
  for (const p of all) {
    const earlier = lastOfKey.get(p.note.key);
    if (earlier !== undefined && earlier.onTick === p.onTick) {
      mergedDuplicates++; // sorted most confident first: the earlier one is kept
      continue;
    }
    if (earlier !== undefined && earlier.offTick > p.onTick) {
      earlier.offTick = p.onTick;
      earlier.releaseAsEstimated = false;
      releasesShortened++;
    }
    placed.push(p);
    lastOfKey.set(p.note.key, p);
  }
  for (const p of placed) {
    if (p.offTick <= p.onTick) {
      p.offTick = p.onTick + 1;
      p.releaseAsEstimated = false;
      releasesLengthened++;
    }
  }
  let maxRoundingSeconds = 0;
  for (const p of placed) {
    maxRoundingSeconds = Math.max(maxRoundingSeconds, Math.abs(map.secondsAt(p.onTick) - p.note.onsetSeconds));
    if (p.releaseAsEstimated) maxRoundingSeconds = Math.max(maxRoundingSeconds, Math.abs(map.secondsAt(p.offTick) - p.note.releaseSeconds));
  }
  const events: { tick: number; rank: number; event: TimedEvent['event'] }[] = [];
  for (const { note, onTick, offTick } of placed) {
    events.push({ tick: onTick, rank: 1, event: { kind: 'noteOn', channel, key: note.key, velocity: Math.min(127, Math.max(1, Math.round(note.velocity))) } });
    events.push({ tick: offTick, rank: 0, event: { kind: 'noteOff', channel, key: note.key, velocity: 0 } });
  }
  // at one tick, releases before strikes: a repeated note is released, then struck again (stable: Array.prototype.sort is)
  events.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
  const file: MidiFile = {
    format: 1,
    division: { kind: 'ppq', ticksPerQuarter: ppq },
    tracks: [
      {
        events: [
          ...(options.title === undefined ? [] : [{ tick: 0, event: { kind: 'text' as const, type: 'trackName' as const, text: options.title } }]),
          { tick: 0, event: { kind: 'tempo', microsecondsPerQuarter: us } },
        ],
      },
      { events: events.map(({ tick, event }) => ({ tick, event })) },
    ],
  };
  return { bytes: writeMidiFile(file), confidences: placed.map((p) => p.note.confidence), maxRoundingSeconds, adjustments: { mergedDuplicates, releasesShortened, releasesLengthened } };
}
