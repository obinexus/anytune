/**
 * The microphone as the learner sees it before and during an assessed attempt: the input states, the meter, and the timing details — in words, each state
 * said apart, so that a refusal, a missing device, a muted input and a faint one are never confused.
 *
 *   idle → requesting (the browser asks) → checking (the meter; "pluck a string") → ready (a note was heard) → listening (count-in, playing) → idle (review)
 *
 * and, instead of ready: denied · no-device · unreadable · unsupported · muted (digital silence, raw and processed) · disconnected · failed.
 */
import type { InputHint } from './input-check.ts';

export type InputState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'requesting' }
  | { readonly kind: 'checking'; readonly hint: InputHint; readonly processing: boolean }
  | { readonly kind: 'ready'; readonly heard: string; readonly processing: boolean }
  | { readonly kind: 'listening'; readonly processing: boolean }
  | { readonly kind: 'denied' | 'no-device' | 'unreadable' | 'unsupported' | 'muted' | 'disconnected' | 'failed' };

/** The browser's reported latencies, seconds — each null when the browser does not report it. */
export interface ReportedLatency {
  readonly baseSeconds: number | null;
  readonly outputSeconds: number | null;
  /** the microphone track's `latency` setting: null until a microphone is open, or when not reported */
  readonly inputSeconds: number | null;
}

export interface CaptureInfo {
  readonly device: string;
  readonly sampleRate: number;
  readonly processing: boolean;
}

/** The sum of what the browser reports: the correction applied to timing judgements. */
export const reportedTotal = (l: ReportedLatency): number => (l.baseSeconds ?? 0) + (l.outputSeconds ?? 0) + (l.inputSeconds ?? 0);

export interface InputView {
  readonly state: string;
  readonly text: string;
  /** the meter: shown while the microphone is open */
  readonly meter: { readonly visible: boolean; readonly value: number; readonly text: string };
  /** the state is a problem the learner can try again from */
  readonly problem: boolean;
}

const ms = (s: number): string => `${Math.round(s * 1000)} ms`;

export function inputView(state: InputState, levelDb: number, loudestDb: number): InputView {
  const db = Number.isFinite(levelDb) ? Math.max(-90, Math.round(levelDb)) : -90;
  const meter = { visible: state.kind === 'checking' || state.kind === 'ready' || state.kind === 'listening', value: Math.max(-60, Math.min(0, db)), text: db <= -90 ? 'no sound' : `${db} dBFS` };
  const processingNote = 'processing' in state && state.processing ? ' (The browser’s audio processing is on: the raw microphone sent only silence.)' : '';
  const text = ((): string => {
    switch (state.kind) {
      case 'idle':
        return '';
      case 'requesting':
        return 'Asking for the microphone…';
      case 'checking':
        return (
          (state.hint === 'quiet'
            ? `I can hear the microphone, but only faintly (loudest ${Number.isFinite(loudestDb) ? Math.round(loudestDb) : -90} dBFS). Move it closer to the guitar, or raise its input level, then pluck a string.`
            : state.hint === 'unclear'
              ? 'I hear sound, but not a clear note yet. Pluck one string and let it ring.'
              : 'Checking the microphone: pluck any string and let it ring.') + processingNote
        );
      case 'ready':
        return `Heard ${state.heard}: the microphone hears your guitar. Press Begin when you are ready.${processingNote}`;
      case 'listening':
        return 'Listening. What the microphone hears is analysed on this device and never uploaded.';
      case 'denied':
        return 'The microphone was not allowed. Allow it for this page (in the browser’s address bar, or the app’s settings), then press Try again — or play along without assessment.';
      case 'no-device':
        return 'No microphone was found. Connect one and press Try again — or play along without assessment.';
      case 'unreadable':
        return 'The microphone could not be opened: another app may be using it. Close that app and press Try again.';
      case 'unsupported':
        return 'This browser cannot give AnyTune the microphone. You can still play along without assessment.';
      case 'muted':
        return 'The microphone is sending only silence, raw and with the browser’s processing: it may be muted. Check a microphone mute key and the system’s microphone privacy settings, then press Try again.';
      case 'disconnected':
        return 'The microphone was disconnected, or its permission withdrawn. Reconnect it and press Try again.';
      case 'failed':
        return 'The microphone could not be started. Press Try again — or play along without assessment.';
    }
  })();
  const problem = ['denied', 'no-device', 'unreadable', 'unsupported', 'muted', 'disconnected', 'failed'].includes(state.kind);
  return { state: state.kind, text, meter, problem };
}

/** The timing details, quantity by quantity, named as the browser names them — estimates, never a measurement. */
export function timingLines(latency: ReportedLatency | null, info: CaptureInfo | null): string[] {
  const lines: string[] = [];
  if (latency === null) lines.push('Audio is not running yet: the browser reports its latencies once it is.');
  else {
    const parts = [
      latency.baseSeconds === null ? null : `AudioContext.baseLatency ${ms(latency.baseSeconds)}`,
      latency.outputSeconds === null ? null : `AudioContext.outputLatency ${ms(latency.outputSeconds)}`,
      latency.inputSeconds === null ? null : `the microphone track’s latency setting ${ms(latency.inputSeconds)}`,
    ].filter((p): p is string => p !== null);
    const total = reportedTotal(latency);
    lines.push(parts.length === 0 ? 'The browser reports no latency: timing is judged without a correction.' : `Timing is judged after subtracting ${ms(total)}: the sum of what the browser reports — ${parts.join(', ')}.`);
    if (latency.inputSeconds === null) lines.push(info === null ? 'The microphone’s own latency is read when it is opened.' : 'The microphone track reports no latency.');
    lines.push('These are the browser’s estimates of parts of the path, not a measurement: AnyTune has not measured the delay from the speaker to the microphone on this device. Headphones avoid the microphone hearing the speaker.');
  }
  if (info !== null) lines.push(`Microphone: ${info.device}, ${info.sampleRate / 1000} kHz, ${info.processing ? 'with the browser’s processing on' : 'raw (no echo cancellation, noise suppression or gain control)'}.`);
  return lines;
}
