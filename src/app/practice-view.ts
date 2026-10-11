/**
 * The practice screen's view: everything the .obix components show, formatted here — words for every state, positions as suggestions, the fretboard's
 * geometry as numbers. The components bind it and format nothing (CONTRIBUTING, "Keep the layers").
 */
import type { NoteResult } from '../lesson/assessment.ts';
import { noteOf } from '../domain/pitch.ts';
import type { FretboardMap } from '../music/fretboard.ts';
import { guitarView, shapeText, type GuitarView, type Shape } from './guitar-view.ts';
import type { PracticeState, Target } from './practice.ts';

export interface Option {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface PracticeView {
  readonly available: boolean;
  readonly title: string;
  readonly arrangementText: string;
  readonly phase: string;
  readonly phaseText: string;
  readonly running: boolean;
  readonly canConfigure: boolean;
  readonly tempoOptions: readonly Option[];
  readonly fromBarOptions: readonly Option[];
  readonly toBarOptions: readonly Option[];
  readonly modeOptions: readonly Option[];
  readonly handOptions: readonly Option[];
  readonly metronome: boolean;
  readonly playReference: boolean;
  readonly countInText: string;
  readonly currentText: string;
  readonly positionText: string;
  readonly nextText: string;
  readonly heardText: string;
  readonly stepMessage: string;
  readonly microphoneText: string;
  readonly headphonesText: string;
  readonly latencyText: string;
  /** the guitar, horizontal — the artwork for context, the enlarged fretboard beneath it to read (src/app/guitar-view.ts) */
  readonly guitar: GuitarView;
  /** said to a screen reader when it changes: the phase, never every note of a flowing passage */
  readonly announcement: string;
  readonly review: { readonly visible: boolean; readonly sentences: readonly string[]; readonly bars: readonly { readonly bar: number; readonly text: string }[]; readonly repeatBar: string; readonly repeatLabel: string; readonly attemptText: string };
  readonly errorText: string;
}

/** Where a target goes on the guitar, as the guitar view draws it. */
export const shapeOf = (t: Target | null): Shape | null => (t === null || t.position === null ? null : { kind: 'note', key: t.key, string: t.position.string, fret: t.position.fret, finger: t.position.finger });

export function positionText(t: Target | null): string {
  return shapeText(shapeOf(t));
}

const noteText = (t: Target | null): string => (t === null ? '' : noteOf(t.key).label);

export interface PracticeViewContext {
  readonly map: FretboardMap;
  readonly artworkUrl: string;
  readonly leftHanded: boolean;
  /** the content's width, CSS pixels: the fretboard is drawn for it */
  readonly width: number;
  readonly microphone: 'off' | 'starting' | 'on' | 'denied' | 'unavailable';
  readonly latencyText: string;
  readonly errorText: string;
}

const resultText = (results: readonly NoteResult[], bar: number): string => {
  const inBar = results.filter((r) => r.expected.bar === bar);
  const right = inBar.filter((r) => r.pitch === 'correct').length;
  const onTime = inBar.filter((r) => r.timing === 'on-time').length;
  const missed = inBar.filter((r) => r.pitch === 'missed').length;
  return `${right} of ${inBar.length} right${inBar.some((r) => r.timing !== null) ? `, ${onTime} on time` : ''}${missed > 0 ? `, ${missed} not heard` : ''}`;
};

export function toPracticeView(state: PracticeState | null, ctx: PracticeViewContext): PracticeView {
  if (state === null) {
    return {
      available: false, title: '', arrangementText: 'Choose a song in the Library to practise it.', phase: 'none', phaseText: '', running: false, canConfigure: false,
      tempoOptions: [], fromBarOptions: [], toBarOptions: [], modeOptions: [], handOptions: [], metronome: false, playReference: false, countInText: '', currentText: '',
      positionText: '', nextText: '', heardText: '', stepMessage: '', microphoneText: '', headphonesText: '', latencyText: '',
      guitar: guitarView(ctx.map, ctx.artworkUrl, null, null, ctx.width, ctx.leftHanded ? 'left' : 'right'), announcement: '',
      review: { visible: false, sentences: [], bars: [], repeatBar: '', repeatLabel: '', attemptText: '' }, errorText: ctx.errorText,
    };
  }
  const s = state.settings;
  const running = state.phase === 'count-in' || state.phase === 'playing';
  const bars = Array.from({ length: state.bars + 1 }, (_, b) => b);
  const loopFrom = s.loop?.fromBar ?? 0;
  const loopTo = s.loop?.toBar ?? state.bars;
  const last = state.heard[state.heard.length - 1];
  const lastPass = state.passes[state.passes.length - 1];
  const attemptText =
    state.attempt.kind === 'saved' ? `This attempt is saved (${state.attempt.events} events), apart from the reference.`
    : state.attempt.kind === 'recording' ? 'Recording this attempt…'
    : state.attempt.kind === 'failed' ? `This attempt was not saved: ${state.attempt.message}`
    : state.attempt.kind === 'unavailable' ? `This attempt is not saved: ${state.attempt.why}.`
    : '';
  const phaseText =
    state.phase === 'ready' ? (s.mode === 'step' ? 'Ready. In step mode the music waits for each note.' : 'Ready. Press Start: a count-in, then play along.')
    : state.phase === 'count-in' ? `Get ready… ${Math.ceil(state.secondsToStart ?? 0)}`
    : state.phase === 'playing' ? (s.mode === 'step' ? 'Play the note shown. I wait for it.' : `Playing — pass ${state.pass + 1}`)
    : 'Review';
  return {
    available: true,
    title: state.title,
    arrangementText: state.arrangementText,
    phase: state.phase,
    phaseText,
    running,
    canConfigure: !running,
    tempoOptions: [0.5, 0.75, 1].map((f) => ({ value: String(f), label: `${Math.round(f * 100)} %${f === 1 ? ' (as written)' : ''}`, selected: Math.abs(s.tempoFactor - f) < 1e-9 })),
    fromBarOptions: bars.map((b) => ({ value: String(b), label: b === 0 ? 'the pickup' : `bar ${b}`, selected: b === loopFrom })),
    toBarOptions: bars.filter((b) => b >= loopFrom).map((b) => ({ value: String(b), label: b === 0 ? 'the pickup' : `bar ${b}`, selected: b === loopTo })),
    modeOptions: [
      { value: 'flow', label: 'Play along (keeps time)', selected: s.mode === 'flow' },
      { value: 'step', label: 'Step by step (waits for you)', selected: s.mode === 'step' },
    ],
    handOptions: [
      { value: 'right', label: 'Right-handed', selected: !ctx.leftHanded },
      { value: 'left', label: 'Left-handed', selected: ctx.leftHanded },
    ],
    metronome: s.metronome,
    playReference: s.playReference,
    countInText: state.phase === 'count-in' ? `Starting in ${Math.ceil(state.secondsToStart ?? 0)}` : '',
    currentText: state.current === null ? (state.phase === 'reviewing' ? '' : '—') : `${state.phase === 'ready' ? 'First' : 'Now'}: ${noteText(state.current)}`,
    positionText: positionText(state.current),
    nextText: state.next === null ? '' : `Then: ${noteText(state.next)}`,
    heardText: last === undefined ? '' : `Heard ${noteOf(last.key).label}${Math.abs(last.cents) >= 5 ? `, ${Math.abs(Math.round(last.cents))} cents ${last.cents < 0 ? 'flat' : 'sharp'}` : ''}`,
    stepMessage: state.stepMessage ?? '',
    microphoneText:
      ctx.microphone === 'on' ? 'Microphone on — what it hears is analysed on this device and never uploaded.'
      : ctx.microphone === 'starting' ? 'Asking for the microphone…'
      : ctx.microphone === 'denied' ? 'The microphone was not allowed: practice needs it to hear you. Allow it and press Start again.'
      : ctx.microphone === 'unavailable' ? 'No microphone is available here.'
      : 'Microphone off.',
    headphonesText: s.playReference ? 'Use headphones: if the microphone hears the speaker, it can mistake the reference for you.' : '',
    latencyText: ctx.latencyText,
    guitar: guitarView(ctx.map, ctx.artworkUrl, shapeOf(state.current), shapeOf(state.next), ctx.width, ctx.leftHanded ? 'left' : 'right'),
    announcement:
      state.phase === 'ready' ? ''
      : state.phase === 'count-in' ? 'Count-in'
      : state.phase === 'playing' ? (s.mode === 'step' ? `Play ${noteText(state.current)}` : `Playing, pass ${state.pass + 1}`)
      : `Review: ${state.feedback?.sentences[0] ?? 'done'}`,
    review: {
      visible: state.phase === 'reviewing' || state.passes.length > 0,
      sentences: state.feedback?.sentences ?? [],
      bars: lastPass === undefined ? [] : [...new Set(lastPass.results.map((r) => r.expected.bar))].sort((a, b) => a - b).map((bar) => ({ bar, text: `${bar === 0 ? 'Pickup' : `Bar ${bar}`}: ${resultText(lastPass.results, bar)}` })),
      repeatBar: state.feedback?.repeatBar === null || state.feedback === null ? '' : String(state.feedback.repeatBar),
      repeatLabel: state.feedback?.repeatBar === null || state.feedback === null ? '' : `Practise bar ${state.feedback.repeatBar} slowly`,
      attemptText,
    },
    errorText: ctx.errorText,
  };
}
