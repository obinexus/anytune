/**
 * The composition of the browser demo, apart from the browser itself: the inputs the user chooses from, the session, and what the page says is supplying
 * the measurements. The browser entry (main.ts) gives it the real clock and the real microphone APIs; the tests give it virtual time and a fake browser —
 * so the tests exercise this very composition.
 *
 *   Microphone   MicrophonePitchProvider → InverseVarianceFusion (the microphone is its only source)
 *   Demo         DemoInput: a recording for Standard Guitar and Chromatic, a simulation for the others — no microphone, no Obicall
 *
 * The demo is the input the page starts on: nothing asks for the microphone until the user chooses it and presses Start.
 */
import type { InputSource, Scheduler } from '../domain/ports.ts';
import { DEFAULT_POLICY } from '../domain/tuning.ts';
import type { InstrumentTuning } from '../domain/tuning.ts';
import { CATALOG } from '../instruments/catalog.ts';
import { MicrophonePitchProvider } from '../audio/microphone-provider.ts';
import type { MicrophoneEnvironment } from '../audio/microphone-provider.ts';
import { InverseVarianceFusion } from '../fusion/pitch-fusion.ts';
import { TuningSession } from '../app/session.ts';
import { DemoInput } from './demo-input.ts';

export interface ComposeDeps {
  readonly clock: Scheduler;
  readonly microphone: MicrophoneEnvironment;
  readonly instrumentId?: string;
}

export interface ComposedAnyTune {
  readonly session: TuningSession;
  readonly catalog: readonly InstrumentTuning[];
  readonly microphone: MicrophonePitchProvider;
  readonly demo: DemoInput;
  /** what is supplying the measurements now, as the page says it */
  readonly input: () => InputSource;
}

export function composeAnyTune({ clock, microphone: environment, instrumentId = 'guitar-standard' }: ComposeDeps): ComposedAnyTune {
  const microphone = new MicrophonePitchProvider(environment, clock);
  const demo = new DemoInput(clock, instrumentId);
  const session = new TuningSession({
    inputs: [
      { id: 'microphone', label: 'Microphone', fusion: new InverseVarianceFusion([microphone], clock) },
      { id: 'demo', label: 'Demo (recorded / simulated)', fusion: demo },
    ],
    inputId: 'demo',
    catalog: CATALOG,
    policy: DEFAULT_POLICY,
    instrumentId,
  });
  // the demo's input follows the instrument chosen: it takes effect at its next start
  session.subscribe((state) => demo.select(state.instrumentId));
  const input = (): InputSource => {
    if (session.getState().inputId !== 'microphone') return demo.source;
    const info = microphone.info;
    return { kind: 'microphone', name: info === null ? 'your microphone, once Start is pressed' : `${info.device ?? 'microphone'}, ${info.sampleRate / 1000} kHz` };
  };
  return { session, catalog: CATALOG, microphone, demo, input };
}
