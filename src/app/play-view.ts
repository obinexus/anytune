/**
 * The Play screen's view: what to play now — big — and what comes next on a timeline that scrolls past a stationary playhead labelled "Now", with the
 * horizontal guitar and its fretboard, the beat, the song's progress and the controls. Everything formatted here; the components bind it.
 *
 * The timeline is tablature: six lanes, high e on top, each prompt a box on its string with its fret (an open string: 0), arriving at "Now" at its song
 * time — placed by the play clock's position, the same clock the playback is scheduled on (src/app/play.ts). It is drawn at one unit per CSS pixel for the
 * width it is given; time runs at a fixed speed in real seconds, so a slower tempo spreads the prompts out. No lyrics: none of AnyTune's references carries
 * timed lyrics, and none are invented.
 */
import type { NoteResult } from '../lesson/assessment.ts';
import type { FretboardMap } from '../music/fretboard.ts';
import type { StringNumber } from '../music/guitar.ts';
import { captureText, type CaptureSummary } from './capture.ts';
import { guitarView, noteName, shapeText, type GuitarView } from './guitar-view.ts';
import type { InputView } from './input-view.ts';
import type { PlayState } from './play.ts';
import { shapeOf, type Option } from './practice-view.ts';
import type { Beat } from '../lesson/play-clock.ts';
import { capoOptions } from './capo.ts';
import { playModes, type PlayMode } from './play-modes.ts';

export const TIMELINE = Object.freeze({ labelColumn: 30, top: 30, laneGap: 26, bottom: 26, pixelsPerSecond: 200, playheadShare: 0.22, promptWidth: 30, promptHeight: 22 });

export interface TimelinePrompt {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly textX: number;
  readonly textY: number;
  /** the fret (0: open), or the note name when the arrangement has no position */
  readonly label: string;
  /** past · now · next · later */
  readonly kind: string;
  readonly key: string;
  readonly textKey: string;
}

export interface TimelineView {
  readonly width: number;
  readonly height: number;
  readonly viewBox: string;
  readonly playheadX: number;
  readonly playheadTop: number;
  readonly playheadBottom: number;
  readonly labelColumn: number;
  readonly lanes: readonly { readonly y: number; readonly x1: number; readonly x2: number; readonly label: string; readonly labelX: number; readonly labelY: number; readonly key: string; readonly labelKey: string }[];
  readonly bars: readonly { readonly x: number; readonly label: string; readonly labelY: number; readonly key: string; readonly labelKey: string }[];
  readonly beats: readonly { readonly x: number; readonly key: string }[];
  readonly prompts: readonly TimelinePrompt[];
  readonly description: string;
}

const LANE_LABELS: Readonly<Record<StringNumber, string>> = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };

/** What the timeline draws: prompts on string lanes at song times, around a position — Play's clock, or Follow's target. */
export interface TimelineInput {
  /** song seconds at "Now" */
  readonly position: number;
  readonly tempoFactor: number;
  readonly beats: readonly Beat[];
  readonly prompts: readonly { readonly id: string; readonly time: number; readonly lane: StringNumber | null; readonly label: string }[];
  readonly currentId: string | null;
  readonly nextId: string | null;
  /** the current prompt is at "Now" (sounding, or awaited); false in a rest */
  readonly atPlayhead: boolean;
  readonly description: string;
}

/** Play's timeline input: its targets' frets on their strings, at the clock's position. */
export function playTimelineInput(state: PlayState): TimelineInput {
  const finished = state.phase === 'finished';
  const now = finished ? null : state.current;
  return {
    position: finished ? 0 : state.position,
    tempoFactor: state.settings.tempoFactor,
    beats: state.beats,
    prompts: state.arrangement.targets.map((t) => ({ id: t.id, time: t.time, lane: t.position?.string ?? null, label: t.position === null ? noteName(t.key) : String(t.position.fret) })),
    currentId: finished ? (state.arrangement.targets[0]?.id ?? null) : (now?.id ?? null),
    nextId: finished ? null : (state.next?.id ?? null),
    atPlayhead: finished || state.atPlayhead,
    description: now === null ? 'Timeline: the song has ended; it starts again from the beginning.' : `Timeline: now ${noteName(now.key)}${now.position === null ? '' : ` (${shapeText(shapeOf(now))})`}${state.next === null ? '' : `, then ${noteName(state.next.key)}`}.`,
  };
}

