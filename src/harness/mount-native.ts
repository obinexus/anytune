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
