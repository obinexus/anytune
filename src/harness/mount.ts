/**
 * The demo execution harness: mounts AnyTune's .obix UI on the official Vue runtime (the Phase-5 demonstration path — OBIX has no runtime of its own yet), and
 * bridges the framework-neutral application state into the UI's reactivity:
 *
 *   session.subscribe(state) → view = toView(state) → shallowRef → Vue schedules one render per tick → the runtime patches the DOM
 *
 * The UI's intents go back to the session. Nothing here writes markup or attaches listeners by hand; the session knows nothing of Vue.
 */
import { createApp, h, shallowRef } from 'vue';
import AnyTuneApp from '../components/AnyTuneApp.obix';
import type { TuningSession } from '../app/session.ts';
import { toView } from '../app/view.ts';
import type { TunerView } from '../app/view.ts';
import type { InstrumentTuning } from '../domain/tuning.ts';

export interface MountDeps {
  readonly session: TuningSession;
  readonly catalog: readonly InstrumentTuning[];
}

export interface MountedAnyTune {
  /** how many times the UI rendered — the visual refresh, which the tests hold apart from the rate of the pitches */
  renders(): number;
  unmount(): void;
}

export function mountAnyTune(host: Element, { session, catalog }: MountDeps): MountedAnyTune {
  const view = shallowRef<TunerView>(toView(session.getState(), catalog));
  const off = session.subscribe((state) => {
    view.value = toView(state, catalog);
  });
  let renders = 0;
  const app = createApp({
    render() {
      renders++;
      return h(AnyTuneApp, {
        ...view.value,
        onSelectInstrument: (id: string) => session.selectInstrument(id),
        onStart: () => void session.start(),
        onStop: () => void session.stop(),
      });
    },
  });
  app.mount(host);
  return {
    renders: () => renders,
    unmount(): void {
      off();
      app.unmount();
    },
  };
}
