/**
 * Standard MIDI Files (SMF 1.0, the "Standard MIDI Files" part of the MIDI 1.0 Detailed Specification): the bytes of a `.mid` read into its header, its
 * track chunks and their events, and written back. Nothing musical is decided here. Ticks stay ticks (src/music/timeline.ts turns them into seconds); a
 * note-on with velocity 0 stays a note-on with velocity 0 (the timeline says what it means). A file that does not hold is refused with the byte offset and
 * the reason. It is never repaired silently: what is tolerated (a missing end-of-track, an alien chunk) is tolerated out loud, as a warning.
 */

/** How a tick is measured: a fraction of a quarter note (its length set by the tempo), or a fraction of an SMPTE frame (absolute time, tempo ignored). */
export type Division =
  | { readonly kind: 'ppq'; readonly ticksPerQuarter: number }
  | { readonly kind: 'smpte'; readonly framesPerSecond: SmpteRate; readonly ticksPerFrame: number };

/** The four SMPTE rates an SMF may name; 29.97 is the "30 drop-frame" rate the file writes as −29. */
export type SmpteRate = 24 | 25 | 29.97 | 30;

export type ChannelEvent =
  | { readonly kind: 'noteOff'; readonly channel: number; readonly key: number; readonly velocity: number }
  | { readonly kind: 'noteOn'; readonly channel: number; readonly key: number; readonly velocity: number }
  | { readonly kind: 'polyPressure'; readonly channel: number; readonly key: number; readonly pressure: number }
  | { readonly kind: 'controlChange'; readonly channel: number; readonly controller: number; readonly value: number }
  | { readonly kind: 'programChange'; readonly channel: number; readonly program: number }
  | { readonly kind: 'channelPressure'; readonly channel: number; readonly pressure: number }
  /** −8192 … 8191, 0 the centre */
  | { readonly kind: 'pitchBend'; readonly channel: number; readonly value: number };

/** The meta events of the text family (FF 01 … FF 07): text, copyright, track name, instrument name, lyric, marker, cue point. */
export const TEXT_META_TYPES = Object.freeze({ text: 0x01, copyright: 0x02, trackName: 0x03, instrumentName: 0x04, lyric: 0x05, marker: 0x06, cuePoint: 0x07 });
export type TextMetaName = keyof typeof TEXT_META_TYPES;

export type MetaEvent =
  /** FF 51 03: microseconds per quarter note */
  | { readonly kind: 'tempo'; readonly microsecondsPerQuarter: number }
  /** FF 58 04: numerator, the denominator as a power of two (2 → a quarter), MIDI clocks per metronome click, 32nd notes per MIDI quarter */
  | { readonly kind: 'timeSignature'; readonly numerator: number; readonly denominator: number; readonly clocksPerClick: number; readonly thirtySecondsPerQuarter: number }
  /** FF 59 02: sharps (+) or flats (−), and major (false) or minor (true) */
  | { readonly kind: 'keySignature'; readonly sharpsOrFlats: number; readonly minor: boolean }
  | { readonly kind: 'text'; readonly type: TextMetaName; readonly text: string }
  /** FF 2F 00 */
  | { readonly kind: 'endOfTrack' }
  /** any other meta event, kept as its bytes */
  | { readonly kind: 'meta'; readonly type: number; readonly data: Uint8Array };

/** F0 (a complete message, or the first packet of one) or F7 (a continuation packet, or an escape for arbitrary bytes), kept as bytes. */
export type SysexEvent = { readonly kind: 'sysex'; readonly escape: boolean; readonly data: Uint8Array };

export type MidiEvent = ChannelEvent | MetaEvent | SysexEvent;

/** An event at an absolute tick of its track. */
export interface TimedEvent {
  readonly tick: number;
  readonly event: MidiEvent;
}

export interface MidiTrack {
  /** in the order of the file, ticks never decreasing */
  readonly events: readonly TimedEvent[];
}

export interface MidiFile {
  /** 0: one multi-channel track; 1: simultaneous tracks; 2: independent sequential patterns */
  readonly format: 0 | 1 | 2;
  readonly division: Division;
  readonly tracks: readonly MidiTrack[];
}

export interface MidiWarning {
  readonly offset: number;
  readonly message: string;
}

export type MidiReadResult =
  | { readonly ok: true; readonly file: MidiFile; readonly warnings: readonly MidiWarning[] }
  | { readonly ok: false; readonly offset: number; readonly reason: string };

/** The largest value a variable-length quantity of four bytes holds. */
export const MAX_VLQ = 0x0fffffff;

class MidiFormatError extends Error {
  readonly offset: number;
  constructor(offset: number, reason: string) {
    super(reason);
    this.offset = offset;
  }
}

const ascii = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

