/**
 * AnyTune pitch recordings — an AnyTune-owned format (`anytune-pitch-recording/1`, JSON): a timed list of pitch observations, silences and input states. It is
 * NOT Obicall's `.obr` journal and is never produced by Obicall: pitch is not an Obicall observation type (docs/OBICALL.md). The committed fixtures are
 * simulated (`origin: "simulated"`); `recorded` is for recordings made from a real input, when AnyTune has one.
 */

export const RECORDING_FORMAT = 'anytune-pitch-recording/1';

export type RecordingEntry =
  | { readonly kind: 'observation'; readonly timestampMs: number; readonly sourceId: string; readonly frequencyHz: number; readonly varianceHz2: number; readonly confidence: number }
  | { readonly kind: 'silence'; readonly timestampMs: number; readonly sourceId: string }
  | { readonly kind: 'state'; readonly timestampMs: number; readonly sourceId: string; readonly state: 'disconnected' | 'permission-denied' | 'no-device' };

export interface PitchRecording {
  readonly format: typeof RECORDING_FORMAT;
  readonly origin: 'simulated' | 'recorded';
  readonly description: string;
  /** the instrument the recording is of, by catalog id */
  readonly instrument: string;
  readonly entries: readonly RecordingEntry[];
}

export type ParsedRecording = { readonly ok: true; readonly recording: PitchRecording } | { readonly ok: false; readonly issues: readonly string[] };

const RECORDED_STATES = ['disconnected', 'permission-denied', 'no-device'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Read a recording from parsed JSON, checking everything; the problems come back as data. */
export function parseRecording(input: unknown): ParsedRecording {
  if (!isRecord(input)) return { ok: false, issues: ['a recording is an object'] };
  const issues: string[] = [];
  if (input['format'] !== RECORDING_FORMAT) issues.push(`format: expected "${RECORDING_FORMAT}"`);
  if (input['origin'] !== 'simulated' && input['origin'] !== 'recorded') issues.push('origin: "simulated" or "recorded" — an AnyTune pitch recording is not an Obicall recording');
  if (!nonEmpty(input['description'])) issues.push('description: a non-empty string');
  if (!nonEmpty(input['instrument'])) issues.push('instrument: a non-empty string');
  const raw = input['entries'];
  const entries: RecordingEntry[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push('entries: at least one entry');
  } else {
    let last = 0;
    raw.forEach((entry: unknown, i: number) => {
      const at = `entries[${i}]`;
      if (!isRecord(entry)) return void issues.push(`${at}: an object`);
      const before = issues.length;
      const t = entry['timestampMs'];
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) issues.push(`${at}.timestampMs: a non-negative finite number`);
      else if (t < last) issues.push(`${at}.timestampMs: entries are in the order of time`);
      else last = t;
      const kind = entry['kind'];
      if (kind !== 'observation' && kind !== 'silence' && kind !== 'state') return void issues.push(`${at}.kind: observation, silence or state`);
      if (!nonEmpty(entry['sourceId'])) issues.push(`${at}.sourceId: a non-empty string`);
      if (kind === 'observation') {
        const f = entry['frequencyHz'];
        const v = entry['varianceHz2'];
        const c = entry['confidence'];
        if (typeof f !== 'number' || !Number.isFinite(f)) issues.push(`${at}.frequencyHz: a finite number`);
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) issues.push(`${at}.varianceHz2: a positive finite number`);
        if (typeof c !== 'number' || !(c >= 0 && c <= 1)) issues.push(`${at}.confidence: a number from 0 to 1`);
      }
      if (kind === 'state' && !RECORDED_STATES.includes(entry['state'] as (typeof RECORDED_STATES)[number])) issues.push(`${at}.state: one of ${RECORDED_STATES.join(', ')}`);
      if (issues.length === before) entries.push(entry as unknown as RecordingEntry);
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, recording: { ...(input as unknown as PitchRecording), entries } };
}
