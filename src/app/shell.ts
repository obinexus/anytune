/**
 * The app's journey, as a service: Home → Library (choose a song) → Tune → Practise (listen, play, review, repeat) → Progress. It keeps the songs the learner
 * has (a bundled score, and MIDI files they open), opens the practice session for the one chosen, refuses what cannot be practised (an .obr holds sensor
 * observations, not music) in words, and lists the attempts made. Framework-neutral; the harness gives it files' bytes and makes practice sessions.
 */
import { describeForPractice } from '../adapters/obr-journal.ts';
import { noteOf } from '../domain/pitch.ts';
import { referenceFromMidi, type Reference } from '../music/reference.ts';
import type { PracticeSession, PracticeState } from './practice.ts';

export type Screen = 'home' | 'library' | 'tune' | 'practice' | 'play' | 'progress';
export const SCREENS: readonly { readonly id: Screen; readonly label: string }[] = Object.freeze([
  { id: 'home', label: 'Home' },
  { id: 'library', label: 'Library' },
  { id: 'tune', label: 'Tune' },
  { id: 'practice', label: 'Practise' },
  { id: 'play', label: 'Play' },
  { id: 'progress', label: 'Progress' },
]);

export interface Song {
  readonly id: string;
  readonly reference: Reference;
  /** the track whose notes are the melody the guitar arrangement takes */
  readonly melodyTrack: number;
  readonly pickupTicks: number;
  /** where it came from, in words */
  readonly origin: string;
}

export interface AttemptSummary {
  readonly songTitle: string;
  readonly when: string;
  readonly text: string;
}

export interface ShellState {
  readonly screen: Screen;
  readonly songs: readonly Song[];
  readonly selected: string | null;
  readonly libraryMessage: string;
  readonly attempts: readonly AttemptSummary[];
}

export type PracticeFactory = (song: Song) => PracticeSession;

/** The melody of a MIDI file with several parts: the track whose notes are highest on average — said to the learner, who can tell whether it is right. */
export function melodyTrackOf(reference: Reference): number {
  const tracks = [...new Set(reference.notes.map((n) => n.track))];
  let best = tracks[0] ?? 0;
  let bestMean = Number.NEGATIVE_INFINITY;
  for (const track of tracks) {
    const keys = reference.notes.filter((n) => n.track === track).map((n) => n.key);
    const mean = keys.reduce((a, b) => a + b, 0) / keys.length;
    if (mean > bestMean) {
      bestMean = mean;
      best = track;
    }
  }
  return best;
}

export class Shell {
  readonly #listeners = new Set<(s: ShellState) => void>();
  readonly #factory: PracticeFactory;
  readonly #now: () => string;
  #state: ShellState;
  #practice: PracticeSession | null = null;
  #offPractice: (() => void) | null = null;
  /** the runs already listed as attempts: a session's serial and its run */
  readonly #listed = new Set<string>();
  #serial = 0;

  constructor(songs: readonly Song[], factory: PracticeFactory, now: () => string = () => new Date().toISOString()) {
    this.#factory = factory;
    this.#now = now;
    this.#state = { screen: 'home', songs, selected: null, libraryMessage: '', attempts: [] };
  }

  getState(): ShellState {
    return this.#state;
  }

  get practice(): PracticeSession | null {
    return this.#practice;
  }

