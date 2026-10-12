/**
 * The input of the browser demo: a PitchFusionPort that, at each start, plays the input made for the instrument chosen — and says which, so that the UI never
 * lets a simulation pass for a real instrument being heard.
 *
 *   Standard Guitar   a RECORDING: the directive's acceptance sequence, 108, 109, 110, 110 Hz (the committed fixture guitar-a2-acceptance.json, as data)
 *   Chromatic         a RECORDING: A4 at 440 Hz, four readings — the generic pitch model, with no string to capture it
 *   any other         a SIMULATION: the instrument's first string heard 30 cents flat, 18 cents sharp, then in tune, twice
 *
 * Every recording here is of the SIMULATED origin — made by AnyTune, not recorded from an instrument. The demo needs no native library and no microphone. A
 * microphone is a later PitchProvider (docs/ARCHITECTURE.md, "The next adapter: MicrophonePitchProvider"); it replaces this input, and nothing else changes.
 */
import type { FusionEvent, FusionState, InputSource, PitchFusionPort, Scheduler } from '../domain/ports.ts';
import { findTuning } from '../domain/tuning.ts';
import { CATALOG } from '../instruments/catalog.ts';
import type { PitchRecording } from '../audio/recording.ts';
import { RecordedPitchFusion, SimulatedPitchFusion } from '../fusion/pitch-fusion.ts';

const observation = (timestampMs: number, frequencyHz: number) => ({ kind: 'observation', timestampMs, sourceId: 'simulated-microphone', frequencyHz, varianceHz2: 0.04, confidence: 0.95 }) as const;

export const DEMO_RECORDINGS: Readonly<Record<'guitar-standard' | 'chromatic', PitchRecording>> = Object.freeze({
  'guitar-standard': {
    format: 'anytune-pitch-recording/1',
    origin: 'simulated',
    description: 'The acceptance sequence of the AnyTune directive: the A string rising to pitch, 108, 109, 110, 110 Hz, a reading every 250 ms. Simulated, not recorded from an instrument.',
    instrument: 'guitar-standard',
    entries: [observation(0, 108), observation(250, 109), observation(500, 110), observation(750, 110)],
  },
  chromatic: {
    format: 'anytune-pitch-recording/1',
    origin: 'simulated',
    description: 'A4 at 440 Hz, four readings 250 ms apart, for the chromatic tuning. Simulated, not recorded from an instrument.',
    instrument: 'chromatic',
    entries: [observation(0, 440), observation(250, 440), observation(500, 440), observation(750, 440)],
  },
});

const RECORDING_NAMES: Readonly<Record<keyof typeof DEMO_RECORDINGS, string>> = {
  'guitar-standard': 'Standard Guitar, the A string rising to pitch: 108, 109, 110, 110 Hz (simulated data)',
  chromatic: 'A4, 440 Hz (simulated data)',
};

/** The simulation: cents off the first string, 250 ms apart. */
const SIMULATED_CENTS: readonly number[] = [-30, 18, 0, 0];
const STEP_MS = 250;

const hasRecording = (id: string): id is keyof typeof DEMO_RECORDINGS => Object.hasOwn(DEMO_RECORDINGS, id);

/** The states after which an input plays no more: a recording that ended, an input stopped or failed. */
const FINAL: readonly FusionState[] = ['ended', 'stopped', 'permission-denied', 'no-device', 'disconnected', 'unavailable'];

export class DemoInput implements PitchFusionPort {
  readonly #clock: Scheduler;
  readonly #listeners = new Set<(event: FusionEvent) => void>();
  #instrumentId: string;
  #running: { readonly port: PitchFusionPort; readonly source: InputSource; readonly off: () => void; readonly cancel: readonly (() => void)[] } | null = null;
  /** whether what runs still plays — false once its state is final */
  #playing = false;

  constructor(clock: Scheduler, instrumentId: string) {
    this.#clock = clock;
    this.#instrumentId = instrumentId;
  }

  /** The instrument the next start plays for. What is playing plays on. */
  select(instrumentId: string): void {
    this.#instrumentId = instrumentId;
  }

  /** What is supplying the measurements: what is playing, or — when nothing is — what the next start will play. */
  get source(): InputSource {
    return this.#running !== null && this.#playing ? this.#running.source : this.#sourceFor(this.#instrumentId);
  }

  subscribe(listener: (event: FusionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    await this.stop();
    const id = this.#instrumentId;
    const source = this.#sourceFor(id);
    this.#playing = true;
    const forward = (event: FusionEvent): void => {
      if (event.kind === 'state' && FINAL.includes(event.state)) this.#playing = false;
      for (const listener of [...this.#listeners]) listener(event);
    };
    if (hasRecording(id)) {
      const port = RecordedPitchFusion(DEMO_RECORDINGS[id], this.#clock);
      this.#running = { port, source, off: port.subscribe(forward), cancel: [] };
      await port.start();
      return;
    }
    const simulated = SimulatedPitchFusion(this.#clock);
    const off = simulated.port.subscribe(forward);
    const string = findTuning(CATALOG, id)?.strings?.[0];
    const provider = simulated.providers[0];
    const cancel = string === undefined || provider === undefined ? [] : SIMULATED_CENTS.map((cents, i) => this.#clock.setTimeout(() => provider.hear(string.frequencyHz * 2 ** (cents / 1200)), i * STEP_MS));
    this.#running = { port: simulated.port, source, off, cancel };
    await simulated.port.start();
  }

  async stop(): Promise<void> {
    const running = this.#running;
    if (running === null) return;
    for (const cancel of running.cancel) cancel();
    await running.port.stop();
    running.off();
    this.#running = null;
  }

  #sourceFor(id: string): InputSource {
    if (hasRecording(id)) return { kind: 'recorded', name: RECORDING_NAMES[id] };
    const tuning = findTuning(CATALOG, id);
    const string = tuning?.strings?.[0];
    return { kind: 'simulated', name: string === undefined ? `${tuning?.name ?? id}, simulated` : `${tuning?.name ?? id}, the ${string.label} string rising to pitch` };
  }
}
