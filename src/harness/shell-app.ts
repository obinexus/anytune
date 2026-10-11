/**
 * The app, composed: the journey's shell (src/app/shell.ts), the tuner (the existing TuningSession and its announcement policy), the practice session of the
 * song chosen, the practice audio (one clock for capture and playback), the live analysis between them, and the recorder that keeps attempts — when there
 * is one. It gives the UI one view (ShellView) and takes its intents (the handlers). It is driven the same in the browser, in the Android WebView and in the
 * tests: what it touches outside — audio, files, hashing, the display's frame timing — is given to it.
 */
import { Announcer } from '../app/announcer.ts';
import { inputView, reportedTotal, timingLines } from '../app/input-view.ts';
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
      if (phase === 'reviewing' && this.#listener?.state.kind === 'listening') this.#endRun();
      this.#changed();
    }));
    this.handlers = this.#makeHandlers();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    };
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
    else this.#listener?.close();
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
