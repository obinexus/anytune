/**
 * What a demo harness takes and gives, whichever runtime it mounts the UI on — the official Vue runtime (mount.ts) or OBIX's native runtime (mount-native.ts): the same
 * application in, the same handle out, so the page is driven, and tested, the same way on both.
 */
import type { TuningSession } from '../app/session.ts';
import type { InstrumentTuning } from '../domain/tuning.ts';
import type { InputSource, Scheduler } from '../domain/ports.ts';

export interface MountDeps {
  readonly session: TuningSession;
  readonly catalog: readonly InstrumentTuning[];
  /** the time of the announcement policy: real timers in the browser, virtual time in the tests */
  readonly clock: Scheduler;
  /** what is supplying the measurements, said on the page — read at every change of the state, since the demo's input follows the instrument */
  readonly input?: () => InputSource | null;
}

export interface MountedAnyTune {
  /** how many times the UI rendered — the visual refresh, which the tests hold apart from the rate of the pitches */
  renders(): number;
  /** resolves once the page shows every pending update */
  settled(): Promise<void>;
  unmount(): void;
}
