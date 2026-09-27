/**
 * The browser demo's entry (index.html): the application composed with the demo input and mounted on the official Vue runtime.
 *
 *   DemoInput (a recording or a simulation, per instrument) → TuningSession → toView → the .obix UI
 *
 * Press Start once: the input plays, and every pitch updates the UI by itself. Nothing here needs Obicall, a DLL or a microphone.
 */
import type { Scheduler } from '../domain/ports.ts';
import { DEFAULT_POLICY } from '../domain/tuning.ts';
import { CATALOG } from '../instruments/catalog.ts';
import { TuningSession } from '../app/session.ts';
import { DemoInput } from './demo-input.ts';
import { mountAnyTune } from './mount.ts';

/** Real time: the browser's clock and timers. */
const clock: Scheduler = {
  now: () => performance.now(),
  setTimeout(run, delayMs) {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  },
};

const instrumentId = 'guitar-standard';
const input = new DemoInput(clock, instrumentId);
const session = new TuningSession({ fusion: input, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId });
// the demo's input follows the instrument chosen: it takes effect at the next start
session.subscribe((state) => input.select(state.instrumentId));

const host = document.getElementById('app');
if (host === null) throw new Error('index.html has no #app');
mountAnyTune(host, { session, catalog: CATALOG, clock, input: () => input.source });
