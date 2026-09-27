/**
 * A9 — the UI says what is supplying the measurements. A simulation must never look like a real instrument being heard: the view states the kind of input —
 * simulated, recorded, or (later) a microphone — and its name, in words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TuningSession } from '../../src/app/session.ts';
import { toView } from '../../src/app/view.ts';
import { DEFAULT_POLICY } from '../../src/domain/tuning.ts';
import { CATALOG } from '../../src/instruments/catalog.ts';
import { SimulatedPitchFusion } from '../../src/fusion/pitch-fusion.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const state = () => new TuningSession({ fusion: SimulatedPitchFusion(new ManualScheduler()).port, catalog: CATALOG, policy: DEFAULT_POLICY, instrumentId: 'guitar-standard' }).getState();

test('the view states the input: its kind in a word, and its name — or that there is none', () => {
  assert.equal(toView(state(), CATALOG, '', { kind: 'simulated', name: 'Standard Bass, E1 rising to pitch' }).inputSourceText, 'Input: Simulated — Standard Bass, E1 rising to pitch');
  assert.equal(toView(state(), CATALOG, '', { kind: 'recorded', name: 'guitar A2 sequence' }).inputSourceText, 'Input: Recorded — guitar A2 sequence');
  assert.equal(toView(state(), CATALOG, '', { kind: 'microphone', name: 'Default microphone' }).inputSourceText, 'Input: Microphone — Default microphone');
  assert.equal(toView(state(), CATALOG).inputSourceText, 'Input: none');
});
