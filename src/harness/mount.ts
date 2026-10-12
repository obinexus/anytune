/**
 * The demo execution harness: mounts AnyTune's .obix UI on the official Vue runtime (the default; mount-native.ts runs the same UI on OBIX's native runtime), and
 * bridges the framework-neutral application state into the UI's reactivity:
 *
 *   session.subscribe(state) → view = toView(state) → shallowRef → Vue schedules one render per tick → the runtime patches the DOM
 *
 * The UI's intents go back to the session, and the announcement policy (announcer.ts) decides what the live region says. Nothing here writes markup or attaches
 * listeners by hand; the session knows nothing of Vue.
 */
import { createApp, h, nextTick, shallowRef } from 'vue';
import AnyTuneApp from '../components/AnyTuneApp.obix';
import { toView } from '../app/view.ts';
import type { TunerView } from '../app/view.ts';
import { Announcer } from '../app/announcer.ts';
import type { MountDeps, MountedAnyTune } from './mount-types.ts';

export type { MountDeps, MountedAnyTune } from './mount-types.ts';

export function mountAnyTune(host: Element, { session, catalog, clock, input = () => null }: MountDeps): MountedAnyTune {
  const announcer = new Announcer(clock);
  let state = session.getState();
  let announcement = '';
  const view = shallowRef<TunerView>(toView(state, catalog, announcement, input()));
  const refresh = (): void => {
    view.value = toView(state, catalog, announcement, input());
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
  let renders = 0;
  const app = createApp({
    render() {
      renders++;
      return h(AnyTuneApp, {
        ...view.value,
        onSelectInstrument: (id: string) => session.selectInstrument(id),
        onSelectInput: (id: string) => void session.selectInput(id),
        onStart: () => void session.start(),
        onStop: () => void session.stop(),
      });
    },
  });
  app.mount(host);
  return {
    renders: () => renders,
    settled: () => nextTick(),
    unmount(): void {
      offSession();
      offAnnouncer();
      announcer.dispose();
      app.unmount();
    },
  };
}

import AnyTuneShell from '../components/AnyTuneShell.obix';
import type { ShellView } from '../app/shell-view.ts';
import type { ShellMountDeps } from './mount-types.ts';

/** The whole app on the Vue runtime: the shell's view bound as one render, its events handed to the app's handlers. */
export function mountShell(host: Element, { app }: ShellMountDeps): MountedAnyTune {
  const view = shallowRef<ShellView>(app.view());
  const off = app.subscribe(() => {
    view.value = app.view();
  });
  const on = app.handlers;
  let renders = 0;
  const vue = createApp({
    render() {
      renders++;
      return h(AnyTuneShell, {
        ...view.value,
        onNavigate: (screen: string) => on.navigate(screen),
        onBegin: () => on.begin(),
        onChoose: (id: string) => on.choose(id),
        onImportRecording: () => on.importRecording(),
        onOpenMidi: () => void on.openMidi(),
        onOpenObr: () => void on.openObr(),
        onTuneInstrument: (id: string) => on.tuneInstrument(id),
        onTuneInput: (id: string) => on.tuneInput(id),
        onTuneStart: () => on.tuneStart(),
        onTuneStop: () => on.tuneStop(),
        onPracticeStart: () => void on.practiceStart(),
        onPracticeBegin: () => void on.practiceBegin(),
        onPracticeCancel: () => on.practiceCancel(),
        onPracticeFree: () => void on.practiceFree(),
        onPracticeStop: () => void on.practiceStop(),
        onPracticeListen: () => on.practiceListen(),
        onPracticeRepeat: (bar: string) => on.practiceRepeat(bar),
        onPracticeTempo: (value: string) => on.practiceTempo(value),
        onPracticeFrom: (value: string) => on.practiceFrom(value),
        onPracticeTo: (value: string) => on.practiceTo(value),
        onPracticeMode: (value: string) => on.practiceMode(value),
        onPracticeHand: (value: string) => on.practiceHand(value),
        onPracticeMetronome: (checked: boolean) => on.practiceMetronome(checked),
        onPracticeReference: (checked: boolean) => on.practiceReference(checked),
        onPlaySong: (id: string) => on.playSong(id),
        onPlayStart: () => void on.playStart(),
        onPlayFeedback: () => void on.playFeedback(),
        onPlayBegin: () => void on.playBegin(),
        onPlayCancel: () => on.playCancel(),
        onPlayPause: () => on.playPause(),
        onPlayResume: () => on.playResume(),
        onPlayRestart: () => on.playRestart(),
        onPlayStop: () => on.playStop(),
        onPlayTempo: (value: string) => on.playTempo(value),
        onPlayReferenceVolume: (value: string) => on.playReferenceVolume(value),
        onPlayClickVolume: (value: string) => on.playClickVolume(value),
        onPlayMetronome: (checked: boolean) => on.playMetronome(checked),
        onPlayMode: (value: string) => on.playMode(value),
        onCapo: (value: string) => on.capo(value),
        onFollowSong: (id: string) => on.followSong(id),
        onFollowStart: () => void on.followStart(),
        onFollowBegin: () => on.followBegin(),
        onFollowCancel: () => on.followCancel(),
        onFollowHear: () => on.followHear(),
        onFollowFingering: () => on.followFingering(),
        onFollowSkip: () => on.followSkip(),
        onFollowRepeatBar: () => on.followRepeatBar(),
        onFollowMoveOn: () => on.followMoveOn(),
        onFollowRecheck: () => void on.followRecheck(),
        onFollowAgain: () => on.followAgain(),
        onFollowContinue: () => on.followContinue(),
        onFollowStop: () => on.followStop(),
        onFollowTempo: (value: string) => on.followTempo(value),
        onFollowAccompaniment: (value: string) => on.followAccompaniment(value),
        onFollowHeadphones: (checked: boolean) => on.followHeadphones(checked),
        onFollowConfidence: (value: string) => on.followConfidence(value),
        onFollowWindow: (value: string) => on.followWindow(value),
      });
    },
  });
  vue.mount(host);
  return {
    renders: () => renders,
    settled: () => nextTick(),
    unmount(): void {
      off();
      vue.unmount();
    },
  };
}