/** A reader of one chunk's bytes that refuses to run past them. */
class Reader {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  at: number;
  constructor(bytes: Uint8Array, start: number, end: number) {
    this.#bytes = bytes;
    this.at = start;
    this.#end = end;
  }
  get done(): boolean {
    return this.at >= this.#end;
  }
  u8(what: string): number {
    if (this.at >= this.#end) throw new MidiFormatError(this.at, `the track ends inside ${what}`);
    return this.#bytes[this.at++] as number;
  }
  /** A data byte: its high bit is clear. */
  data(what: string): number {
    const at = this.at;
    const byte = this.u8(what);
    if (byte & 0x80) throw new MidiFormatError(at, `${what} is 0x${byte.toString(16)}: a data byte has its high bit clear`);
    return byte;
  }
  vlq(what: string): number {
    const at = this.at;
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8(what);
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new MidiFormatError(at, `${what} is a variable-length quantity of more than four bytes`);
  }
  take(length: number, what: string): Uint8Array {
    if (this.at + length > this.#end) throw new MidiFormatError(this.at, `${what} claims ${length} bytes; the track has ${this.#end - this.at} left`);
    const out = this.#bytes.slice(this.at, this.at + length);
    this.at += length;
    return out;
  }
}

const SMPTE_RATES: Readonly<Record<number, SmpteRate>> = Object.freeze({ [-24]: 24, [-25]: 25, [-29]: 29.97, [-30]: 30 });

function readDivision(word: number, at: number): Division {
  if (word & 0x8000) {
    const rate = SMPTE_RATES[(word >> 8) - 256];
    const ticksPerFrame = word & 0xff;
    if (rate === undefined) throw new MidiFormatError(at, `the SMPTE division names ${(word >> 8) - 256} frames per second; only −24, −25, −29 and −30 exist`);
    if (ticksPerFrame === 0) throw new MidiFormatError(at, 'the SMPTE division has 0 ticks per frame');
    return { kind: 'smpte', framesPerSecond: rate, ticksPerFrame };
  }
  if (word === 0) throw new MidiFormatError(at, 'the division is 0 ticks per quarter note');
  return { kind: 'ppq', ticksPerQuarter: word };
}

const TEXT_NAMES: Readonly<Record<number, TextMetaName>> = Object.freeze(
  Object.fromEntries(Object.entries(TEXT_META_TYPES).map(([name, type]) => [type, name as TextMetaName])),
);

function readMeta(type: number, data: Uint8Array, at: number): MetaEvent {
  const need = (length: number, what: string): void => {
    if (data.length !== length) throw new MidiFormatError(at, `${what} (FF ${type.toString(16).padStart(2, '0')}) has ${data.length} bytes of data, not ${length}`);
  };
  switch (type) {
    case 0x51:
      need(3, 'a tempo');
      return { kind: 'tempo', microsecondsPerQuarter: ((data[0] as number) << 16) | ((data[1] as number) << 8) | (data[2] as number) };
    case 0x58:
      need(4, 'a time signature');
      return { kind: 'timeSignature', numerator: data[0] as number, denominator: data[1] as number, clocksPerClick: data[2] as number, thirtySecondsPerQuarter: data[3] as number };
    case 0x59: {
      need(2, 'a key signature');
      const sf = data[0] as number;
      return { kind: 'keySignature', sharpsOrFlats: sf > 127 ? sf - 256 : sf, minor: data[1] === 1 };
    }
    case 0x2f:
      need(0, 'an end of track');
      return { kind: 'endOfTrack' };
    default: {
      const name = TEXT_NAMES[type];
      // the specification leaves the text's encoding open; UTF-8 is read, and bytes that are not UTF-8 become U+FFFD rather than an error
      if (name !== undefined) return { kind: 'text', type: name, text: new TextDecoder('utf-8').decode(data) };
      return { kind: 'meta', type, data };
    }
  }
}

function readTrack(bytes: Uint8Array, start: number, end: number, warnings: MidiWarning[]): MidiTrack {
  const reader = new Reader(bytes, start, end);
  const events: TimedEvent[] = [];
  let tick = 0;
  let running: number | null = null;
  let ended = false;
  while (!reader.done) {
    const eventAt = reader.at;
    if (ended) {
      warnings.push({ offset: eventAt, message: 'bytes after the end-of-track event are ignored' });
      break;
    }
    tick += reader.vlq('a delta time');
    let status = reader.u8('an event');
    let firstData: number | null = null;
    if (status < 0x80) {
      // running status: the byte read is the first data byte of a channel message with the previous status
      if (running === null) throw new MidiFormatError(eventAt, `a data byte (0x${status.toString(16)}) with no running status to continue`);
      firstData = status;
      status = running;
    }
    if (status === 0xff) {
      running = null;
      const type = reader.data('a meta event type');
      const length = reader.vlq('a meta event length');
      const event = readMeta(type, reader.take(length, 'a meta event'), eventAt);
      events.push({ tick, event });
      if (event.kind === 'endOfTrack') ended = true;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      running = null;
      const length = reader.vlq('a sysex length');
      events.push({ tick, event: { kind: 'sysex', escape: status === 0xf7, data: reader.take(length, 'a sysex event') } });
      continue;
    }
    if (status >= 0xf0) throw new MidiFormatError(eventAt, `0x${status.toString(16)} is a system common or real-time status, which a MIDI file does not hold`);
    running = status;
    const channel = status & 0x0f;
    const first = (what: string): number => firstData ?? reader.data(what);
    switch (status & 0xf0) {
      case 0x80:
        events.push({ tick, event: { kind: 'noteOff', channel, key: first('a key'), velocity: reader.data('a velocity') } });
        break;
      case 0x90:
        events.push({ tick, event: { kind: 'noteOn', channel, key: first('a key'), velocity: reader.data('a velocity') } });
        break;
      case 0xa0:
        events.push({ tick, event: { kind: 'polyPressure', channel, key: first('a key'), pressure: reader.data('a pressure') } });
        break;
      case 0xb0:
        events.push({ tick, event: { kind: 'controlChange', channel, controller: first('a controller'), value: reader.data('a controller value') } });
        break;
      case 0xc0:
        events.push({ tick, event: { kind: 'programChange', channel, program: first('a program') } });
        break;
      case 0xd0:
        events.push({ tick, event: { kind: 'channelPressure', channel, pressure: first('a pressure') } });
        break;
      default: {
        const lsb = first('a pitch bend');
        const msb = reader.data('a pitch bend');
        events.push({ tick, event: { kind: 'pitchBend', channel, value: ((msb << 7) | lsb) - 8192 } });
      }
    }
  }
  if (!ended) warnings.push({ offset: end, message: 'the track has no end-of-track event; its end is taken as the end of its chunk' });
  return { events };
}

/** The bytes of a Standard MIDI File, read — or refused with where and why. */
export function readMidiFile(bytes: Uint8Array): MidiReadResult {
  const warnings: MidiWarning[] = [];
  try {
    if (bytes.length < 14 || ascii(bytes, 0) !== 'MThd') throw new MidiFormatError(0, 'not a Standard MIDI File: it does not begin with an MThd chunk');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(4);
    if (headerLength < 6) throw new MidiFormatError(4, `the header chunk is ${headerLength} bytes; it needs 6`);
    if (8 + headerLength > bytes.length) throw new MidiFormatError(4, 'the header chunk runs past the end of the file');
    const format = view.getUint16(8);
    if (format > 2) throw new MidiFormatError(8, `format ${format} does not exist; a MIDI file is format 0, 1 or 2`);
    const declaredTracks = view.getUint16(10);
    const division = readDivision(view.getUint16(12), 12);
    if (format === 0 && declaredTracks !== 1) throw new MidiFormatError(10, `a format 0 file has one track, not ${declaredTracks}`);
    if (headerLength > 6) warnings.push({ offset: 14, message: `the header chunk has ${headerLength - 6} bytes more than 6; they are ignored` });

    const tracks: MidiTrack[] = [];
    let at = 8 + headerLength;
    while (at < bytes.length) {
      if (at + 8 > bytes.length) {
        warnings.push({ offset: at, message: `${bytes.length - at} bytes after the last chunk are ignored` });
        break;
      }
      const type = ascii(bytes, at);
      const length = view.getUint32(at + 4);
      const start = at + 8;
      const end = start + length;
      if (end > bytes.length) throw new MidiFormatError(at, `the ${type} chunk claims ${length} bytes; the file has ${bytes.length - start} left`);
      if (type === 'MTrk') {
        if (tracks.length < declaredTracks) tracks.push(readTrack(bytes, start, end, warnings));
        else warnings.push({ offset: at, message: `a track chunk beyond the ${declaredTracks} the header declares is ignored` });
      } else {
        warnings.push({ offset: at, message: `an alien chunk "${type}" is skipped, as the specification says` });
      }
      at = end;
    }
    if (tracks.length < declaredTracks) throw new MidiFormatError(bytes.length, `the header declares ${declaredTracks} tracks; the file holds ${tracks.length}`);
    return { ok: true, file: { format: format as 0 | 1 | 2, division, tracks }, warnings };
  } catch (error) {
    if (error instanceof MidiFormatError) return { ok: false, offset: error.offset, reason: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------- writing

const checkRange = (value: number, low: number, high: number, what: string): number => {
  if (!Number.isInteger(value) || value < low || value > high) throw new RangeError(`${what} must be an integer in ${low}…${high}, not ${value}`);
  return value;
};

function vlqBytes(value: number): number[] {
  checkRange(value, 0, MAX_VLQ, 'a delta time or length');
  const out = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) out.unshift((rest & 0x7f) | 0x80);
  return out;
}

function divisionWord(division: Division): number {
  if (division.kind === 'ppq') return checkRange(division.ticksPerQuarter, 1, 0x7fff, 'ticks per quarter note');
  const code = { 24: -24, 25: -25, 29.97: -29, 30: -30 }[division.framesPerSecond];
  if (code === undefined) throw new RangeError(`${division.framesPerSecond} frames per second is not an SMPTE rate a MIDI file can name`);
  return ((code + 256) << 8) | checkRange(division.ticksPerFrame, 1, 255, 'ticks per frame');
}

function eventBytes(event: MidiEvent): number[] {
  const seven = (value: number, what: string): number => checkRange(value, 0, 127, what);
  const status = (high: number, channel: number): number => high | checkRange(channel, 0, 15, 'a channel');
  const meta = (type: number, data: ArrayLike<number>): number[] => [0xff, type, ...vlqBytes(data.length), ...Array.from(data)];
  switch (event.kind) {
    case 'noteOff':
      return [status(0x80, event.channel), seven(event.key, 'a key'), seven(event.velocity, 'a velocity')];
    case 'noteOn':
      return [status(0x90, event.channel), seven(event.key, 'a key'), seven(event.velocity, 'a velocity')];
    case 'polyPressure':
      return [status(0xa0, event.channel), seven(event.key, 'a key'), seven(event.pressure, 'a pressure')];
    case 'controlChange':
      return [status(0xb0, event.channel), seven(event.controller, 'a controller'), seven(event.value, 'a controller value')];
    case 'programChange':
      return [status(0xc0, event.channel), seven(event.program, 'a program')];
    case 'channelPressure':
      return [status(0xd0, event.channel), seven(event.pressure, 'a pressure')];
    case 'pitchBend': {
      const value = checkRange(event.value, -8192, 8191, 'a pitch bend') + 8192;
      return [status(0xe0, event.channel), value & 0x7f, value >> 7];
    }
    case 'tempo': {
      const us = checkRange(event.microsecondsPerQuarter, 1, 0xffffff, 'microseconds per quarter note');
      return meta(0x51, [us >> 16, (us >> 8) & 0xff, us & 0xff]);
    }
    case 'timeSignature':
      return meta(0x58, [
        checkRange(event.numerator, 1, 255, 'a numerator'),
        checkRange(event.denominator, 0, 255, 'a denominator power'),
        checkRange(event.clocksPerClick, 0, 255, 'clocks per click'),
        checkRange(event.thirtySecondsPerQuarter, 0, 255, '32nd notes per quarter'),
      ]);
    case 'keySignature':
      return meta(0x59, [(checkRange(event.sharpsOrFlats, -7, 7, 'sharps or flats') + 256) & 0xff, event.minor ? 1 : 0]);
    case 'text':
      return meta(TEXT_META_TYPES[event.type], new TextEncoder().encode(event.text));
    case 'endOfTrack':
      return meta(0x2f, []);
    case 'meta':
      return meta(checkRange(event.type, 0, 127, 'a meta event type'), event.data);
    case 'sysex':
      return [event.escape ? 0xf7 : 0xf0, ...vlqBytes(event.data.length), ...event.data];
  }
}

/**
 * The bytes of a Standard MIDI File. Each track's events are written in the order given — their ticks may not decrease — with explicit status bytes (no
 * running status, which a reader must accept but a writer need not use). A track that does not end with an end-of-track event gets one at its last tick.
 */
export function writeMidiFile(file: MidiFile): Uint8Array {
  if (file.format === 0 && file.tracks.length !== 1) throw new RangeError(`a format 0 file has one track, not ${file.tracks.length}`);
  checkRange(file.tracks.length, 1, 0xffff, 'the number of tracks');
  const out: number[] = [];
  const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
  out.push(...[...'MThd'].map((c) => c.charCodeAt(0)), ...u32(6), ...u16(file.format), ...u16(file.tracks.length), ...u16(divisionWord(file.division)));
  for (const [index, track] of file.tracks.entries()) {
    const body: number[] = [];
    let last = 0;
    let ended = false;
    for (const { tick, event } of track.events) {
      if (ended) throw new RangeError(`track ${index} has events after its end-of-track`);
      checkRange(tick, last, MAX_VLQ, `the tick of an event of track ${index} (ticks may not decrease)`);
      body.push(...vlqBytes(tick - last), ...eventBytes(event));
      last = tick;
      if (event.kind === 'endOfTrack') ended = true;
    }
    if (!ended) body.push(0, 0xff, 0x2f, 0);
    out.push(...[...'MTrk'].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  }
  return Uint8Array.from(out);
}
