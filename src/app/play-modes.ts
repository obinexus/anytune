/**
 * Play's two ways, offered side by side on both of its screens: Follow my playing (each target waits for the learner) and Play along (the song keeps
 * time, with strict early/late scoring when feedback is on).
 */
export interface PlayMode {
  readonly value: string;
  readonly label: string;
  /** "true" or "false", for aria-pressed */
  readonly pressed: string;
  readonly key: string;
}

export const playModes = (mode: 'follow' | 'along'): PlayMode[] => [
  { value: 'follow', label: 'Follow my playing', pressed: String(mode === 'follow'), key: 'mode-follow' },
  { value: 'along', label: 'Play along (keeps time)', pressed: String(mode === 'along'), key: 'mode-along' },
];