export function timelineView(input: TimelineInput, width: number): TimelineView {
  const g = TIMELINE;
  const w = Math.max(240, Math.round(width));
  const top = g.top;
  const laneY = (s: number): number => top + (s - 1) * g.laneGap;
  const height = laneY(6) + g.promptHeight / 2 + g.bottom;
  const playheadX = Math.round(g.labelColumn + (w - g.labelColumn) * g.playheadShare);
  const pps = g.pixelsPerSecond / input.tempoFactor; // pixels per SONG second: a slower tempo spreads the prompts
  const xOf = (songTime: number): number => Math.round((playheadX + (songTime - input.position) * pps) * 10) / 10;
  const from = input.position - (playheadX - g.labelColumn) / pps;
  const to = input.position + (w - playheadX) / pps;
  const lanes = ([1, 2, 3, 4, 5, 6] as StringNumber[]).map((s) => ({ y: laneY(s), x1: g.labelColumn, x2: w, label: LANE_LABELS[s], labelX: g.labelColumn / 2, labelY: laneY(s) + 6, key: `lane-${s}`, labelKey: `lane-label-${s}` }));
  const inView = input.beats.filter((b) => b.time >= from && b.time <= to);
  const bars = inView.filter((b) => b.beat === 1).map((b) => ({ x: xOf(b.time), label: String(b.bar), labelY: height - 4, key: `bar-${b.bar}`, labelKey: `bar-label-${b.bar}` }));
  const beats = inView.filter((b) => b.beat !== 1).map((b) => ({ x: xOf(b.time), key: `beat-${b.time}` }));
  // the prompt at "Now" is filled; in a rest, the one coming is the next one, dashed
  const kindOf = (p: TimelineInput['prompts'][number]): string => (p.id === input.currentId ? (input.atPlayhead ? 'now' : 'next') : p.id === input.nextId && input.atPlayhead ? 'next' : p.time < input.position ? 'past' : 'later');
  const prompts: TimelinePrompt[] = input.prompts
    .filter((p) => p.time >= from - 0.3 && p.time <= to + 0.3)
    .map((p) => {
      const lane = p.lane ?? 3;
      const x = xOf(p.time);
      const width = Math.max(g.promptWidth, 12 + 9 * [...p.label].length);
      return { x: x - width / 2, y: laneY(lane) - g.promptHeight / 2, width, height: g.promptHeight, textX: x, textY: laneY(lane) + 6, label: p.label, kind: kindOf(p), key: `prompt-${p.id}`, textKey: `prompt-text-${p.id}` };
    });
  return { width: w, height, viewBox: `0 0 ${w} ${height}`, playheadX, playheadTop: 22, playheadBottom: laneY(6) + g.promptHeight / 2 + 2, labelColumn: g.labelColumn, lanes, bars, beats, prompts, description: input.description };
}

export interface PlayControls {
  /** start the song without feedback */
  readonly play: boolean;
  readonly playLabel: string;
  /** start with feedback: the microphone is checked first */
  readonly feedback: boolean;
  readonly feedbackLabel: string;
  readonly begin: boolean;
  readonly cancel: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly restart: boolean;
  readonly stop: boolean;
}

