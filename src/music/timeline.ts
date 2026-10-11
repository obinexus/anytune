/**
 * The timeline of a MIDI file: its ticks mapped to seconds on one monotonic clock that starts at the file's tick 0, and its note-on/note-off pairs made
 * into notes. Every rule a file leaves open is decided here once, and written down:
 *
 * - **Division.** PPQ ticks are measured by the tempo map. SMPTE ticks are absolute (frames per second × ticks per frame) and the tempo events of an SMPTE
 *   file change nothing; they are kept as metadata. 29.97 is 30000/1001 frames per second. A tick is never read as PPQ when the division is SMPTE.
 * - **Tempo map.** Before the first tempo event, 500 000 µs per quarter (120 BPM), as the specification says. Tempo events are taken from every track (a
 *   format 1 file should keep them in its first track; files that don't are still read as their authors meant), merged by tick; when two fall on one tick,
 *   the later one, in track order and then file order, holds.
 * - **Format 2** (independent sequential patterns, each with its own tempo) has no single timeline, and is refused.
 * - **Note-on with velocity 0** is a note-off.
 * - **Overlapping notes** of one key on one channel of one track are paired first-in, first-out: a note-off ends the oldest note of that key still sounding.
 *   Notes whose sounding intervals really intersect are both flagged `overlapped`. (FIFO also reads the common "note-on then note-off at the same tick" of a
 *   repeated note as the end of the old note and the start of the new: those two touch, they do not overlap, and are not flagged.)
 * - **A note-off with no note sounding** is ignored, and said in the diagnostics.
 * - **End of track.** A note still sounding when its track ends is closed at the track's end tick and flagged `unterminated`.
 * - **Sustain pedal** (controller 64: down at ≥ 64, up below) is per channel, across the tracks. It never changes when a key was released: `offSeconds` is the
 *   key's release, and `sustainedOffSeconds` how long the pedal kept it sounding (until the pedal rises, or the same key is struck again on that channel).
 * - **Zero-length notes** (a note-on and its note-off on one tick) are kept, flagged `zero-length`.
 */
import type { Division, MidiFile } from './midi-file.ts';

export const DEFAULT_MICROSECONDS_PER_QUARTER = 500_000;

export interface TempoSegment {
  /** where the segment starts */
  readonly tick: number;
  readonly seconds: number;
  readonly microsecondsPerQuarter: number;
}

export interface TempoChange {
  readonly tick: number;
  readonly microsecondsPerQuarter: number;
}

const ticksPerSecondOfSmpte = (division: Extract<Division, { kind: 'smpte' }>): number =>
  (division.framesPerSecond === 29.97 ? 30000 / 1001 : division.framesPerSecond) * division.ticksPerFrame;

/** Ticks ↔ seconds, for one division and one tempo map. Pure; both directions are exact inverses up to floating-point rounding. */
export class TempoMap {
  readonly division: Division;
  /** the first starts at tick 0; for an SMPTE division, one segment whose tempo is only nominal */
  readonly segments: readonly TempoSegment[];

