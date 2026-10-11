/**
 * The practice screen's view: everything the .obix components show, formatted here — words for every state, positions as suggestions, the fretboard's
 * geometry as numbers. The components bind it and format nothing (CONTRIBUTING, "Keep the layers").
 */
import type { NoteResult } from '../lesson/assessment.ts';
import { noteOf } from '../domain/pitch.ts';
import type { FretboardMap } from '../music/fretboard.ts';
import { mirrored, targetOf } from '../music/fretboard.ts';
import type { StringNumber } from '../music/guitar.ts';
import type { PracticeState, Target } from './practice.ts';

export interface Option {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface Marker {
  readonly x: number;
  readonly y: number;
  /** where the label's baseline goes */
  readonly textY: number;
  readonly kind: 'current' | 'next';

  /** the finger number, or "0" for an open string — shown inside the marker */
  readonly label: string;
  readonly description: string;
}

export interface DiagramLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly label: string;
  readonly labelX: number;
  readonly labelY: number;
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
  /** the enlarged fretboard: a diagram of the first frets, horizontal */
  readonly diagram: { readonly viewBox: string; readonly hand: 'right' | 'left'; readonly strings: readonly DiagramLine[]; readonly frets: readonly DiagramLine[]; readonly markers: readonly Marker[]; readonly description: string };
  /** the guitar artwork, with the target on its strings */
  readonly artwork: { readonly url: string; readonly viewBox: string; readonly hand: 'right' | 'left'; readonly markers: readonly Marker[]; readonly credit: string };
  readonly review: { readonly visible: boolean; readonly sentences: readonly string[]; readonly bars: readonly { readonly bar: number; readonly text: string }[]; readonly repeatBar: string; readonly repeatLabel: string; readonly attemptText: string };
  readonly errorText: string;
}

const STRING_NAMES: Readonly<Record<StringNumber, string>> = { 1: 'high E', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'low E' };
const FINGERS = ['', 'index', 'middle', 'ring', 'little'];

export function positionText(t: Target | null): string {
  if (t === null || t.position === null) return '';
  const p = t.position;
  return p.fret === 0 ? `${STRING_NAMES[p.string]} string, open — a suggestion` : `${STRING_NAMES[p.string]} string, fret ${p.fret}, ${FINGERS[p.finger ?? 0] ?? ''} finger (${p.finger ?? ''}) — a suggestion`;
}

const noteText = (t: Target | null): string => (t === null ? '' : noteOf(t.key).label);

export interface PracticeViewContext {
  readonly map: FretboardMap;
  readonly artworkUrl: string;
  readonly leftHanded: boolean;
  readonly microphone: 'off' | 'starting' | 'on' | 'denied' | 'unavailable';
  readonly latencyText: string;
  readonly errorText: string;
}

function diagram(state: PracticeState, leftHanded: boolean): PracticeView['diagram'] {
  const width = 640;
  const height = 230;
  const left = 70;
  const right = width - 20;
  const top = 25;
  const gap = 34;
  const frets = 5;
  const fretX = (f: number): number => left + ((right - left) * f) / frets;
  const flip = (x: number): number => (leftHanded ? width - x : x);
  const strings = ([1, 2, 3, 4, 5, 6] as StringNumber[]).map((s, i) => ({ x1: flip(left), y1: top + i * gap, x2: flip(right), y2: top + i * gap, label: s === 1 ? 'e' : s === 6 ? 'E' : STRING_NAMES[s], labelX: leftHanded ? width - 24 : 24, labelY: top + i * gap + 5 }));
  const fretLines = Array.from({ length: frets + 1 }, (_, f) => ({ x1: flip(fretX(f)), y1: top - 8, x2: flip(fretX(f)), y2: top + 5 * gap + 8, label: f === 0 ? '' : String(f), labelX: f === 0 ? 0 : flip((fretX(f - 1) + fretX(f)) / 2), labelY: height - 4 }));
  const markers: Marker[] = [];
  for (const [t, kind] of [[state.current, 'current'], [state.next, 'next']] as const) {
    if (t === null || t.position === null || t.position.fret > frets) continue;
    const p = t.position;
    const x = p.fret === 0 ? fretX(0) - 22 : (fretX(p.fret - 1) + fretX(p.fret)) / 2;
    const y = top + (p.string - 1) * gap;
    markers.push({ x: flip(x), y, textY: y + 6, kind, label: p.fret === 0 ? '0' : String(p.finger ?? ''), description: `${kind === 'current' ? 'Now' : 'Next'}: ${noteOf(t.key).label}, ${positionText(t)}` });
  }
  const description = markers.length === 0 ? 'A fretboard diagram of the first five frets.' : `A fretboard diagram of the first five frets, ${leftHanded ? 'left' : 'right'}-handed. ${markers.map((m) => m.description).join('. ')}.`;
  return { viewBox: `0 0 ${width} ${height}`, hand: leftHanded ? 'left' : 'right', strings, frets: fretLines, markers, description };
}

function artwork(state: PracticeState, ctx: PracticeViewContext): PracticeView['artwork'] {
  const map = ctx.leftHanded ? mirrored(ctx.map) : ctx.map;
  const markers: Marker[] = [];
  for (const [t, kind] of [[state.current, 'current'], [state.next, 'next']] as const) {
    if (t === null || t.position === null) continue;
    const at = targetOf(map, t.position.string, t.position.fret);
    if (at !== null) markers.push({ x: at.x, y: at.y, textY: at.y, kind, label: '', description: `${kind === 'current' ? 'Now' : 'Next'}: ${positionText(t)}` });
  }
  const [x, y, w, h] = ctx.map.source.viewBox;
  return { url: ctx.artworkUrl, viewBox: `${x} ${y} ${w} ${h}`, hand: ctx.leftHanded ? 'left' : 'right', markers, credit: `Guitar artwork: “Guitar, Music, Musical Instrument” by ${map.source.author}, ${map.source.license}` };
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
    const empty: PracticeView['diagram'] = { viewBox: '0 0 640 230', hand: 'right', strings: [], frets: [], markers: [], description: '' };
    return {
      available: false, title: '', arrangementText: 'Choose a song in the Library to practise it.', phase: 'none', phaseText: '', running: false, canConfigure: false,
      tempoOptions: [], fromBarOptions: [], toBarOptions: [], modeOptions: [], handOptions: [], metronome: false, playReference: false, countInText: '', currentText: '',
      positionText: '', nextText: '', heardText: '', stepMessage: '', microphoneText: '', headphonesText: '', latencyText: '', diagram: empty,
      artwork: { url: ctx.artworkUrl, viewBox: '0 0 1 1', hand: 'right', markers: [], credit: '' },
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
    diagram: diagram(state, ctx.leftHanded),
    artwork: artwork(state, ctx),
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
