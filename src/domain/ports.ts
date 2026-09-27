/**
 * The ports of the domain: what AnyTune needs from the world, as interfaces it owns. A pitch provider says what pitch it hears; a PitchFusionPort combines the
 * providers into one fused pitch; a scheduler is time. Implementations live outside the domain (audio/, fusion/, the harness) and are injected. Failures are
 * events carrying a state — never exceptions thrown at the UI.
 */

/** Time, and deferred work — virtual in the tests, real timers in the demo. */
export interface Scheduler {
  now(): number;
  /** Run `run` after `delayMs`; the function returned cancels it. */
  setTimeout(run: () => void, delayMs: number): () => void;
}

/** One pitch, as a source estimated it. */
export interface PitchObservation {
  readonly sourceId: string;
  readonly frequencyHz: number;
  /** the variance of the estimate, in Hz² — what inverse-variance fusion weighs by */
  readonly varianceHz2: number;
  /** how sure the source is that there is a pitch at all, 0…1 */
  readonly confidence: number;
  readonly timestampMs: number;
}

/** What a source of pitch can be: the failures an input really has — permission denied, no device, disconnected — are states. */
export type SourceState = 'starting' | 'listening' | 'ended' | 'stopped' | 'permission-denied' | 'no-device' | 'disconnected';

export type ProviderEvent =
  | { readonly kind: 'observation'; readonly observation: PitchObservation }
  | { readonly kind: 'silence'; readonly sourceId: string; readonly timestampMs: number }
  | { readonly kind: 'state'; readonly sourceId: string; readonly state: SourceState; readonly timestampMs: number };

export interface PitchProvider {
  readonly id: string;
  /** Start listening. Resolves whatever happens: a failure to start is a state event. */
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(observer: (event: ProviderEvent) => void): () => void;
}

/** One pitch for the domain: the fusion of the latest observations of the sources that were heard together. */
export interface FusedPitchObservation {
  readonly frequencyHz: number;
  readonly varianceHz2: number;
  readonly confidence: number;
  readonly timestampMs: number;
  /** the sources fused, in sorted order */
  readonly sourceIds: readonly string[];
}

/** What the fusion can be: as its sources, plus `degraded` (some sources failed, some are still heard) and `unavailable` (nothing to fuse). */
export type FusionState = SourceState | 'degraded' | 'unavailable';

export type FusionEvent =
  | { readonly kind: 'fused'; readonly pitch: FusedPitchObservation }
  | { readonly kind: 'silence'; readonly timestampMs: number }
  | { readonly kind: 'rejected'; readonly sourceId: string; readonly timestampMs: number; readonly reason: string }
  | { readonly kind: 'state'; readonly state: FusionState; readonly timestampMs: number };

export interface PitchFusionPort {
  /** Start the sources. Resolves whatever happens: a failure is a state event. */
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (event: FusionEvent) => void): () => void;
}
