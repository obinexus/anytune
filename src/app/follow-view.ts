/**
 * The Follow my playing screen's view: the target now — its name, where to play it, which finger, all said apart — held until it is recognised or skipped;
 * the next one previewed; the learning position ("Target 7 of 35 · bar 2") kept apart from the session's elapsed time; what was heard; and, per pass, how
 * it went: first tries, corrections with their retries, skips, unassessed targets — and, for a repeated phrase, the comparison with its last pass.
 */
import type { FretboardMap } from '../music/fretboard.ts';
import type { Beat } from '../lesson/play-clock.ts';
import type { GuitarTuning, StringNumber } from '../music/guitar.ts';
import { captureText, type CaptureSummary } from './capture.ts';
import { FINGER_NAMES, fingerTextOf, guitarView, instructionOf, type GuitarView, type Shape } from './guitar-view.ts';
import { passSummary, type FollowPass, type FollowState, type FollowTarget } from './follow.ts';
import { capoOptions } from './capo.ts';
import type { InputView } from './input-view.ts';
import { playModes, type PlayMode } from './play-modes.ts';
import { timelineView, type TimelineView } from './play-view.ts';
import type { Option } from './practice-view.ts';

export interface FollowControls {
  /** open and check the microphone */
  readonly start: boolean;
  readonly startLabel: string;
  readonly begin: boolean;
  readonly cancel: boolean;
  readonly hear: boolean;
  readonly fingering: boolean;
  readonly fingeringLabel: string;
  readonly skip: boolean;
  readonly repeatBar: boolean;
  /** while the microphone is out: move on, the target unassessed */
  readonly moveOn: boolean;
  /** the microphone ended: check it again, then go on from the same place */
  readonly recheck: boolean;
  /** after a phrase */
  readonly again: boolean;
  readonly continueOn: boolean;
  readonly stop: boolean;
}

/** The fretting hand's fingers, drawn: where each fingertip's number goes on the legend (an original drawing — src/components/HandLegend.obix). */
const FINGERTIPS: Readonly<Record<number, { readonly cx: number; readonly cy: number }>> = { 1: { cx: 59, cy: 34 }, 2: { cx: 87, cy: 20 }, 3: { cx: 115, cy: 28 }, 4: { cx: 142, cy: 48 } };

export interface FollowView {
  readonly available: boolean;
  readonly modes: readonly PlayMode[];
  readonly songOptions: readonly Option[];
  readonly arrangementOptions: readonly Option[];
  readonly title: string;
  readonly arrangementText: string;
  readonly phase: string;
  readonly phaseText: string;
  readonly listening: boolean;
  /** "Target 7 of 35 · bar 2" */
  readonly positionText: string;
  /** "Session 1:23": elapsed time, not the song's */
  readonly sessionText: string;
  /** the target now, by name: D♯4 or Am */
  readonly currentName: string;
  readonly instruction: string;
  readonly fingerText: string;
  readonly nextText: string;
  readonly message: { readonly text: string; readonly tone: string };
  readonly alertText: string;
  readonly controls: FollowControls;
  readonly input: InputView;
  readonly guitar: GuitarView;
  readonly hand: { readonly visible: boolean; readonly fingers: readonly { readonly number: string; readonly name: string; readonly active: boolean; readonly cx: number; readonly cy: number; readonly textY: number; readonly key: string; readonly textKey: string; readonly nameKey: string }[]; readonly text: string };
  readonly timeline: TimelineView;
  readonly summary: { readonly visible: boolean; readonly lines: readonly string[]; readonly corrections: readonly string[]; readonly comparison: string };
  readonly settings: {
    readonly tempoOptions: readonly Option[];
    readonly accompanimentOptions: readonly Option[];
    /** said when the song has no separate parts to queue */
    readonly accompanimentNote: string;
    readonly headphones: boolean;
    readonly confidenceOptions: readonly Option[];
    readonly windowOptions: readonly Option[];
    readonly capoOptions: readonly Option[];
    readonly handOptions: readonly Option[];
    /** the detection settings change only while the microphone is closed */
    readonly detectionLocked: boolean;
  };
  readonly capture: readonly string[];
  readonly timing: readonly string[];
  readonly announcement: string;
  readonly errorText: string;
}

export interface FollowViewContext {
  readonly songs: readonly { readonly id: string; readonly title: string }[];
  readonly songId: string | null;
  readonly map: FretboardMap;
  readonly artworkUrl: string;
  readonly leftHanded: boolean;
  readonly width: number;
  readonly tuning: GuitarTuning;
  readonly beats: readonly Beat[];
  readonly input: InputView;
  /** the microphone is open and listening for this mode */
  readonly listening: boolean;
  readonly timing: readonly string[];
  readonly capture: { readonly summary: CaptureSummary; readonly origin: number } | null;
  readonly alertText: string;
  readonly showFingering: boolean;
  /** the observation window's end, seconds after an attack */
  readonly windowSeconds: number;
  /** the audio clock now, for the session's elapsed time */
  readonly now: number;
  readonly errorText: string;
}

