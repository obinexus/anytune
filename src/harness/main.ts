/**
 * The browser demo's entry (index.html): the application composed (compose.ts) with the browser's clock and microphone, and mounted on the official Vue
 * runtime.
 *
 *   Input: Demo (the default)   a recording or a simulation, per instrument — nothing needs a microphone or Obicall
 *   Input: Microphone           the browser's microphone → the pitch detector → the same session and UI; asked for only when Start is pressed
 *
 * Press Start once: every pitch updates the UI by itself.
 */
import type { Scheduler } from '../domain/ports.ts';
import { browserMicrophoneEnvironment } from './browser-audio.ts';
import { composeAnyTune } from './compose.ts';
import { mountAnyTune } from './mount.ts';

/** Real time: the browser's clock and timers. */
const clock: Scheduler = {
  now: () => performance.now(),
  setTimeout(run, delayMs) {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  },
};

const { session, catalog, input } = composeAnyTune({ clock, microphone: browserMicrophoneEnvironment() });
const host = document.getElementById('app');
if (host === null) throw new Error('index.html has no #app');
mountAnyTune(host, { session, catalog, clock, input });
