/**
 * The app, composed: the journey's shell (src/app/shell.ts), the tuner (the existing TuningSession and its announcement policy), the practice session of the
 * song chosen, Play's session (src/app/play.ts), the practice audio (one clock for capture and playback), the microphone and the live analysis between
 * them (src/harness/listener.ts — one, shared: Practise or Play has it, never both), and the recorder that keeps attempts — when there is one. It gives the UI one view (ShellView) and takes its intents (the handlers). It is driven the same in the browser, in the Android WebView and in the
 * tests: what it touches outside — audio, files, hashing, the display's frame timing — is given to it.
 */
import { Announcer } from '../app/announcer.ts';
import { melodyArrangement } from '../app/arrangement.ts';
import { inputView, reportedTotal, timingLines } from '../app/input-view.ts';
import { PlaySession } from '../app/play.ts';
import { playAttemptText, toPlayView } from '../app/play-view.ts';
import { PracticeSession, type AttemptStore } from '../app/practice.ts';
import { toPracticeView } from '../app/practice-view.ts';
import { IMPORT_NOTE, Shell, toHomeView, toLibraryView, toProgressView, type Screen, type Song } from '../app/shell.ts';
import { navOf, type ShellView } from '../app/shell-view.ts';
import { toView } from '../app/view.ts';
import type { Scheduler } from '../domain/ports.ts';
import { referenceFromMidi } from '../music/reference.ts';
import { FRETBOARD_MAP, FUR_ELISE_MIDI_BASE64, GUITAR_ARTWORK_DATA_URL } from './assets.generated.ts';
import type { ComposedAnyTune } from './compose.ts';
import { Listener } from './listener.ts';
import type { PracticeAudio } from './practice-audio.ts';

const running = (p: PracticeSession): boolean => p.getState().phase === 'count-in' || p.getState().phase === 'playing';

export interface ShellDeps {
  readonly tuning: Pick<ComposedAnyTune, 'session' | 'catalog' | 'input'>;
  readonly clock: Scheduler;
  readonly audio: PracticeAudio | null;
  /** the recorder, or why there is none (said with every attempt) */
  readonly recorder: { readonly store: AttemptStore } | { readonly store: null; readonly why: string };
  /** the file chosen in an input of the UI (#midi-file, #obr-file), read; null when none was chosen */
  readonly readFile: (inputId: string) => Promise<{ readonly name: string; readonly bytes: Uint8Array } | null>;
  readonly sha256: (bytes: Uint8Array) => Promise<string>;
  /** run at the display's next frame; returns a cancel — requestAnimationFrame in the browser */
  readonly frame: (run: () => void) => () => void;
  /** wall-clock ISO time: metadata only */
  readonly now?: () => string;
  /** a timestamp for the learner */
  readonly when?: (iso: string) => string;
}

export interface ShellHandlers {
  navigate(screen: string): void;
  begin(): void;
  choose(id: string): void;
  importRecording(): void;
  openMidi(): Promise<void>;
  openObr(): Promise<void>;
  tuneInstrument(id: string): void;
  tuneInput(id: string): void;
  tuneStart(): void;
  tuneStop(): void;
  /** Start: open and check the microphone (an assessed attempt) */
  practiceStart(): Promise<void>;
  /** Begin: the input is ready — count in and play, assessed */
  practiceBegin(): Promise<void>;
  /** Cancel the microphone check */
  practiceCancel(): void;
  /** Play along without assessment: no microphone, no verdict */
  practiceFree(): Promise<void>;
  practiceStop(): Promise<void>;
  /** Play: choose the song */
  playSong(id: string): void;
  /** Play the song without feedback */
  playStart(): Promise<void>;
  /** Play with feedback: open and check the microphone first */
  playFeedback(): Promise<void>;
  /** the microphone is ready: count in and play, with feedback */
  playBegin(): Promise<void>;
  playCancel(): void;
  playPause(): void;
  playResume(): void;
  playRestart(): void;
  playStop(): void;
  playTempo(value: string): void;
  playReferenceVolume(value: string): void;
  playClickVolume(value: string): void;
  playMetronome(on: boolean): void;
  practiceListen(): void;
  practiceRepeat(bar: string): void;
  practiceTempo(value: string): void;
  practiceFrom(value: string): void;
  practiceTo(value: string): void;
  practiceMode(value: string): void;
  practiceHand(value: string): void;
  practiceMetronome(on: boolean): void;
  practiceReference(on: boolean): void;
}

