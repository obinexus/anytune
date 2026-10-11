/**
 * The browser entry (index.html) — the same page in a browser and in the Android app's WebView: the tuner composed as before (compose.ts), the journey's shell
 * around it (shell-app.ts) with the practice audio and, inside the app, the recorder through its bridge; mounted — `#anytune-mount` — on the official Vue
 * runtime (mount.ts, the default: `npm run dev`) or on OBIX's native runtime (mount-native.ts: `npm run dev:native`), from the same .obix files.
 *
 *   Tune       Input: Demo (the default) or the microphone → the pitch detector → the tuner
 *   Practise   the microphone (asked for at Start) → an AudioWorklet → the live analysis → the practice session, on the AudioContext's clock
 *
 * When the page is hidden (another tab, the app sent to the background), nothing keeps listening.
 */
import type { Scheduler } from '../domain/ports.ts';
import { androidRecorder, BROWSER_RECORDER_NOTE } from './android-recorder.ts';
import { browserMicrophoneEnvironment } from './browser-audio.ts';
import { composeAnyTune } from './compose.ts';
import { browserPracticeAudio } from './practice-audio.ts';
import { ShellApp } from './shell-app.ts';
import { mountShell } from '#anytune-mount';

/** Real time: the browser's clock and timers. */
const clock: Scheduler = {
  now: () => performance.now(),
  setTimeout(run, delayMs) {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  },
};

const tuning = composeAnyTune({ clock, microphone: browserMicrophoneEnvironment() });
const store = androidRecorder();
const app = new ShellApp({
  tuning,
  clock,
  audio: browserPracticeAudio(),
  recorder: store === null ? { store: null, why: BROWSER_RECORDER_NOTE } : { store },
  async readFile(inputId) {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (input === null || file === undefined) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    input.value = ''; // the same file can be chosen again
    return { name: file.name, bytes };
  },
  sha256: async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join(''),
  frame(run) {
    const handle = requestAnimationFrame(run);
    return () => cancelAnimationFrame(handle);
  },
  when: (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') app.pause();
});
const host = document.getElementById('app');
if (host === null) throw new Error('index.html has no #app');
mountShell(host, { app });