export interface PlayView {
  readonly available: boolean;
  readonly modes: readonly PlayMode[];
  readonly title: string;
  readonly songOptions: readonly Option[];
  readonly arrangementOptions: readonly Option[];
  readonly arrangementText: string;
  readonly phase: string;
  readonly phaseText: string;
  readonly playing: boolean;
  readonly currentText: string;
  readonly positionText: string;
  readonly nextText: string;
  readonly liveText: string;
  readonly alertText: string;
  readonly beat: { readonly text: string; readonly dots: readonly { readonly on: boolean; readonly key: string }[] };
  readonly progress: { readonly value: number; readonly text: string };
  readonly timeline: TimelineView;
  readonly guitar: GuitarView;
  readonly controls: PlayControls;
  readonly input: InputView;
  readonly settings: { readonly tempoOptions: readonly Option[]; readonly referenceVolume: string; readonly clickVolume: string; readonly metronome: boolean; readonly handOptions: readonly Option[]; readonly capoOptions: readonly Option[] };
  readonly timing: readonly string[];
  readonly review: { readonly visible: boolean; readonly sentences: readonly string[]; readonly capture: readonly string[] };
  readonly announcement: string;
  readonly errorText: string;
}

export interface PlayViewContext {
  readonly songs: readonly { readonly id: string; readonly title: string }[];
  readonly songId: string | null;
  readonly map: FretboardMap;
  readonly artworkUrl: string;
  readonly leftHanded: boolean;
  readonly width: number;
  readonly input: InputView;
  readonly timing: readonly string[];
  readonly capture: { readonly summary: CaptureSummary; readonly origin: number } | null;
  readonly alertText: string;
  readonly levels: { readonly reference: number; readonly click: number };
  readonly capo: number;
  readonly errorText: string;
}

const clockText = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const BUSY = ['requesting', 'checking', 'ready'];

