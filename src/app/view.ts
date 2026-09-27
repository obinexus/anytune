/**
 * The view of the application state: everything the UI shows, already in words and numbers. Formatting belongs here — not in the tuning domain (which knows
 * pitch, not text) and not in the components (which only place and bind what they are given, so that they lower to the OBIX DOP IR, which has no calls).
 */
import { findTuning } from '../domain/tuning.ts';
import type { InputSource, InputSourceKind } from '../domain/ports.ts';
import type { InstrumentTuning, TuningStatus } from '../domain/tuning.ts';
import type { AnyTuneState, AppError, SessionState } from './session.ts';

export type ViewStatus = TuningStatus | 'no-signal';

export interface InputOption {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface InstrumentOption {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
}

export interface TunerView {
  readonly session: SessionState;
  readonly sessionText: string;
  readonly listening: boolean;
  readonly instrumentId: string;
  readonly instrumentName: string;
  readonly instruments: readonly InstrumentOption[];
  readonly hasReading: boolean;
  readonly note: string;
  readonly octaveText: string;
  readonly targetText: string;
  readonly frequencyText: string;
  readonly centsText: string;
  readonly status: ViewStatus;
  readonly statusText: string;
  readonly stable: boolean;
  /** where the needle stands on a scale of 0…100: 50 is in tune, 0 and 100 are 50 cents flat and sharp (or more) */
  readonly needlePercent: number;
  readonly confidencePercent: number;
  readonly confidenceText: string;
  readonly inputText: string;
  /** what is supplying the measurements — simulated, recorded or a microphone — in words */
  readonly inputSourceText: string;
  /** the input chosen, and what can be chosen */
  readonly inputId: string;
  readonly inputOptions: readonly InputOption[];
  readonly hasError: boolean;
  readonly errorText: string;
  readonly summaryText: string;
  /** what the live region says — the announcement policy's words (announcer.ts), not the visual refresh */
  readonly announcement: string;
}

const STATUS_TEXT: Readonly<Record<ViewStatus, string>> = { flat: 'Flat', 'in-tune': 'In tune', sharp: 'Sharp', uncertain: 'Signal uncertain', 'no-signal': 'No signal' };
const SESSION_TEXT: Readonly<Record<SessionState, string>> = { idle: 'Not listening', starting: 'Starting…', listening: 'Listening', error: 'Not listening' };
const INPUT_TEXT: Readonly<Record<AnyTuneState['input']['state'], string>> = {
  idle: 'Input off',
  starting: 'Input starting',
  listening: 'Input connected',
  degraded: 'Input partly connected',
  ended: 'Recording ended',
  stopped: 'Input off',
  'permission-denied': 'Microphone permission denied',
  'no-device': 'No microphone',
  disconnected: 'Input disconnected',
  'insecure-context': 'Microphone needs a secure page',
  unsupported: 'Microphone not supported',
  'microphone-unavailable': 'Microphone unavailable',
  'audio-failed': 'Audio could not start',
  unavailable: 'No pitch source',
};

const SOURCE_KIND: Readonly<Record<InputSourceKind, string>> = { simulated: 'Simulated', recorded: 'Recorded', microphone: 'Microphone' };

export function inputSourceText(source: InputSource | null): string {
  return source === null ? 'Input: none' : `Input: ${SOURCE_KIND[source.kind]} — ${source.name}`;
}

export function errorText(error: AppError | null): string {
  if (error === null) return '';
  switch (error.kind) {
    case 'permission-denied':
      return 'Microphone permission was denied. Allow the microphone to tune.';
    case 'no-device':
      return 'No microphone was found. Connect one to tune.';
    case 'disconnected':
      return 'The input was disconnected. Start again to tune.';
    case 'insecure-context':
      return 'The microphone works only on a secure page: https, or localhost. Open AnyTune over https to tune with it.';
    case 'unsupported':
      return 'This browser cannot give AnyTune the microphone. Use a current Edge, Chrome, Firefox or Safari — or the demo input.';
    case 'microphone-unavailable':
      return 'The microphone could not be opened — another application may be using it. Close it, then start again.';
    case 'audio-failed':
      return 'The browser could not start its audio processing. Start again, or reload the page.';
    case 'unavailable':
      return 'No pitch source is available.';
    case 'unsupported-input':
      return `This input is not available: ${error.detail ?? ''}.`;
    case 'unsupported-instrument':
      return `This instrument is not supported: ${error.detail ?? ''}.`;
    case 'invalid-tuning':
      return `This tuning is not valid: ${error.detail ?? ''}.`;
  }
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

export function centsText(cents: number): string {
  const size = Math.abs(cents);
  if (size < 0.05) return '0.0 cents';
  return `${size.toFixed(1)} cents ${cents < 0 ? 'flat' : 'sharp'}`;
}

export function toView(state: AnyTuneState, catalog: readonly InstrumentTuning[], announcement = '', source: InputSource | null = null): TunerView {
  const instrumentName = findTuning(catalog, state.instrumentId)?.name ?? state.instrumentId;
  const reading = state.reading;
  const status: ViewStatus = reading?.status ?? 'no-signal';
  const confidencePercent = Math.round(state.input.confidence * 100);
  return {
    session: state.session,
    sessionText: SESSION_TEXT[state.session],
    listening: state.session === 'listening',
    instrumentId: state.instrumentId,
    instrumentName,
    instruments: catalog.map((t) => ({ id: t.id, name: t.name, selected: t.id === state.instrumentId })),
    hasReading: reading !== null,
    note: reading?.note ?? '–',
    octaveText: reading === null ? '' : String(reading.octave),
    targetText: reading?.targetLabel ?? '',
    frequencyText: reading === null ? '— Hz' : `${reading.detectedFrequencyHz.toFixed(1)} Hz`,
    centsText: reading === null ? '' : centsText(reading.cents),
    status,
    statusText: STATUS_TEXT[status],
    stable: state.stable,
    needlePercent: reading === null ? 50 : round1(50 + Math.max(-50, Math.min(50, reading.cents))),
    confidencePercent,
    confidenceText: `${confidencePercent}% confidence`,
    inputText: INPUT_TEXT[state.input.state],
    inputSourceText: inputSourceText(source),
    inputId: state.inputId,
    inputOptions: state.inputs.map((i) => ({ id: i.id, label: i.label, selected: i.id === state.inputId })),
    hasError: state.error !== null,
    errorText: errorText(state.error),
    summaryText: reading === null ? instrumentName : `${instrumentName} · ${reading.targetLabel}`,
    announcement,
  };
}
