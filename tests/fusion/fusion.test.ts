/**
 * The PitchFusionPort — where observations of one or more pitch sources become one fused pitch for the tuning domain. Its implementations here are
 * SimulatedPitchFusion and RecordedPitchFusion: inverse-variance fusion (the compatibility implementation of Obicall's scalar rule) over simulated or recorded
 * providers. No Obicall process runs; pitch is not an Obicall observation type (docs/OBICALL.md). Failures are events.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InverseVarianceFusion, RecordedPitchFusion, SimulatedPitchFusion } from '../../src/fusion/pitch-fusion.ts';
import { SimulatedPitchProvider } from '../../src/audio/simulated-provider.ts';
import { parseRecording } from '../../src/audio/recording.ts';
import type { FusionEvent } from '../../src/domain/ports.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'pitch');
const load = (name: string) => {
  const parsed = parseRecording(JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
  assert.ok(parsed.ok);
  return parsed.recording;
};
const brief = (e: FusionEvent): string =>
  e.kind === 'fused'
    ? `${e.pitch.timestampMs} ${Number(e.pitch.frequencyHz.toFixed(4))} [${e.pitch.sourceIds.join(',')}]`
    : e.kind === 'silence'
      ? `${e.timestampMs} silence`
      : e.kind === 'rejected'
        ? `${e.timestampMs} rejected`
        : `${e.timestampMs} ${e.state}`;

test('one source: its pitch passes through — frequency, variance and confidence unchanged', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const seen: FusionEvent[] = [];
  fusion.port.subscribe((e) => seen.push(e));
  await fusion.port.start();
  fusion.providers[0]?.hear(108, { confidence: 0.9, varianceHz2: 0.04 });
  assert.deepEqual(seen.map(brief), ['0 starting', '0 listening', '0 108 [simulated-microphone]']);
  const fused = seen[2];
  assert.ok(fused?.kind === 'fused');
  assert.deepEqual(fused.pitch, { frequencyHz: 108, varianceHz2: 0.04, confidence: 0.9, timestampMs: 0, sourceIds: ['simulated-microphone'] });
});

test('two sources heard within the window fuse by inverse variance; the confidence is weighted the same way', async () => {
  const clock = new ManualScheduler();
  const a = new SimulatedPitchProvider('a', clock);
  const b = new SimulatedPitchProvider('b', clock);
  const port = new InverseVarianceFusion([a, b], clock, { windowMs: 100 });
  const seen: FusionEvent[] = [];
  port.subscribe((e) => seen.push(e));
  await port.start();
  a.hear(110.0, { varianceHz2: 0.04, confidence: 1.0 });
  clock.advance(10);
  b.hear(110.4, { varianceHz2: 0.16, confidence: 0.5 });
  const last = seen.at(-1);
  assert.ok(last?.kind === 'fused');
  // (110.0/0.04 + 110.4/0.16) / (1/0.04 + 1/0.16) = 110.08; variance 1/(25 + 6.25) = 0.032; confidence (1.0·25 + 0.5·6.25)/31.25 = 0.9
  assert.ok(Math.abs(last.pitch.frequencyHz - 110.08) < 1e-9);
  assert.ok(Math.abs(last.pitch.varianceHz2 - 0.032) < 1e-12);
  assert.ok(Math.abs(last.pitch.confidence - 0.9) < 1e-12);
  assert.deepEqual([last.pitch.timestampMs, last.pitch.sourceIds], [10, ['a', 'b']]);
});

test('an observation older than the window is not fused with a new one; silence from a source takes it out', async () => {
  const clock = new ManualScheduler();
  const a = new SimulatedPitchProvider('a', clock);
  const b = new SimulatedPitchProvider('b', clock);
  const port = new InverseVarianceFusion([a, b], clock, { windowMs: 100 });
  const seen: FusionEvent[] = [];
  port.subscribe((e) => seen.push(e));
  await port.start();
  a.hear(110, { varianceHz2: 0.04 });
  clock.advance(150);
  b.hear(111, { varianceHz2: 0.04 });
  a.hear(109, { varianceHz2: 0.04 });
  b.silence();
  a.silence();
  assert.deepEqual(seen.map(brief).slice(2), ['0 110 [a]', '150 111 [b]', '150 110 [a,b]', '150 109 [a]', '150 silence']);
});

test('an observation fusion must refuse — a variance that is not positive, a frequency that is not finite — is dropped, and said', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const seen: FusionEvent[] = [];
  fusion.port.subscribe((e) => seen.push(e));
  await fusion.port.start();
  const mic = fusion.providers[0];
  assert.ok(mic);
  mic.hear(110, { varianceHz2: 0 });
  mic.hear(Number.NaN);
  mic.hear(110);
  assert.deepEqual(seen.map(brief).slice(2), ['0 rejected', '0 rejected', '0 110 [simulated-microphone]']);
});

test('the state of the inputs is the state of the fusion: failed to start, disconnected, degraded while one of two is left, ended', async () => {
  const clock = new ManualScheduler();
  const denied = SimulatedPitchFusion(clock, { startOutcome: 'permission-denied' });
  const seen: FusionEvent[] = [];
  denied.port.subscribe((e) => seen.push(e));
  await denied.port.start();
  assert.deepEqual(seen.map(brief), ['0 starting', '0 permission-denied']);

  const a = new SimulatedPitchProvider('a', clock);
  const b = new SimulatedPitchProvider('b', clock);
  const two = new InverseVarianceFusion([a, b], clock, { windowMs: 100 });
  const seen2: FusionEvent[] = [];
  two.subscribe((e) => seen2.push(e));
  await two.start();
  a.disconnect();
  b.disconnect();
  assert.deepEqual(seen2.map(brief), ['0 starting', '0 listening', '0 degraded', '0 disconnected']);

  const none = new InverseVarianceFusion([], clock, { windowMs: 100 });
  const seen3: FusionEvent[] = [];
  none.subscribe((e) => seen3.push(e));
  await none.start();
  assert.deepEqual(seen3.map(brief), ['0 unavailable']);
});

test('RecordedPitchFusion replays a recording through the fusion, deterministically: the acceptance sequence, then ended', async () => {
  const clock = new ManualScheduler();
  const port = RecordedPitchFusion(load('guitar-a2-acceptance'), clock);
  const seen: FusionEvent[] = [];
  port.subscribe((e) => seen.push(e));
  await port.start();
  clock.advance(2000);
  assert.deepEqual(seen.map(brief), [
    '0 starting',
    '0 listening',
    '0 108 [simulated-microphone]',
    '250 109 [simulated-microphone]',
    '500 110 [simulated-microphone]',
    '750 110 [simulated-microphone]',
    '750 ended',
  ]);
});

test('RecordedPitchFusion of two simulated sources: each reading is the inverse-variance fusion of the two latest', async () => {
  const clock = new ManualScheduler();
  const port = RecordedPitchFusion(load('guitar-a2-two-sources'), clock, { windowMs: 100 });
  const seen: FusionEvent[] = [];
  port.subscribe((e) => seen.push(e));
  await port.start();
  clock.advance(1000);
  // 10 ms: (109.8/0.04 + 110.3/0.16)/(25 + 6.25) = 109.9; 260 ms: (109.9/0.04 + 110.2/0.16)/31.25 = 109.96
  assert.deepEqual(seen.map(brief).slice(2), [
    '0 109.8 [simulated-microphone]',
    '10 109.9 [simulated-contact-pickup,simulated-microphone]',
    '250 109.9 [simulated-microphone]',
    '260 109.96 [simulated-contact-pickup,simulated-microphone]',
    '260 ended',
  ]);
});

test('stop stops every provider and says so; nothing is fused after it', async () => {
  const clock = new ManualScheduler();
  const fusion = SimulatedPitchFusion(clock);
  const seen: FusionEvent[] = [];
  fusion.port.subscribe((e) => seen.push(e));
  await fusion.port.start();
  await fusion.port.stop();
  fusion.providers[0]?.hear(110);
  assert.deepEqual(seen.map(brief), ['0 starting', '0 listening', '0 stopped']);
});
