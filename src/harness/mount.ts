/**
 * The demo execution harness: mounts AnyTune's .obix UI on the official Vue runtime (the Phase-5 demonstration path — OBIX has no runtime of its own yet), and
 * bridges the framework-neutral application state into the UI's reactivity:
 *
 *   session.subscribe(state) → view = toView(state) → shallowRef → Vue schedules one render per tick → the runtime patches the DOM
 *
 * The UI's intents go back to the session, and the announcement policy (announcer.ts) decides what the live region says. Nothing here writes markup or attaches
 * listeners by hand; the session knows nothing of Vue.
 */
import { createApp, h, shallowRef } from 'vue';
import AnyTuneApp from '../components/AnyTuneApp.obix';
import type { TuningSession } from '../app/session.ts';
import { toView } from '../app/view.ts';
import type { TunerView } from '../app/view.ts';
import type { InstrumentTuning } from '../domain/tuning.ts';
import type { InputSource, Scheduler } from '../domain/ports.ts';
import { Announcer } from '../app/announcer.ts';

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
  unmount(): void;
}

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
    unmount(): void {
      offSession();
      offAnnouncer();
      announcer.dispose();
      app.unmount();
    },
  };
}