const bytesOfBase64 = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** The song AnyTune comes with: Für Elise's opening, the public-domain score encoded for AnyTune — its melody (track 1) after a two-sixteenth pickup. */
export function bundledSongs(): Song[] {
  const bytes = bytesOfBase64(FUR_ELISE_MIDI_BASE64);
  const made = referenceFromMidi(bytes, {
    song: { id: 'fur-elise', title: 'Für Elise (opening)', composer: 'Ludwig van Beethoven' },
    arrangement: { id: 'fur-elise-guitar-melody', version: 1, instrument: 'acoustic-guitar', part: 'melody' },
    provenance: { kind: 'midi-import', midi: { role: 'midi', fileName: 'fur-elise-opening.mid', mediaType: 'audio/midi', sha256: 'c82120509bb3bec94baab0ab8857f33c72d3eff1d6bb971dcf4711e5916e78fd', bytes: bytes.length } },
  });
  if (!made.ok) throw new Error(`the bundled song does not read: ${made.reason}`);
  return [{ id: 'fur-elise', reference: made.reference, melodyTrack: 1, pickupTicks: 240, origin: 'Bundled: Beethoven’s score (public domain), encoded for AnyTune; the melody, for guitar' }];
}

export class ShellApp {
  readonly shell: Shell;
  readonly handlers: ShellHandlers;
  readonly #deps: ShellDeps;
  readonly #announcer: Announcer;
  readonly #listeners = new Set<() => void>();
  readonly #offs: (() => void)[] = [];
  #announcement = '';
  #error = '';
  #leftHanded = false;
  /** the microphone, for assessed attempts — null where there is no Web Audio */
  readonly #listener: Listener | null;
  /** while an assessed run listens: what is wrong with the capture now, or '' */
  #alert = '';
  #cancelFrame: (() => void) | null = null;
  /** who has the microphone while it listens: Practise or Play */
  #listeningFor: 'practice' | 'play' | null = null;
  /** Play: the song chosen there, its session, and the runs already listed in Progress */
  #play: { readonly songId: string; readonly session: PlaySession; readonly off: () => void; readonly listed: Set<number> } | null = null;
  #playFrame: (() => void) | null = null;
  /** the reference's and the click's levels, 0…1 */
  #levels = { reference: 0.8, click: 0.6 };
  /** the content's width, CSS pixels — measured by the page (main.ts); a phone's until it is */
  #width = 328;

