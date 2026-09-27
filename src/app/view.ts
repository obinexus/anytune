/**
 * The view of the application state: everything the UI shows, already in words and numbers. Formatting belongs here — not in the tuning domain (which knows
 * pitch, not text) and not in the components (which only place and bind what they are given, so that they lower to the OBIX DOP IR, which has no calls).
 */
import { findTuning } from '../domain/tuning.ts';
import type { InstrumentTuning, TuningStatus } from '../domain/tuning.ts';
import type { AnyTuneState, AppError, SessionState } from './session.ts';

export type ViewStatus = TuningStatus | 'no-signal';

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
  unavailable: 'No pitch source',
};

export function errorText(error: AppError | null): string {
  if (error === null) return '';
  switch (error.kind) {
    case 'permission-denied':
      return 'Microphone permission was denied. Allow the microphone to tune.';
    case 'no-device':
      return 'No microphone was found. Connect one to tune.';
    case 'disconnected':
      return 'The input was disconnected. Start again to tune.';
    case 'unavailable':
      return 'No pitch source is available.';
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

export function toView(state: AnyTuneState, catalog: readonly InstrumentTuning[], announcement = ''): TunerView {
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
    hasError: state.error !== null,
    errorText: errorText(state.error),
    summaryText: reading === null ? instrumentName : `${instrumentName} · ${reading.targetLabel}`,
    announcement,
  };
}
