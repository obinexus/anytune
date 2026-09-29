/**
 * The two runtimes AnyTune's UI runs on, from the SAME .obix files (Phase 6, N11):
 *
 *   vue     the .obix components compiled by the OBIX Vue frontend and run on the official Vue runtime (src/harness/mount.ts) — the default
 *   native  the .obix components lowered to canonical DOP IR and run by OBIX's own runtime, obix-runtime-browser (src/harness/mount-native.ts) — no Vue
 *
 * Both take the same application (session, catalog, clock, input) and return the same handle, so a scenario is written once and run on each. `settle` waits until the
 * page shows every pending update. Import this after the .obix hooks are registered (tests/support/obix-loader.ts).
 */
import type { MountDeps, MountedAnyTune } from '../../src/harness/mount-types.ts';

export interface Runtime {
  readonly name: 'vue' | 'native';
  mount(host: Element, deps: MountDeps): MountedAnyTune;
  settle(): Promise<void>;
}

const vue = await import('../../src/harness/mount.ts');
const native = await import('../../src/harness/mount-native.ts');
const { nextTick: vueTick } = await import('vue');
const { nextTick: obixTick } = await import('obix-runtime-reactivity');

export const RUNTIMES: readonly Runtime[] = [
  { name: 'vue', mount: vue.mountAnyTune, settle: () => vueTick() },
  { name: 'native', mount: native.mountAnyTune, settle: () => obixTick() },
];