  constructor(deps: ShellDeps, songs: readonly Song[] = bundledSongs()) {
    this.#deps = deps;
    const store = deps.recorder.store;
    const why = deps.recorder.store === null ? deps.recorder.why : '';
    this.shell = new Shell(songs, (song) => new PracticeSession(song.reference, song.melodyTrack, { pickupTicks: song.pickupTicks, playback: deps.audio?.playback ?? null, store, storeUnavailableWhy: why }), deps.now);
    this.#listener = deps.audio === null ? null : new Listener(deps.audio, deps.frame, () => this.#changed());
    this.#announcer = new Announcer(deps.clock);
    this.#offs.push(this.#announcer.subscribe((text) => {
      this.#announcement = text;
      this.#changed();
    }));
    this.#offs.push(deps.tuning.session.subscribe((state) => {
      this.#announcer.observe(state);
      this.#changed();
    }));
    this.#offs.push(this.shell.subscribe(() => {
      // a practice that ends by itself (step mode done, the piece over) releases the microphone
      const phase = this.shell.practice?.getState().phase;
      if (phase === 'reviewing' && this.#listeningFor === 'practice' && this.#listener?.state.kind === 'listening') this.#endRun();
      this.#changed();
    }));
    this.handlers = this.#makeHandlers();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Play's session for the song chosen there — null until the Play screen was opened */
  get playSession(): PlaySession | null {
    return this.#play?.session ?? null;
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }

  view(): ShellView {
    const s = this.shell.getState();
    const t = this.#deps.tuning;
    const practice = this.shell.practice;
    return {
      screen: s.screen,
      nav: navOf(s.screen),
      home: toHomeView(s),
      library: toLibraryView(s),
      progress: toProgressView(s, this.#deps.when ?? ((iso) => iso.slice(11, 16))),
      tuner: toView(t.session.getState(), t.catalog, this.#announcement, t.input()),
      practice: toPracticeView(practice?.getState() ?? null, {
        map: FRETBOARD_MAP,
        artworkUrl: GUITAR_ARTWORK_DATA_URL,
        leftHanded: this.#leftHanded,
        width: this.#width,
        input: inputView(this.#listener?.state ?? { kind: 'idle' }, this.#listener?.levelDb() ?? Number.NEGATIVE_INFINITY, this.#listener?.loudestDb() ?? Number.NEGATIVE_INFINITY),
        timing: timingLines(this.#deps.audio?.latency() ?? null, this.#deps.audio?.captureInfo() ?? this.#listener?.lastRecord()?.info ?? null),
        capture: this.#listener?.lastRecord() ?? null,
        alertText: this.#alert,
        errorText: this.#error,
      }),
      play: toPlayView(this.#play?.session.getState() ?? null, {
        songs: s.songs.map((song) => ({ id: song.id, title: song.reference.song.title })),
        songId: this.#play?.songId ?? null,
        map: FRETBOARD_MAP,
        artworkUrl: GUITAR_ARTWORK_DATA_URL,
        leftHanded: this.#leftHanded,
        width: this.#width,
        input: inputView(this.#listener?.state ?? { kind: 'idle' }, this.#listener?.levelDb() ?? Number.NEGATIVE_INFINITY, this.#listener?.loudestDb() ?? Number.NEGATIVE_INFINITY),
        timing: timingLines(this.#deps.audio?.latency() ?? null, this.#deps.audio?.captureInfo() ?? this.#listener?.lastRecord()?.info ?? null),
        capture: this.#listener?.lastRecord() ?? null,
        alertText: this.#alert,
        levels: this.#levels,
        errorText: this.#error,
      }),
    };
  }

  /** Play's session for a song — the one chosen there, else the one chosen to practise, else the first; made when first needed. */
  #playFor(songId: string | null): PlaySession | null {
    const state = this.shell.getState();
    const song = state.songs.find((x) => x.id === songId) ?? state.songs.find((x) => x.id === this.#play?.songId) ?? state.songs.find((x) => x.id === state.selected) ?? state.songs[0];
    if (song === undefined) return null;
    if (this.#play?.songId === song.id) return this.#play.session;
    this.#stopPlay();
    this.#play?.off();
    const session = new PlaySession(song.reference, melodyArrangement(song.reference, song.melodyTrack, song.pickupTicks), { playback: this.#deps.audio?.playback ?? null, pickupTicks: song.pickupTicks });
    const listed = new Set<number>();
    const off = session.subscribe((st) => {
      if (st.phase === 'finished') {
        this.#playFrame?.();
        this.#playFrame = null;
        if (this.#listeningFor === 'play') this.#endRun();
        if (st.run > 0 && !listed.has(st.run)) {
          listed.add(st.run);
          this.shell.addAttempt(song.reference.song.title, playAttemptText(st));
        }
      }
      this.#changed();
    });
    this.#play = { songId: song.id, session, off, listed };
    return session;
  }

  /** Play's display loop: the session's tick — the prompts placed where the sound is heard (the output's reported delay) — and the capture's alert. */
  #playLoop(): void {
    const audio = this.#deps.audio;
    const session = this.#play?.session;
    if (audio === null || session === undefined) return;
    this.#playFrame?.();
    const now = audio.now();
    const l = audio.latency();
    session.tick(now, (l.baseSeconds ?? 0) + (l.outputSeconds ?? 0));
    if (this.#listeningFor === 'play') {
      const alert = this.#listener?.alert(now) ?? '';
      if (alert !== this.#alert) {
        this.#alert = alert;
        this.#changed();
      }
    }
    const phase = session.getState().phase;
    this.#playFrame = phase === 'count-in' || phase === 'playing' ? this.#deps.frame(() => this.#playLoop()) : null;
  }

  /** Play's run, ended: stopped and reviewed (a pause is still a run). */
  #stopPlay(): void {
    const session = this.#play?.session;
    const phase = session?.getState().phase;
    if (session !== undefined && (phase === 'count-in' || phase === 'playing' || phase === 'paused')) session.stop(this.#deps.audio?.now() ?? 0);
    this.#playFrame?.();
    this.#playFrame = null;
  }

  /** The content's width changed (a rotation, a window resized, a larger text size): the fretboard is drawn again for it. */
  layout(width: number): void {
    const w = Math.round(width);
    if (!(w > 0) || w === this.#width) return;
    this.#width = w;
    this.#changed();
  }

  /** The page is hidden, or the app leaves the foreground: nothing keeps listening, and nothing keeps playing. */
  pause(): void {
    const phase = this.shell.practice?.getState().phase;
    if (phase === 'count-in' || phase === 'playing') void this.handlers.practiceStop();
    this.#stopPlay();
    this.#listener?.close();
    this.#listeningFor = null;
    void this.#deps.tuning.session.stop();
  }

  dispose(): void {
    this.pause();
    for (const off of this.#offs) off();
    this.#announcer.dispose();
  }

  /** A run ended (stopped, or by itself): the display's loop stops and the microphone is released — its capture kept for the review. Once. */
  #endRun(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    this.#listener?.close();
    this.#listeningFor = null;
  }

  #tickLoop(): void {
    const audio = this.#deps.audio;
    const practice = this.shell.practice;
    if (audio === null || practice === null) return;
    const now = audio.now();
    practice.tick(now);
    const alert = this.#listener?.alert(now) ?? '';
    if (alert !== this.#alert) {
      this.#alert = alert;
      this.#changed();
    }
    const phase = practice.getState().phase;
    if (phase === 'count-in' || phase === 'playing') this.#cancelFrame = this.#deps.frame(() => this.#tickLoop());
  }

  #makeHandlers(): ShellHandlers {
    const practice = (): PracticeSession | null => this.shell.practice;
    const configure = (patch: Parameters<PracticeSession['configure']>[0]): void => practice()?.configure(patch);
    return {
      navigate: (screen) => {
        if (screen !== 'tune') void this.#deps.tuning.session.stop();
        const leaving = this.shell.getState().screen;
        // a run belongs to its screen: leaving it ends the run, and a microphone check in progress
        if (leaving === 'practice' && screen !== 'practice') {
          const p = practice();
          if (p !== null && running(p)) void this.handlers.practiceStop();
          else if (this.#listeningFor === null) this.#listener?.close();
        }
        if (leaving === 'play' && screen !== 'play') {
          this.#stopPlay();
          if (this.#listeningFor === null) this.#listener?.close();
        }
        if (screen === 'play') this.#playFor(null);
        // Practise opens on a song: the one chosen, else the first — as Play does
        const first = this.shell.getState().songs[0];
        if (screen === 'practice' && this.shell.practice === null && first !== undefined) {
          this.shell.choose(first.id);
          return;
        }
        this.shell.navigate(screen as Screen);
      },
      begin: () => {
        const first = this.shell.getState().songs[0];
        if (first === undefined) this.shell.navigate('library');
        else this.shell.choose(first.id);
      },
      choose: (id) => {
        this.#error = '';
        this.shell.choose(id);
      },
      importRecording: () => this.shell.explainImport(),
      openMidi: async () => {
        const file = await this.#deps.readFile('midi-file');
        if (file !== null) this.shell.openMidi(file.name, file.bytes, await this.#deps.sha256(file.bytes));
      },
      openObr: async () => {
        const file = await this.#deps.readFile('obr-file');
        if (file !== null) this.shell.openObr(file.name, file.bytes);
      },
      tuneInstrument: (id) => this.#deps.tuning.session.selectInstrument(id),
      tuneInput: (id) => void this.#deps.tuning.session.selectInput(id),
      tuneStart: () => void this.#deps.tuning.session.start(),
      tuneStop: () => void this.#deps.tuning.session.stop(),
      practiceStart: async () => {
        // an assessed attempt starts with the microphone: asked for, then checked — the learner plucks a string — before anything is judged
        const p = practice();
        if (p === null || running(p)) return;
        if (this.#listener === null) {
          this.#error = 'This browser has no Web Audio: practice cannot hear you here.';
          this.#changed();
          return;
        }
        await this.#deps.tuning.session.stop(); // one thing listens at a time
        this.#error = '';
        await this.#listener.open();
      },
      practiceBegin: async () => {
        const p = practice();
        const audio = this.#deps.audio;
        const listener = this.#listener;
        if (p === null || audio === null || listener === null || running(p)) return;
        p.configure({ inputLatencySeconds: reportedTotal(audio.latency()) });
        const coverage = listener.listen();
        if (coverage === null) return;
        this.#listeningFor = 'practice';
        listener.onEvents = (events) => p.hear(events);
        this.#alert = '';
        await p.start(audio.now(), { assess: true, capture: coverage });
        this.#tickLoop();
        this.#changed();
      },
      practiceCancel: () => this.#listener?.close(),
      practiceFree: async () => {
        // played along without assessment: no microphone, no verdict
        const p = practice();
        const audio = this.#deps.audio;
        if (p === null || running(p)) return;
        if (audio === null) {
          this.#error = 'This browser has no Web Audio: nothing can be played here.';
          this.#changed();
          return;
        }
        this.#listener?.close();
        await this.#deps.tuning.session.stop();
        this.#error = '';
        this.#alert = '';
        await p.start(audio.now(), { assess: false });
        this.#tickLoop();
        this.#changed();
      },
      practiceStop: async () => {
        const p = practice();
        const audio = this.#deps.audio;
        if (p === null) return;
        await p.stop(audio?.now() ?? Number.NaN);
        this.#endRun();
        this.#changed();
      },
      playSong: (id) => {
        const phase = this.#play?.session.getState().phase;
        if (phase === 'count-in' || phase === 'playing' || phase === 'paused') return;
        this.#playFor(id);
        this.#changed();
      },
      playStart: async () => {
        const session = this.#playFor(null);
        const audio = this.#deps.audio;
        if (session === null) return;
        if (audio === null) {
          this.#error = 'This browser has no Web Audio: nothing can be played here.';
          this.#changed();
          return;
        }
        this.#listener?.close();
        await this.#deps.tuning.session.stop();
        this.#error = '';
        this.#alert = '';
        audio.setLevels(this.#levels.reference, this.#levels.click);
        session.configure(audio.now(), { inputLatencySeconds: 0 });
        session.start(audio.now(), { assess: false });
        this.#playLoop();
        this.#changed();
      },
      playFeedback: async () => {
        if (this.#playFor(null) === null) return;
        if (this.#listener === null) {
          this.#error = 'This browser has no Web Audio: Play cannot hear you here.';
          this.#changed();
          return;
        }
        await this.#deps.tuning.session.stop();
        this.#error = '';
        await this.#listener.open();
      },
      playBegin: async () => {
        const session = this.#play?.session;
        const audio = this.#deps.audio;
        const listener = this.#listener;
        if (session === undefined || audio === null || listener === null) return;
        session.configure(audio.now(), { inputLatencySeconds: reportedTotal(audio.latency()) });
        const coverage = listener.listen();
        if (coverage === null) return;
        this.#listeningFor = 'play';
        listener.onEvents = (events) => session.hear(events);
        this.#alert = '';
        audio.setLevels(this.#levels.reference, this.#levels.click);
        session.start(audio.now(), { assess: true, capture: coverage });
        this.#playLoop();
        this.#changed();
      },
      playCancel: () => this.#listener?.close(),
      playPause: () => {
        const audio = this.#deps.audio;
        if (audio === null) return;
        this.#play?.session.pause(audio.now());
        this.#playFrame?.();
        this.#playFrame = null;
        this.#changed();
      },
      playResume: () => {
        const audio = this.#deps.audio;
        if (audio === null) return;
        this.#play?.session.resume(audio.now());
        this.#playLoop();
        this.#changed();
      },
      playRestart: () => {
        const audio = this.#deps.audio;
        if (audio === null) return;
        this.#play?.session.restart(audio.now());
        this.#playLoop();
        this.#changed();
      },
      playStop: () => {
        this.#stopPlay();
        this.#changed();
      },
      playTempo: (value) => {
        const audio = this.#deps.audio;
        this.#play?.session.configure(audio?.now() ?? 0, { tempoFactor: Number(value) });
      },
      playReferenceVolume: (value) => {
        this.#levels = { ...this.#levels, reference: Math.max(0, Math.min(1, Number(value) / 100)) };
        this.#deps.audio?.setLevels(this.#levels.reference, this.#levels.click);
        this.#changed();
      },
      playClickVolume: (value) => {
        this.#levels = { ...this.#levels, click: Math.max(0, Math.min(1, Number(value) / 100)) };
        this.#deps.audio?.setLevels(this.#levels.reference, this.#levels.click);
        this.#changed();
      },
      playMetronome: (on) => this.#play?.session.configure(this.#deps.audio?.now() ?? 0, { metronome: on }),
      practiceListen: () => {
        const p = practice();
        const audio = this.#deps.audio;
        if (p === null || audio === null) return;
        const s = p.getState();
        const start = audio.now() + 0.3;
        const first = s.loopTargets[0]?.time ?? 0;
        audio.playback.cancelAll();
        for (const t of s.loopTargets) audio.playback.note(t.key, start + (t.time - first) / s.settings.tempoFactor, 0.4 / s.settings.tempoFactor, 80);
      },
      practiceRepeat: (bar) => configure({ loop: { fromBar: Number(bar), toBar: Number(bar) }, tempoFactor: 0.75 }),
      practiceTempo: (value) => configure({ tempoFactor: Number(value) }),
      practiceFrom: (value) => {
        const p = practice();
        if (p === null) return;
        const to = p.getState().settings.loop?.toBar ?? p.getState().bars;
        configure({ loop: { fromBar: Number(value), toBar: Math.max(Number(value), to) } });
      },
      practiceTo: (value) => {
        const p = practice();
        if (p === null) return;
        configure({ loop: { fromBar: p.getState().settings.loop?.fromBar ?? 0, toBar: Number(value) } });
      },
      practiceMode: (value) => configure({ mode: value === 'step' ? 'step' : 'flow' }),
      practiceHand: (value) => {
        this.#leftHanded = value === 'left';
        this.#changed();
      },
      practiceMetronome: (on) => configure({ metronome: on }),
      practiceReference: (on) => configure({ playReference: on }),
    };
  }
}

export { IMPORT_NOTE };