  subscribe(listener: (s: ShellState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<ShellState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l(this.#state);
  }

  navigate(screen: Screen): void {
    if (SCREENS.some((s) => s.id === screen)) this.#set({ screen });
  }

  /** Choose a song: its practice session is made (the previous one, if any, is left), and the practice screen opens. */
  choose(songId: string): void {
    const song = this.#state.songs.find((s) => s.id === songId);
    if (song === undefined) return;
    this.#offPractice?.();
    const session = this.#factory(song);
    const serial = ++this.#serial;
    this.#practice = session;
    this.#offPractice = session.subscribe((p) => this.#watch(song, p, serial));
    this.#set({ selected: songId, screen: 'practice' });
  }

  /**
   * When a run reaches its review — and its save has settled — it is listed, once; every other change of the practice re-renders. Its line says what was
   * assessed: a score only for what the microphone covered; none at all when nothing was, or when it was played along without assessment.
   */
  #watch(song: Song, p: PracticeState, serial: number): void {
    const key = `${serial}:${p.run}`;
    if (p.phase !== 'reviewing' || p.run === 0 || p.attempt.kind === 'recording' || this.#listed.has(key) || (p.assessing && p.feedback === null)) {
      this.#set({});
      return;
    }
    this.#listed.add(key);
    const saved = p.attempt.kind === 'saved' ? 'saved' : p.attempt.kind === 'failed' ? 'not saved (the recorder failed)' : 'not saved';
    const fb = p.feedback;
    const text = !p.assessing || fb === null
      ? 'Played along without assessment — no score'
      : fb.pitch.assessed === 0
        ? `Could not be assessed: the microphone was not delivering sound — ${saved}`
        : `${fb.pitch.right} of ${fb.pitch.assessed}${fb.pitch.unassessed > 0 ? ' assessed' : ''} right${fb.timing.judged > 0 ? `, ${fb.timing.onTime} on time` : ''}${fb.pitch.unassessed > 0 ? ` (${fb.pitch.unassessed} not assessed)` : ''}${fb.repeatBar === null ? '' : `; bar ${fb.repeatBar} to repeat`} — ${saved}`;
    this.#set({ attempts: [{ songTitle: song.reference.song.title, when: this.#now(), text }, ...this.#state.attempts] });
  }

  /** The song chosen, made again — after a setting its arrangement depends on (the capo) changed; the screen stays. */
  rebuild(): void {
    const song = this.#state.songs.find((s) => s.id === this.#state.selected);
    if (song === undefined) return;
    this.#offPractice?.();
    const session = this.#factory(song);
    const serial = ++this.#serial;
    this.#practice = session;
    this.#offPractice = session.subscribe((p) => this.#watch(song, p, serial));
    this.#set({});
  }

  /** A finished run of Play, listed in Progress. */
  addAttempt(songTitle: string, text: string): void {
    this.#set({ attempts: [{ songTitle, when: this.#now(), text }, ...this.#state.attempts] });
  }

  /** A MIDI file the learner opened: a reference at once (its notes are stated, not estimated), its melody taken from its highest part — said. */
  openMidi(fileName: string, bytes: Uint8Array, sha256: string): void {
    const title = fileName.replace(/\.(mid|midi)$/i, '');
    const made = referenceFromMidi(bytes, {
      song: { id: `midi-${sha256.slice(0, 12)}`, title, composer: null },
      arrangement: { id: `midi-${sha256.slice(0, 12)}-guitar`, version: 1, instrument: 'acoustic-guitar', part: 'melody' },
      provenance: { kind: 'midi-import', midi: { role: 'midi', fileName, mediaType: 'audio/midi', sha256, bytes: bytes.length } },
    });
    if (!made.ok) {
      this.#set({ libraryMessage: `${fileName} cannot be practised: ${made.reason}. Nothing was added.` });
      return;
    }
    const track = melodyTrackOf(made.reference);
    const melody = made.reference.notes.filter((n) => n.track === track);
    const range = melody.length === 0 ? '' : ` (${noteOf(Math.min(...melody.map((n) => n.key))).label}–${noteOf(Math.max(...melody.map((n) => n.key))).label})`;
    const tracks = new Set(made.reference.notes.map((n) => n.track)).size;
    const song: Song = { id: made.reference.song.id, reference: made.reference, melodyTrack: track, pickupTicks: 0, origin: `MIDI file ${fileName}; melody from track ${track}${range}${tracks > 1 ? `, the highest of its ${tracks} parts` : ''}` };
    const songs = [...this.#state.songs.filter((s) => s.id !== song.id), song];
    this.#set({ songs, libraryMessage: `${title} added: ${melody.length} melody notes. ${made.reference.diagnostics.length > 0 ? `(${made.reference.diagnostics.length} things in the file were tolerated.)` : ''}`.trim() });
  }

  /** An .obr: read with AnyTune's own reader, described, and refused — it holds sensor observations, not music. */
  openObr(fileName: string, bytes: Uint8Array): void {
    this.#set({ libraryMessage: `${fileName}: ${describeForPractice(bytes).reason}` });
  }

  /** A recording or a URL cannot be transcribed on this device: where it can be, said. */
  explainImport(): void {
    this.#set({ libraryMessage: IMPORT_NOTE });
  }
}

export const IMPORT_NOTE =
  'Recordings and links are turned into references by the AnyTune import worker on a computer (FFmpeg and a transcription engine do not run in this app): node services/import-worker/src/cli.ts import --file your-recording.mp4 — then open the MIDI file it makes here. Only import what you may use.';

// ------------------------------------------------------------------------------------------------------------------------------------------------ views

export interface HomeView {
  readonly tagline: string;
  readonly journey: readonly string[];
  readonly primaryLabel: string;
  readonly primaryIntent: string;
}

export interface LibraryView {
  readonly songs: readonly { readonly id: string; readonly title: string; readonly detail: string; readonly selected: boolean; readonly intent: string }[];
  readonly message: string;
}

export interface ProgressView {
  readonly attempts: readonly { readonly key: string; readonly title: string; readonly when: string; readonly text: string }[];
  readonly emptyText: string;
}

export function toHomeView(state: ShellState): HomeView {
  const first = state.songs[0];
  return {
    tagline: 'Groove to any tune.',
    journey: ['Choose a song', 'Tune your guitar', 'Listen to it', 'Practise, slowly at first', 'Review what to repeat', 'Repeat'],
    primaryLabel: first === undefined ? 'Open the library' : `Practise ${first.reference.song.title}`,
    primaryIntent: first === undefined ? 'navigate=library' : `library.choose=${first.id}`,
  };
}

export function toLibraryView(state: ShellState): LibraryView {
  return {
    songs: state.songs.map((s) => ({ id: s.id, title: s.reference.song.title, detail: `${s.origin}${s.reference.review.state === 'unreviewed' ? ' — an unreviewed transcription' : ''}`, selected: s.id === state.selected, intent: `library.choose=${s.id}` })),
    message: state.libraryMessage,
  };
}

export function toProgressView(state: ShellState, when: (iso: string) => string): ProgressView {
  return {
    attempts: state.attempts.map((a, i) => ({ key: `${a.when}-${i}`, title: a.songTitle, when: when(a.when), text: a.text })),
    emptyText: state.attempts.length === 0 ? 'No attempts yet: practise a song, and each attempt is listed here.' : '',
  };
}