  constructor(division: Division, changes: readonly TempoChange[] = []) {
    this.division = division;
    if (division.kind === 'smpte') {
      this.segments = [{ tick: 0, seconds: 0, microsecondsPerQuarter: DEFAULT_MICROSECONDS_PER_QUARTER }];
      return;
    }
    for (const change of changes) {
      if (!Number.isInteger(change.tick) || change.tick < 0) throw new RangeError(`a tempo change is at a tick ≥ 0, not ${change.tick}`);
      if (!(change.microsecondsPerQuarter > 0)) throw new RangeError(`a tempo is a positive number of µs per quarter, not ${change.microsecondsPerQuarter}`);
    }
    // stable by tick: of several changes on one tick, the last given holds
    const sorted = changes.map((change, order) => ({ change, order })).sort((a, b) => a.change.tick - b.change.tick || a.order - b.order);
    const segments: TempoSegment[] = [{ tick: 0, seconds: 0, microsecondsPerQuarter: DEFAULT_MICROSECONDS_PER_QUARTER }];
    for (const { change } of sorted) {
      const last = segments[segments.length - 1] as TempoSegment;
      if (change.tick === last.tick) {
        segments[segments.length - 1] = { ...last, microsecondsPerQuarter: change.microsecondsPerQuarter };
      } else {
        segments.push({ tick: change.tick, seconds: this.#advance(last, change.tick), microsecondsPerQuarter: change.microsecondsPerQuarter });
      }
    }
    this.segments = segments;
  }

  #advance(segment: TempoSegment, tick: number): number {
    const ppq = (this.division as Extract<Division, { kind: 'ppq' }>).ticksPerQuarter;
    return segment.seconds + ((tick - segment.tick) * segment.microsecondsPerQuarter) / (ppq * 1e6);
  }

  /** The seconds since tick 0 at a tick (which may be fractional). */
  secondsAt(tick: number): number {
    if (!(tick >= 0)) throw new RangeError(`a tick is ≥ 0, not ${tick}`);
    if (this.division.kind === 'smpte') return tick / ticksPerSecondOfSmpte(this.division);
    return this.#advance(this.#segmentWhere((s) => s.tick <= tick), tick);
  }

  /** The (fractional) tick at a number of seconds since tick 0. */
  tickAt(seconds: number): number {
    if (!(seconds >= 0)) throw new RangeError(`a time is ≥ 0 seconds, not ${seconds}`);
    if (this.division.kind === 'smpte') return seconds * ticksPerSecondOfSmpte(this.division);
    const segment = this.#segmentWhere((s) => s.seconds <= seconds);
    return segment.tick + ((seconds - segment.seconds) * this.division.ticksPerQuarter * 1e6) / segment.microsecondsPerQuarter;
  }

  /** The tempo in force at a tick, in µs per quarter (nominal for SMPTE). */
  microsecondsPerQuarterAt(tick: number): number {
    return this.#segmentWhere((s) => s.tick <= tick).microsecondsPerQuarter;
  }

  /** The last segment satisfying a predicate monotone over the segments (true, …, true, false, …): a binary search. */
  #segmentWhere(holds: (segment: TempoSegment) => boolean): TempoSegment {
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (holds(this.segments[mid] as TempoSegment)) low = mid;
      else high = mid - 1;
    }
    return this.segments[low] as TempoSegment;
  }
}

export type NoteFlag = 'overlapped' | 'unterminated' | 'zero-length';

export interface TimedNote {
  readonly track: number;
  readonly channel: number;
  /** the MIDI note number: 60 is C4 */
  readonly key: number;
  /** the note-on velocity, 1…127 */
  readonly velocity: number;
  /** the note-off velocity; null when the note ended by a note-on of velocity 0 or by the end of its track */
  readonly releaseVelocity: number | null;
  readonly onTick: number;
  readonly offTick: number;
  readonly onSeconds: number;
  /** when the key was released */
  readonly offSeconds: number;
  /** when the sound ended, with the sustain pedal: offSeconds when no pedal held the note */
  readonly sustainedOffSeconds: number;
  readonly flags: readonly NoteFlag[];
}

export interface PedalSpan {
  readonly channel: number;
  readonly downTick: number;
  readonly upTick: number;
  readonly downSeconds: number;
  readonly upSeconds: number;
  /** the pedal never rose: the span ends where the file ends */
  readonly unterminated: boolean;
}

export interface TimedTimeSignature {
  readonly tick: number;
  readonly seconds: number;
  readonly numerator: number;
  /** the note value of the beat: 4 is a quarter, 8 an eighth */
  readonly denominator: number;
}

export interface TimedKeySignature {
  readonly tick: number;
  readonly seconds: number;
  readonly sharpsOrFlats: number;
  readonly minor: boolean;
}