const clockText = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const BUSY = ['requesting', 'checking', 'ready'];

export const shapeOfTarget = (t: FollowTarget | null): Shape | null => {
  if (t === null) return null;
  if (t.kind === 'chord') return { kind: 'chord', symbol: t.symbol, voicing: t.voicing };
  const p = t.target.position;
  return p === null ? null : { kind: 'note', key: t.key, string: p.string, fret: p.fret, finger: p.finger };
};

const fingersOf = (shape: Shape | null): Set<number> => {
  if (shape === null) return new Set();
  if (shape.kind === 'note') return new Set(shape.finger === null || shape.fret === 0 ? [] : [shape.finger]);
  return new Set(shape.voicing.fingers.filter((f): f is number => f !== null && f !== undefined));
};

export function toFollowView(state: FollowState | null, ctx: FollowViewContext): FollowView {
  const hand = ctx.leftHanded ? 'left' : 'right';
  const busy = BUSY.includes(ctx.input.state);
  const phase = state?.phase ?? 'ready';
  const current = state?.current ?? null;
  const next = state?.next ?? null;
  const shape = shapeOfTarget(current);
  const nextShape = shapeOfTarget(next);
  const active = fingersOf(ctx.showFingering ? shape : null);
  const settings = state?.settings;
  const tempo = settings?.tempoFactor ?? 1;
  const conf = settings?.consensus.minConfidence ?? 0.6;
  const hasParts = state?.hasParts ?? false;
  const accompaniment = settings?.accompaniment ?? 'none';
  const pass = state?.pass;
  const summary = pass === undefined ? null : passSummary(pass);
  const running = phase === 'listening' || phase === 'demonstrating' || phase === 'input-paused';
  const idle = phase === 'ready' || phase === 'finished' || phase === 'phrase-done';
  const total = state?.targets.length ?? 0;
  const index = state?.index ?? 0;
  const targets = state?.targets ?? [];
  const position = current?.time ?? targets[Math.min(index, targets.length - 1)]?.time ?? 0;
  const phaseText =
    phase === 'ready' ? 'Follow my playing: each target waits for you — no clock, no rush. Start checks the microphone first: pluck a string.'
    : phase === 'listening' ? 'Listening — at your own pace.'
    : phase === 'demonstrating' ? 'Listening paused while the target plays.'
    : phase === 'input-paused' ? 'Paused: the microphone is not delivering sound. Your place is kept.'
    : phase === 'phrase-done' ? 'Phrase done.'
    : 'Finished.';
  const corrections = (pass?.records ?? []).filter((r) => r.outcome === 'corrected').map((r) => `Target ${r.index + 1} · ${r.label}: corrected after ${r.wrong.length} ${r.wrong.length === 1 ? 'retry' : 'retries'} (heard ${r.wrong.join(', ')})`);
  const lines = summary === null || summary.reached === 0 ? [] : [
    `First try: ${summary.firstTry} · Corrected: ${summary.corrected} (${summary.retries} ${summary.retries === 1 ? 'retry' : 'retries'}) · Skipped: ${summary.skipped} · Unassessed: ${summary.unassessed}`,
    ...(summary.medianResponse === null ? [] : [`Typical time to each note: ${summary.medianResponse.toFixed(1)} s — not scored: take your time.`]),
  ];
  return {
    available: state !== null && total > 0,
    modes: playModes('follow'),
    songOptions: ctx.songs.map((s) => ({ value: s.id, label: s.title, selected: s.id === ctx.songId })),
    arrangementOptions: state === null ? [] : [{ value: 'melody', label: state.arrangementLabel, selected: true }],
    title: state?.title ?? '',
    arrangementText: state?.arrangementText ?? 'Choose a song to follow.',
    phase,
    phaseText,
    listening: running,
    positionText: total === 0 ? '' : `Target ${Math.min(index + 1, total)} of ${total}${current === null ? '' : ` · ${current.bar === 0 ? 'the pickup' : `bar ${current.bar}`}`}`,
    sessionText: state?.startedAt === null || state?.startedAt === undefined ? '' : `Session ${clockText(Math.max(0, ctx.now - state.startedAt))}`,
    currentName: current === null ? '' : current.kind === 'chord' ? current.symbol : current.label,
    instruction: instructionOf(shape, ctx.tuning),
    fingerText: shape === null ? '' : `${fingerTextOf(shape)} — a suggestion`,
    nextText: nextShape === null ? '' : `Next: ${instructionOf(nextShape, ctx.tuning).replace(/^Play /, '')}`,
    message: state === null || (state.message.tone === 'info' && /^Play [^.]*$/.test(state.message.text)) ? { text: '', tone: 'info' } : state.message,
    alertText: running ? ctx.alertText : '',
    controls: {
      start: idle && !busy && !ctx.listening,
      startLabel: ctx.input.problem ? 'Try again' : phase === 'ready' ? 'Start listening' : 'Start again from the beginning',
      begin: (!running || phase === 'input-paused') && ctx.input.state === 'ready',
      cancel: !running && busy,
      hear: phase === 'listening',
      fingering: running,
      fingeringLabel: ctx.showFingering ? 'Hide fingering' : 'Show fingering',
      skip: phase === 'listening' || phase === 'demonstrating',
      repeatBar: phase === 'listening',
      moveOn: phase === 'input-paused',
      recheck: phase === 'input-paused' && !busy,
      again: phase === 'phrase-done' && !busy,
      continueOn: phase === 'phrase-done' && !busy && index < total,
      stop: running || phase === 'phrase-done',
    },
    input: ctx.input,
    guitar: guitarView(ctx.map, ctx.artworkUrl, shape, nextShape, ctx.width, hand, ctx.tuning),
    hand: {
      visible: ctx.showFingering && running,
      fingers: [1, 2, 3, 4].map((n) => ({ number: String(n), name: FINGER_NAMES[n] ?? '', active: active.has(n), cx: (FINGERTIPS[n] as { cx: number }).cx, cy: (FINGERTIPS[n] as { cy: number }).cy, textY: (FINGERTIPS[n] as { cy: number }).cy + 6, key: `finger-${n}`, textKey: `finger-number-${n}`, nameKey: `finger-name-${n}` })),
      text: active.size === 0 ? 'No finger presses: open strings only.' : `Use: ${[...active].map((n) => `${(FINGER_NAMES[n] ?? '').toLowerCase()} (${n})`).join(', ')}. Your thumb stays behind the neck.`,
    },
    timeline: timelineView({
      position,
      tempoFactor: 1,
      beats: ctx.beats,
      prompts: targets.map((t) => ({ id: t.id, time: t.time, lane: t.kind === 'note' ? (t.target.position?.string ?? null) as StringNumber | null : null, label: t.kind === 'chord' ? t.symbol : t.target.position === null ? t.label : String(t.target.position.fret) })),
      currentId: current?.id ?? null,
      nextId: next?.id ?? null,
      atPlayhead: true,
      description: current === null ? 'Timeline: nothing to play.' : `Timeline: the reference's rhythm as a guide — ${current.kind === 'chord' ? current.symbol : current.label} at "Now", waiting for you.`,
    }, ctx.width),
    summary: { visible: (summary?.reached ?? 0) > 0, lines, corrections, comparison: state?.comparison ?? '' },
    settings: {
      tempoOptions: [0.5, 0.75, 1].map((f) => ({ value: String(f), label: `${Math.round(f * 100)} %${f === 1 ? ' (as written)' : ''}`, selected: Math.abs(tempo - f) < 1e-9 })),
      accompanimentOptions: [
        ...(hasParts ? [{ value: 'parts', label: 'The other parts, up to the next target', selected: accompaniment === 'parts' }] : []),
        { value: 'click', label: 'The beat only, as a click', selected: accompaniment === 'click' },
        { value: 'none', label: 'None', selected: accompaniment === 'none' },
      ],
      accompanimentNote: hasParts ? '' : 'This song has one part only — a one-track file, or a transcription of a mixed recording. Its instruments cannot be queued separately without separate stems or a transcription per instrument. Choose: the beat as a click between targets, or nothing.',
      headphones: settings?.headphones ?? false,
      confidenceOptions: [0.5, 0.6, 0.7, 0.8].map((c) => ({ value: String(c), label: `${Math.round(c * 100)} %${c === 0.6 ? ' (default)' : ''}`, selected: Math.abs(conf - c) < 1e-9 })),
      windowOptions: [0.09, 0.12, 0.18].map((w) => ({ value: String(w), label: `30–${Math.round(w * 1000)} ms after each attack${w === 0.12 ? ' (default)' : ''}`, selected: Math.abs(ctx.windowSeconds - w) < 1e-9 })),
      capoOptions: capoOptions(ctx.tuning.capo),
      handOptions: [
        { value: 'right', label: 'Right-handed', selected: !ctx.leftHanded },
        { value: 'left', label: 'Left-handed', selected: ctx.leftHanded },
      ],
      detectionLocked: ctx.listening || busy,
    },
    capture: (phase === 'finished' || phase === 'phrase-done') && ctx.capture !== null ? captureText(ctx.capture.summary, ctx.capture.origin) : [],
    timing: ctx.timing,
    announcement: phase === 'listening' && current !== null ? `${state?.message.tone === 'correct' ? 'Correct. ' : state?.message.tone === 'wrong' ? `${state.message.text} ` : ''}Play ${current.kind === 'chord' ? current.symbol : current.label}` : phase === 'finished' ? 'Finished' : phase === 'phrase-done' ? `Phrase done. ${state?.comparison ?? ''}` : '',
    errorText: ctx.errorText,
  };
}

/** A pass in Progress — finished, or stopped part-way. */
export function followPassText(pass: FollowPass): string {
  const s = passSummary(pass);
  return `Follow my playing, targets ${pass.from + 1}–${pass.to + 1}${pass.done ? '' : ` (stopped after ${s.reached})`}: ${s.firstTry} first try, ${s.corrected} corrected (${s.retries} ${s.retries === 1 ? 'retry' : 'retries'}), ${s.skipped} skipped, ${s.unassessed} unassessed`;
}
