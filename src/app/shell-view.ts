/**
 * The whole app's view, for the shell component: the screen shown, the navigation, and each screen's own view. Composed here; the components bind it.
 */
import type { FollowView } from './follow-view.ts';
import type { PlayView } from './play-view.ts';
import type { PracticeView } from './practice-view.ts';
import { SCREENS, type HomeView, type LibraryView, type ProgressView, type Screen } from './shell.ts';
import type { TunerView } from './view.ts';

export interface NavItem {
  readonly id: Screen;
  readonly label: string;
  /** "page" for the screen shown, "false" for the others */
  readonly ariaCurrent: 'page' | 'false';
  readonly intent: string;
}

export interface ShellView {
  readonly screen: Screen;
  readonly nav: readonly NavItem[];
  readonly home: HomeView;
  readonly library: LibraryView;
  readonly tuner: TunerView;
  readonly practice: PracticeView;
  readonly play: PlayView;
  readonly follow: FollowView;
  /** on the Play screen: Follow my playing, or Play along — "none" elsewhere */
  readonly playScreen: 'follow' | 'along' | 'none';
  readonly progress: ProgressView;
}

export function navOf(screen: Screen): NavItem[] {
  return SCREENS.map((s) => ({ id: s.id, label: s.label, ariaCurrent: s.id === screen ? 'page' : 'false', intent: `navigate=${s.id}` }));
}
