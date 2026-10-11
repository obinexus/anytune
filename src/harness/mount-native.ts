/**
 * The demo execution harness on OBIX's NATIVE runtime (Phase 6, N11): the same .obix UI — AnyTuneApp and everything it invokes, lowered to canonical DOP IR from the
 * same files (`?ir`, tools/obix/ir-module.ts) — run by obix-runtime-browser, with no Vue anywhere; and the same bridge as the Vue harness (mount.ts):
 *
 *   session.subscribe(state) → view = toView(state) → the root's inputs → the native runtime updates the DOM in place, once per task
 *
 * The UI's intents come back as the root's outputs — the page's interactions, by channel — and go to the session, and the announcement policy (announcer.ts) decides
 * what the live region says. Nothing here writes markup or attaches listeners by hand; the session knows nothing of any runtime.
 */
import { createObixApp } from 'obix-runtime-browser';
import AnyTuneApp, { registry } from '../components/AnyTuneApp.obix?ir';
import { toView } from '../app/view.ts';
import type { TunerView } from '../app/view.ts';
import { Announcer } from '../app/announcer.ts';
import type { MountDeps, MountedAnyTune } from './mount-types.ts';

export function mountAnyTune(host: Element, { session, catalog, clock, input = () => null }: MountDeps): MountedAnyTune {
  const announcer = new Announcer(clock);
  let state = session.getState();
  let announcement = '';
  const view = (): TunerView => toView(state, catalog, announcement, input());
  const app = createObixApp(AnyTuneApp, {
    registry,
    props: { ...view() },
    interactions: {
      selectInstrument: (id: unknown) => session.selectInstrument(String(id)),
      selectInput: (id: unknown) => void session.selectInput(String(id)),
      start: () => void session.start(),
      stop: () => void session.stop(),
    },
  });
  // how many times the UI rendered: the first render, and then once for each task whose changes of the state it showed — however many changes came in that task
  let renders = 1;
  let pending = false;
  const refresh = (): void => {
    app.setProps({ ...view() });
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      renders++;
    });
  };
  // the live region changes only when the announcement policy says so; the rest of the view at every state
  const offAnnouncer = announcer.subscribe((text) => {
    announcement = text;
    refresh();
  });
  const offSession = session.subscribe((next) => {
    state = next;
    announcer.observe(next);
    refresh();
  });
  app.mount(host);
  return {
    renders: () => renders,
    settled: () => app.settled(),
    unmount(): void {
      offSession();
      offAnnouncer();
      announcer.dispose();
      app.unmount();
    },
  };
}

import AnyTuneShell, { registry as shellRegistry } from '../components/AnyTuneShell.obix?ir';
import type { ShellMountDeps } from './mount-types.ts';

/** The whole app on OBIX's native runtime: the same shell, lowered to DOP IR, its events (outputs, by channel) handed to the app's handlers. */
export function mountShell(host: Element, { app }: ShellMountDeps): MountedAnyTune {
  const on = app.handlers;
  const obix = createObixApp(AnyTuneShell, {
    registry: shellRegistry,
    props: { ...app.view() },
    interactions: {
      navigate: (screen: unknown) => on.navigate(String(screen)),
      begin: () => on.begin(),
      choose: (id: unknown) => on.choose(String(id)),
      importRecording: () => on.importRecording(),
      openMidi: () => void on.openMidi(),
      openObr: () => void on.openObr(),
      tuneInstrument: (id: unknown) => on.tuneInstrument(String(id)),
      tuneInput: (id: unknown) => on.tuneInput(String(id)),
      tuneStart: () => on.tuneStart(),
      tuneStop: () => on.tuneStop(),
      practiceStart: () => void on.practiceStart(),
      practiceBegin: () => void on.practiceBegin(),
      practiceCancel: () => on.practiceCancel(),
      practiceFree: () => void on.practiceFree(),
      practiceStop: () => void on.practiceStop(),
      practiceListen: () => on.practiceListen(),
      practiceRepeat: (bar: unknown) => on.practiceRepeat(String(bar)),
      practiceTempo: (value: unknown) => on.practiceTempo(String(value)),
      practiceFrom: (value: unknown) => on.practiceFrom(String(value)),
      practiceTo: (value: unknown) => on.practiceTo(String(value)),
      practiceMode: (value: unknown) => on.practiceMode(String(value)),
      practiceHand: (value: unknown) => on.practiceHand(String(value)),
      practiceMetronome: (checked: unknown) => on.practiceMetronome(checked === true),
      practiceReference: (checked: unknown) => on.practiceReference(checked === true),
      playSong: (id: unknown) => on.playSong(String(id)),
      playStart: () => void on.playStart(),
      playFeedback: () => void on.playFeedback(),
      playBegin: () => void on.playBegin(),
      playCancel: () => on.playCancel(),
      playPause: () => on.playPause(),
      playResume: () => on.playResume(),
      playRestart: () => on.playRestart(),
      playStop: () => on.playStop(),
      playTempo: (value: unknown) => on.playTempo(String(value)),
      playReferenceVolume: (value: unknown) => on.playReferenceVolume(String(value)),
      playClickVolume: (value: unknown) => on.playClickVolume(String(value)),
      playMetronome: (checked: unknown) => on.playMetronome(checked === true),
    },
  });
  let renders = 1;
  let pending = false;
  const off = app.subscribe(() => {
    obix.setProps({ ...app.view() });
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      renders++;
    });
  });
  obix.mount(host);
  return {
    renders: () => renders,
    settled: () => obix.settled(),
    unmount(): void {
      off();
      obix.unmount();
    },
  };
}
