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
