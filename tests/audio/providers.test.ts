/**
 * Pitch providers — the boundary between where a pitch comes from and what AnyTune does with it. A2 has two, both deterministic: a simulated provider that a
 * test (or the demo) drives by hand, and a provider that replays an AnyTune pitch recording (tests/fixtures/pitch, format `anytune-pitch-recording/1` —
 * simulated data, never an `.obr`). Failures are events, never exceptions: `start()` resolves whatever happens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SimulatedPitchProvider } from '../../src/audio/simulated-provider.ts';
import { RecordedPitchProvider } from '../../src/audio/recorded-provider.ts';
import { parseRecording } from '../../src/audio/recording.ts';
import type { PitchRecording } from '../../src/audio/recording.ts';
import type { ProviderEvent } from '../../src/domain/ports.ts';
import { ManualScheduler } from '../support/manual-scheduler.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures', 'pitch');
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const recording = (name: string): PitchRecording => {
  const parsed = parseRecording(fixture(name));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.recording;
};
const brief = (e: ProviderEvent): string =>
  e.kind === 'observation' ? `${e.observation.timestampMs} ${e.observation.frequencyHz}` : e.kind === 'silence' ? `${e.timestampMs} silence` : `${e.timestampMs} ${e.state}`;

test('the simulated provider: nothing before start; starting then listening; what it is told to hear, stamped with the clock; nothing after stop', async () => {
  const clock = new ManualScheduler();
  const provider = new SimulatedPitchProvider('simulated-microphone', clock);
  const seen: ProviderEvent[] = [];
  provider.subscribe((e) => seen.push(e));
  provider.hear(110);
  assert.equal(seen.length, 0, 'nothing is heard before start');
  await provider.start();
  clock.advance(100);
  provider.hear(108.5, { confidence: 0.8, varianceHz2: 0.09 });
  provider.silence();
  await provider.stop();
  provider.hear(110);
  assert.deepEqual(seen.map(brief), ['0 starting', '0 listening', '100 108.5', '100 silence', '100 stopped']);
  const heard = seen[2];
  assert.ok(heard?.kind === 'observation');
  assert.deepEqual(heard.observation, { sourceId: 'simulated-microphone', frequencyHz: 108.5, varianceHz2: 0.09, confidence: 0.8, timestampMs: 100 });
});

test('the simulated provider can fail as an input fails — permission denied, no device, disconnected — as a state, and start still resolves', async () => {
  for (const outcome of ['permission-denied', 'no-device'] as const) {
    const provider = new SimulatedPitchProvider('mic', new ManualScheduler(), { startOutcome: outcome });
    const seen: ProviderEvent[] = [];
    provider.subscribe((e) => seen.push(e));
    await provider.start();
    assert.deepEqual(seen.map(brief), ['0 starting', `0 ${outcome}`]);
    provider.hear(110);
    assert.equal(seen.length, 2, 'a provider that failed to start hears nothing');
  }
  const provider = new SimulatedPitchProvider('mic', new ManualScheduler());
  const seen: ProviderEvent[] = [];
  provider.subscribe((e) => seen.push(e));
  await provider.start();
  provider.disconnect();
  provider.hear(110);
  assert.deepEqual(seen.map(brief), ['0 starting', '0 listening', '0 disconnected']);
});

test('unsubscribing stops the events for that observer only; start and stop are idempotent', async () => {
  const provider = new SimulatedPitchProvider('mic', new ManualScheduler());
  const a: ProviderEvent[] = [];
  const b: ProviderEvent[] = [];
  const offA = provider.subscribe((e) => a.push(e));
  provider.subscribe((e) => b.push(e));
  await provider.start();
  await provider.start();
  offA();
  provider.hear(110);
  await provider.stop();
  await provider.stop();
  assert.deepEqual(a.map(brief), ['0 starting', '0 listening']);
  assert.deepEqual(b.map(brief), ['0 starting', '0 listening', '0 110', '0 stopped']);
});

test('a pitch recording is read and checked: the format, the origin, every entry — problems come back as data', () => {
  assert.equal(recording('guitar-a2-acceptance').entries.length, 4);
  assert.equal(recording('guitar-a2-acceptance').origin, 'simulated');
  const bad = parseRecording({
    format: 'something-else',
    origin: 'simulated',
    description: 'x',
    instrument: 'guitar-standard',
    entries: [
      { kind: 'observation', timestampMs: 0, sourceId: 's', frequencyHz: 110, varianceHz2: 0.04, confidence: 0.9 },
      { kind: 'observation', timestampMs: -1, sourceId: '', frequencyHz: 'x', varianceHz2: 0, confidence: 2 },
      { kind: 'state', timestampMs: 5, sourceId: 's', state: 'exploded' },
      { kind: 'observation', timestampMs: 3, sourceId: 's', frequencyHz: 110, varianceHz2: 0.04, confidence: 0.9 },
      { kind: 'mystery', timestampMs: 9 },
    ],
  });
  assert.deepEqual(bad, {
    ok: false,
    issues: [
      'format: expected "anytune-pitch-recording/1"',
      'entries[1].timestampMs: a non-negative finite number',
      'entries[1].sourceId: a non-empty string',
      'entries[1].frequencyHz: a finite number',
      'entries[1].varianceHz2: a positive finite number',
      'entries[1].confidence: a number from 0 to 1',
      'entries[2].state: one of disconnected, permission-denied, no-device',
      'entries[3].timestampMs: entries are in the order of time',
      'entries[4].kind: observation, silence or state',
    ],
  });
  assert.deepEqual(parseRecording(null), { ok: false, issues: ['a recording is an object'] });
  assert.deepEqual(parseRecording({ format: 'anytune-pitch-recording/1', origin: 'unknown', description: '', instrument: '', entries: [] }), {
    ok: false,
    issues: ['origin: "simulated" or "recorded" — where the pitches came from', 'description: a non-empty string', 'instrument: a non-empty string', 'entries: at least one entry'],
  });
});

test('every committed pitch fixture is a valid recording, of the simulated origin, and none is an .obr', () => {
  const files = fs.readdirSync(FIXTURES);
  assert.ok(files.length >= 10);
  for (const file of files) {
    assert.ok(file.endsWith('.json'), `${file}: pitch fixtures are JSON`);
    const parsed = parseRecording(JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')));
    assert.ok(parsed.ok, `${file}: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.recording.origin, 'simulated', file);
  }
});

test('the recorded provider replays a recording in time: each entry at its timestamp after start, then ended', async () => {
  const clock = new ManualScheduler();
  const provider = new RecordedPitchProvider(recording('guitar-a2-acceptance'), clock);
  const seen: ProviderEvent[] = [];
  provider.subscribe((e) => seen.push(e));
  clock.advance(40);
  await provider.start();
  assert.deepEqual(seen.map(brief), ['40 starting', '40 listening'], 'even the first entry is scheduled, never replayed inside start()');
  clock.advance(0);
  assert.deepEqual(seen.map(brief), ['40 starting', '40 listening', '40 108']);
  clock.advance(500);
  assert.deepEqual(seen.map(brief).slice(3), ['290 109', '540 110']);
  clock.advance(1000);
  assert.deepEqual(seen.map(brief).slice(5), ['790 110', '790 ended']);
  assert.equal(clock.pending, 0);
});

test('the recorded provider replays silence and a disconnection as events; stop cancels what is still to come', async () => {
  const clock = new ManualScheduler();
  const replay = new RecordedPitchProvider(recording('guitar-a2-disconnect'), clock);
  const seen: ProviderEvent[] = [];
  replay.subscribe((e) => seen.push(e));
  await replay.start();
  clock.advance(1000);
  assert.deepEqual(seen.map(brief), ['0 starting', '0 listening', '0 110', '250 110', '500 silence', '750 disconnected']);

  const clock2 = new ManualScheduler();
  const stopped = new RecordedPitchProvider(recording('guitar-a2-acceptance'), clock2);
  const seen2: ProviderEvent[] = [];
  stopped.subscribe((e) => seen2.push(e));
  await stopped.start();
  clock2.advance(300);
  await stopped.stop();
  clock2.advance(1000);
  assert.deepEqual(seen2.map(brief), ['0 starting', '0 listening', '0 108', '250 109', '300 stopped']);
  assert.equal(clock2.pending, 0);
});