export function toPlayView(state: PlayState | null, ctx: PlayViewContext): PlayView {
  const hand = ctx.leftHanded ? 'left' : 'right';
  const songOptions = ctx.songs.map((s) => ({ value: s.id, label: s.title, selected: s.id === ctx.songId }));
  const handOptions = [
    { value: 'right', label: 'Right-handed', selected: !ctx.leftHanded },
    { value: 'left', label: 'Left-handed', selected: ctx.leftHanded },
  ];
  const settingsOf = (tempo: number, metronome: boolean) => ({
    tempoOptions: [0.5, 0.75, 1].map((f) => ({ value: String(f), label: `${Math.round(f * 100)} %${f === 1 ? ' (as written)' : ''}`, selected: Math.abs(tempo - f) < 1e-9 })),
    referenceVolume: String(Math.round(ctx.levels.reference * 100)),
    clickVolume: String(Math.round(ctx.levels.click * 100)),
    metronome,
    handOptions,
    capoOptions: capoOptions(ctx.capo),
  });
  const none: PlayControls = { play: false, playLabel: 'Play song', feedback: false, feedbackLabel: 'Play song with feedback', begin: false, cancel: false, pause: false, resume: false, restart: false, stop: false };
  if (state === null) {
    const empty: TimelineInput = { position: 0, tempoFactor: 1, beats: [], prompts: [], currentId: null, nextId: null, atPlayhead: false, description: 'Timeline: no song.' };
    return {
      available: false, modes: playModes('along'), title: '', songOptions, arrangementOptions: [], arrangementText: ctx.songs.length === 0 ? 'Add a song in the Library to play it.' : 'Choose a song to play.', phase: 'none', phaseText: '', playing: false,
      currentText: '', positionText: '', nextText: '', liveText: '', alertText: '', beat: { text: '', dots: [] }, progress: { value: 0, text: '' }, timeline: timelineView(empty, ctx.width),
      guitar: guitarView(ctx.map, ctx.artworkUrl, null, null, ctx.width, hand), controls: none, input: ctx.input, settings: settingsOf(1, true), timing: ctx.timing,
      review: { visible: false, sentences: [], capture: [] }, announcement: '', errorText: ctx.errorText,
    };
  }
  const running = state.phase === 'count-in' || state.phase === 'playing';
  const busy = BUSY.includes(ctx.input.state);
  const idle = state.phase === 'ready' || state.phase === 'finished';
  const phaseText =
    state.phase === 'ready' ? 'Press Play song: after a count-in, each note arrives at “Now” as it sounds.'
    : state.phase === 'count-in' ? `Get ready… ${Math.ceil(state.secondsToStart ?? 0)}`
    : state.phase === 'playing' ? (state.assessing ? 'Playing — with feedback' : 'Playing — no feedback')
    : state.phase === 'paused' ? 'Paused'
    : state.assessing ? 'Finished' : 'Finished — played without feedback';
  const current = state.phase === 'finished' ? null : state.current;
  const beat = state.phase === 'finished' ? null : state.beat;
  const sentences = state.phase !== 'finished' ? [] : !state.assessing ? ['Played without feedback: nothing was listened to, so there is no score.'] : (state.feedback?.sentences ?? []);
  return {
    available: true,
    modes: playModes('along'),
    title: state.title,
    songOptions,
    arrangementOptions: [{ value: state.arrangement.id, label: state.arrangement.label, selected: true }],
    arrangementText: state.arrangement.text,
    phase: state.phase,
    phaseText,
    playing: running,
    currentText: current === null ? '' : `${state.phase === 'ready' ? 'First' : state.atPlayhead ? 'Now' : 'Next'}: ${noteName(current.key)}`,
    positionText: shapeText(shapeOf(current)),
    nextText: state.next === null || current === null ? '' : `Then: ${noteName(state.next.key)}`,
    liveText: running && state.assessing ? state.liveText : '',
    alertText: running && state.assessing ? ctx.alertText : '',
    beat: {
      text: beat === null ? '' : `${beat.bar === 0 ? 'Pickup' : `Bar ${beat.bar}`} · beat ${beat.beat} of ${beat.of}`,
      dots: beat === null ? [] : Array.from({ length: beat.of }, (_, i) => ({ on: i + 1 === beat.beat, key: `beat-dot-${i + 1}` })),
    },
    progress: { value: Math.round(Math.min(1, Math.max(0, state.position / state.duration)) * 1000), text: `${clockText(Math.min(state.duration, Math.max(0, state.position)))} / ${clockText(state.duration)}` },
    timeline: timelineView(playTimelineInput(state), ctx.width),
    guitar: guitarView(ctx.map, ctx.artworkUrl, shapeOf(current), shapeOf(state.phase === 'finished' ? null : state.next), ctx.width, hand, state.arrangement.tuning),
    controls: {
      play: idle && !busy,
      playLabel: state.phase === 'finished' ? 'Play again' : 'Play song',
      feedback: idle && !busy,
      feedbackLabel: state.phase === 'finished' ? 'Play again with feedback' : 'Play song with feedback',
      begin: idle && ctx.input.state === 'ready',
      cancel: idle && busy,
      pause: running,
      resume: state.phase === 'paused',
      restart: running || state.phase === 'paused',
      stop: running || state.phase === 'paused',
    },
    input: ctx.input,
    settings: settingsOf(state.settings.tempoFactor, state.settings.metronome),
    timing: ctx.timing,
    review: { visible: state.phase === 'finished', sentences, capture: state.phase === 'finished' && state.assessing && ctx.capture !== null ? captureText(ctx.capture.summary, ctx.capture.origin) : [] },
    announcement: state.phase === 'count-in' ? 'Count-in' : state.phase === 'playing' ? 'Playing' : state.phase === 'paused' ? 'Paused' : state.phase === 'finished' ? `Finished. ${sentences[0] ?? ''}` : '',
    errorText: ctx.errorText,
  };
}

/** A finished run in Progress: a score only for what was assessed. */
export function playAttemptText(state: PlayState): string {
  const fb = state.feedback;
  if (!state.assessing || fb === null) return 'Played along (Play) without feedback — no score';
  if (fb.pitch.assessed === 0) return 'Played (Play): could not be assessed — the microphone was not delivering sound';
  const results: readonly NoteResult[] = state.results;
  return `Played (Play): ${fb.pitch.right} of ${fb.pitch.assessed}${fb.pitch.unassessed > 0 ? ' assessed' : ''} right${fb.timing.judged > 0 ? `, ${fb.timing.onTime} on time` : ''} — ${results.length} of ${state.arrangement.targets.length} notes reached`;
}
