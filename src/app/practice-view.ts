/**
 * The practice screen's view: everything the .obix components show, formatted here — words for every state, positions as suggestions, the fretboard's
 * geometry as numbers. The components bind it and format nothing (CONTRIBUTING, "Keep the layers").
 *
 * An assessed attempt is begun only once the microphone was checked (src/app/input-view.ts); playing along without assessment gives no verdict of any
 * kind. The review says how much was assessed, what the capture delivered, and — only when there is enough to go on — which bar to repeat.
 */
import type { NoteResult } from '../lesson/assessment.ts';
import { noteOf } from '../domain/pitch.ts';
import type { FretboardMap } from '../music/fretboard.ts';
import { captureText, type CaptureSummary } from './capture.ts';
import { guitarView, shapeText, type GuitarView, type Shape } from './guitar-view.ts';
import type { InputView } from './input-view.ts';
import type { PracticeState, Target } from './practice.ts';

export interface Option {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface PracticeControls {
  /** open and check the microphone: Start, Start again, Try again */
  readonly start: boolean;
  readonly startLabel: string;
  /** the input is ready: count in and play, assessed */
  readonly begin: boolean;
  readonly cancel: boolean;
  /** play along without assessment */
  readonly free: boolean;
  readonly stop: boolean;
  readonly listen: boolean;
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
  /** a brief word on the last note, while playing: "On time", "A little late", "Try E3" */
  readonly liveText: string;
  readonly input: InputView;
  readonly controls: PracticeControls;
  /** while an assessed run plays: the capture's trouble, now — or '' */
  readonly alertText: string;
  readonly headphonesText: string;
  /** the timing details: what the browser reports, named as it names it (src/app/input-view.ts) */
  readonly timing: readonly string[];
  /** the guitar, horizontal — the artwork for context, the enlarged fretboard beneath it to read (src/app/guitar-view.ts) */
  readonly guitar: GuitarView;
  /** said to a screen reader when it changes: the phase, never every note of a flowing passage */
  readonly announcement: string;
  readonly review: {
    readonly visible: boolean;
    readonly sentences: readonly string[];
    readonly bars: readonly { readonly bar: number; readonly text: string }[];
    readonly repeatBar: string;
    readonly repeatLabel: string;
    readonly attemptText: string;
    /** what the microphone delivered during the attempt: the review's own diagnosis */
    readonly capture: readonly string[];
  };
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
  readonly input: InputView;
  readonly timing: readonly string[];
  /** the last assessed attempt's capture, for the review */
  readonly capture: { readonly summary: CaptureSummary; readonly origin: number } | null;
  readonly alertText: string;
  readonly errorText: string;
}

const resultText = (results: readonly NoteResult[], bar: number): string => {
  const inBar = results.filter((r) => r.expected.bar === bar);
  const assessed = inBar.filter((r) => r.pitch !== 'unassessed');
  if (assessed.length === 0) return 'not assessed';
  const count = (p: NoteResult['pitch']): number => inBar.filter((r) => r.pitch === p).length;
  const onTime = inBar.filter((r) => r.timing === 'on-time').length;
  const parts = [`${count('correct')} of ${assessed.length} right`];
  if (inBar.some((r) => r.timing !== null)) parts.push(`${onTime} on time`);
  if (count('wrong') + count('octave') > 0) parts.push(`${count('wrong') + count('octave')} a different note`);
  if (count('missed') > 0) parts.push(`${count('missed')} not heard`);
  if (count('uncertain') > 0) parts.push(`${count('uncertain')} unclear`);
  if (count('unassessed') > 0) parts.push(`${count('unassessed')} not assessed`);
  return parts.join(', ');
};

const BUSY = ['requesting', 'checking', 'ready'];

export function toPracticeView(state: PracticeState | null, ctx: PracticeViewContext): PracticeView {
  const hand = ctx.leftHanded ? 'left' : 'right';
  if (state === null) {
    return {
      available: false, title: '', arrangementText: 'Choose a song in the Library to practise it.', phase: 'none', phaseText: '', running: false, canConfigure: false,
      tempoOptions: [], fromBarOptions: [], toBarOptions: [], modeOptions: [], handOptions: [], metronome: false, playReference: false, countInText: '', currentText: '',
      positionText: '', nextText: '', heardText: '', stepMessage: '', liveText: '', input: ctx.input,
      controls: { start: false, startLabel: 'Start', begin: false, cancel: false, free: false, stop: false, listen: false }, alertText: '', headphonesText: '', timing: ctx.timing,
      guitar: guitarView(ctx.map, ctx.artworkUrl, null, null, ctx.width, hand), announcement: '',
      review: { visible: false, sentences: [], bars: [], repeatBar: '', repeatLabel: '', attemptText: '', capture: [] }, errorText: ctx.errorText,
    };
  }
  const s = state.settings;
  const running = state.phase === 'count-in' || state.phase === 'playing';
  const busy = BUSY.includes(ctx.input.state);
  const bars = Array.from({ length: state.bars + 1 }, (_, b) => b);
  const loopFrom = s.loop?.fromBar ?? 0;
  const loopTo = s.loop?.toBar ?? state.bars;
  const last = state.heard[state.heard.length - 1];
  const lastPass = state.passes.find((x) => x.pass === state.reviewPass) ?? state.passes[state.passes.length - 1];
  const attemptText =
    state.attempt.kind === 'saved' ? `This attempt is saved (${state.attempt.events} events), apart from the reference.`
    : state.attempt.kind === 'recording' ? 'Recording this attempt…'
    : state.attempt.kind === 'failed' ? `This attempt was not saved: ${state.attempt.message}`
    : state.attempt.kind === 'unavailable' ? `This attempt is not saved: ${state.attempt.why}.`
    : '';
  const phaseText =
    state.phase === 'ready' ? (s.mode === 'step' ? 'Step by step: the music waits for each note. Press Start: the microphone is checked first.' : 'Press Start: the microphone is checked first — pluck a string — then a count-in, and play along.')
    : state.phase === 'count-in' ? `Get ready… ${Math.ceil(state.secondsToStart ?? 0)}`
    : state.phase === 'playing' ? (!state.assessing ? 'Playing along — not assessed' : s.mode === 'step' ? 'Play the note shown. I wait for it.' : `Playing — pass ${state.pass + 1}`)
    : state.assessing ? 'Review' : 'Review — played along without assessment';
  const sentences = !state.assessing ? ['Played along without assessment: nothing was listened to, so there is no score.'] : (state.feedback?.sentences ?? []);
  const repeatBar = state.assessing && state.feedback !== null && state.feedback.repeatBar !== null ? String(state.feedback.repeatBar) : '';
  return {
    available: true,
    title: state.title,
    arrangementText: state.arrangementText,
    phase: state.phase,
    phaseText,
    running,
    canConfigure: !running && !busy,
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
    currentText: state.current === null ? (state.phase === 'reviewing' ? '' : '—') : `${state.phase === 'ready' || state.phase === 'reviewing' ? 'First' : 'Now'}: ${noteText(state.current)}`,
    positionText: positionText(state.current),
    nextText: state.next === null ? '' : `Then: ${noteText(state.next)}`,
    heardText: last === undefined || !running ? '' : `Heard ${noteOf(last.key).label}${Math.abs(last.cents) >= 5 ? `, ${Math.abs(Math.round(last.cents))} cents ${last.cents < 0 ? 'flat' : 'sharp'}` : ''}`,
    stepMessage: state.stepMessage ?? '',
    liveText: running && state.assessing ? state.liveText : '',
    input: ctx.input,
    controls: {
      start: !running && !busy,
      startLabel: ctx.input.problem ? 'Try again' : state.phase === 'reviewing' ? 'Start again' : 'Start',
      begin: !running && ctx.input.state === 'ready',
      cancel: !running && busy,
      free: !running && !busy,
      stop: running,
      listen: !running && !busy,
    },
    alertText: running && state.assessing ? ctx.alertText : '',
    headphonesText: s.playReference ? 'Use headphones: if the microphone hears the speaker, it can mistake the reference for you.' : '',
    timing: ctx.timing,
    guitar: guitarView(ctx.map, ctx.artworkUrl, shapeOf(state.current), shapeOf(state.next), ctx.width, hand),
    announcement:
      state.phase === 'ready' ? ''
      : state.phase === 'count-in' ? 'Count-in'
      : state.phase === 'playing' ? (s.mode === 'step' && state.assessing ? `Play ${noteText(state.current)}` : `Playing, pass ${state.pass + 1}`)
      : `Review: ${sentences[0] ?? 'done'}`,
    review: {
      visible: state.phase === 'reviewing' || state.passes.length > 0,
      sentences,
      bars: !state.assessing || lastPass === undefined ? [] : [...new Set(lastPass.results.map((r) => r.expected.bar))].sort((a, b) => a - b).map((bar) => ({ bar, text: `${bar === 0 ? 'Pickup' : `Bar ${bar}`}: ${resultText(lastPass.results, bar)}` })),
      repeatBar,
      repeatLabel: repeatBar === '' ? '' : `Practise bar ${repeatBar} slowly`,
      attemptText,
      capture: state.phase === 'reviewing' && state.assessing && ctx.capture !== null ? captureText(ctx.capture.summary, ctx.capture.origin) : [],
    },
    errorText: ctx.errorText,
  };
}