export interface Timeline {
  readonly format: 0 | 1;
  readonly tempoMap: TempoMap;
  /** by onset, then track, then key */
  readonly notes: readonly TimedNote[];
  readonly pedals: readonly PedalSpan[];
  readonly timeSignatures: readonly TimedTimeSignature[];
  readonly keySignatures: readonly TimedKeySignature[];
  /** each track's name (FF 03), or null */
  readonly trackNames: readonly (string | null)[];
  /** the last end-of-track, or the last event when a track has none */
  readonly endTick: number;
  readonly endSeconds: number;
  /** what was tolerated, in words */
  readonly diagnostics: readonly string[];
}

export type TimelineResult = { readonly ok: true; readonly timeline: Timeline } | { readonly ok: false; readonly reason: string };

interface OpenNote {
  readonly onTick: number;
  readonly velocity: number;
}

interface RawNote {
  readonly track: number;
  readonly channel: number;
  readonly key: number;
  readonly velocity: number;
  readonly releaseVelocity: number | null;
  readonly onTick: number;
  readonly offTick: number;
  readonly flags: NoteFlag[];
}

/** The timeline of a read MIDI file, or why it has none. */
export function timelineOf(file: MidiFile): TimelineResult {
  if (file.format === 2) return { ok: false, reason: 'a format 2 file is a set of independent patterns, each with its own tempo: it has no single timeline to practise against' };
  const diagnostics: string[] = [];
  const tempoChanges: TempoChange[] = [];
  const timeSignatureEvents: { tick: number; numerator: number; denominator: number }[] = [];
  const keySignatureEvents: { tick: number; sharpsOrFlats: number; minor: boolean }[] = [];
  const pedalEvents: { tick: number; channel: number; down: boolean }[] = [];
  const trackNames: (string | null)[] = [];
  const raw: RawNote[] = [];
  let endTick = 0;

  file.tracks.forEach((track, trackIndex) => {
    const open = new Map<number, OpenNote[]>();
    let trackEnd = 0;
    let name: string | null = null;
    for (const { tick, event } of track.events) {
      trackEnd = tick;
      switch (event.kind) {
        case 'tempo':
          tempoChanges.push({ tick, microsecondsPerQuarter: event.microsecondsPerQuarter });
          break;
        case 'timeSignature':
          timeSignatureEvents.push({ tick, numerator: event.numerator, denominator: 2 ** event.denominator });
          break;
        case 'keySignature':
          keySignatureEvents.push({ tick, sharpsOrFlats: event.sharpsOrFlats, minor: event.minor });
          break;
        case 'text':
          if (event.type === 'trackName' && name === null) name = event.text;
          break;
        case 'controlChange':
          if (event.controller === 64) pedalEvents.push({ tick, channel: event.channel, down: event.value >= 64 });
          break;
        case 'noteOn':
        case 'noteOff': {
          const slot = event.channel * 128 + event.key;
          const sounding = open.get(slot) ?? [];
          if (event.kind === 'noteOn' && event.velocity > 0) {
            sounding.push({ onTick: tick, velocity: event.velocity });
            open.set(slot, sounding);
            break;
          }
          const oldest = sounding.shift();
          if (oldest === undefined) {
            diagnostics.push(`track ${trackIndex}: a note-off of key ${event.key} on channel ${event.channel + 1} at tick ${tick} with no such note sounding is ignored`);
            break;
          }
          const flags: NoteFlag[] = tick === oldest.onTick ? ['zero-length'] : [];
          raw.push({ track: trackIndex, channel: event.channel, key: event.key, velocity: oldest.velocity, releaseVelocity: event.kind === 'noteOff' ? event.velocity : null, onTick: oldest.onTick, offTick: tick, flags });
          break;
        }
        default:
          break;
      }
    }
    for (const [slot, sounding] of open) {
      for (const note of sounding) {
        const flags: NoteFlag[] = ['unterminated'];
        if (trackEnd === note.onTick) flags.push('zero-length');
        raw.push({ track: trackIndex, channel: slot >> 7, key: slot & 127, velocity: note.velocity, releaseVelocity: null, onTick: note.onTick, offTick: trackEnd, flags });
        diagnostics.push(`track ${trackIndex}: key ${slot & 127} on channel ${(slot >> 7) + 1}, struck at tick ${note.onTick}, never released; it ends with its track at tick ${trackEnd}`);
      }
    }
    trackNames.push(name);
    endTick = Math.max(endTick, trackEnd);
  });

  // overlap: within one key of one channel of one track, a note struck before an earlier one was released
  const slots = new Map<string, RawNote[]>();
  for (const note of raw) slots.set(`${note.track}:${note.channel}:${note.key}`, [...(slots.get(`${note.track}:${note.channel}:${note.key}`) ?? []), note]);
  for (const notes of slots.values()) {
    notes.sort((a, b) => a.onTick - b.onTick || a.offTick - b.offTick);
    let reach: RawNote | null = null;
    for (const note of notes) {
      if (reach !== null && reach.offTick > note.onTick) {
        if (!reach.flags.includes('overlapped')) reach.flags.unshift('overlapped');
        note.flags.unshift('overlapped');
      }
      if (reach === null || note.offTick > reach.offTick) reach = note;
    }
  }

  const tempoMap = new TempoMap(file.division, tempoChanges);
  if (file.division.kind === 'smpte' && tempoChanges.length > 0) diagnostics.push('the division is SMPTE: the tempo events are kept, and change no time');
  const seconds = (tick: number): number => tempoMap.secondsAt(tick);

  // the sustain pedal, per channel, across the tracks
  const pedals: PedalSpan[] = [];
  const stablePedals = pedalEvents.map((e, order) => ({ ...e, order })).sort((a, b) => a.tick - b.tick || a.order - b.order);
  for (let channel = 0; channel < 16; channel++) {
    let downAt: number | null = null;
    for (const e of stablePedals) {
      if (e.channel !== channel) continue;
      if (e.down && downAt === null) downAt = e.tick;
      else if (!e.down && downAt !== null) {
        pedals.push({ channel, downTick: downAt, upTick: e.tick, downSeconds: seconds(downAt), upSeconds: seconds(e.tick), unterminated: false });
        downAt = null;
      }
    }
    if (downAt !== null) pedals.push({ channel, downTick: downAt, upTick: endTick, downSeconds: seconds(downAt), upSeconds: seconds(endTick), unterminated: true });
  }

  const ordered = raw.sort((a, b) => a.onTick - b.onTick || a.track - b.track || a.key - b.key || a.offTick - b.offTick);
  const notes: TimedNote[] = ordered.map((note) => {
    let sustainedOffTick = note.offTick;
    const holding = pedals.find((p) => p.channel === note.channel && p.downTick <= note.offTick && note.offTick < p.upTick);
    if (holding !== undefined) {
      const restrike = ordered.find((other) => other.channel === note.channel && other.key === note.key && other.onTick > note.onTick && other.onTick >= note.offTick);
      sustainedOffTick = Math.min(holding.upTick, restrike?.onTick ?? Number.POSITIVE_INFINITY);
    }
    return {
      track: note.track,
      channel: note.channel,
      key: note.key,
      velocity: note.velocity,
      releaseVelocity: note.releaseVelocity,
      onTick: note.onTick,
      offTick: note.offTick,
      onSeconds: seconds(note.onTick),
      offSeconds: seconds(note.offTick),
      sustainedOffSeconds: seconds(sustainedOffTick),
      flags: note.flags,
    };
  });

  const byTick = <T extends { tick: number }>(items: T[]): T[] => items.map((item, order) => ({ item, order })).sort((a, b) => a.item.tick - b.item.tick || a.order - b.order).map(({ item }) => item);
  return {
    ok: true,
    timeline: {
      format: file.format,
      tempoMap,
      notes,
      pedals,
      timeSignatures: byTick(timeSignatureEvents).map((e) => ({ ...e, seconds: seconds(e.tick) })),
      keySignatures: byTick(keySignatureEvents).map((e) => ({ ...e, seconds: seconds(e.tick) })),
      trackNames,
      endTick,
      endSeconds: seconds(endTick),
      diagnostics,
    },
  };
}
