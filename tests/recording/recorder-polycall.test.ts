/**
 * The recorder module, end to end through Polycall: the staged polycall.exe (Polycall 1.1.0, main at 2dcab63) loads AnyTune's recorder plugin
 * (native/windows-x86_64/lib/anytune_recorder.dll) and serves it on loopback; AnyTune's TypeScript client reaches it over polycall_rpc v1. Nothing is mocked:
 * a real runtime, a real socket, real files. What the C module writes is checked with the independent TypeScript codec, and what the TypeScript codec writes
 * is replayed by the C module. Skipped — saying so — when the native artifacts are not staged (npm run native:stage, npm run native:recorder).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TcpPolycallTransport } from '../../src/polycall/node/tcp-transport.ts';
import { readRecording, writeRecording, type RecordedEvent, type RecordingHeader } from '../../src/recording/format.ts';
import { PolycallRecorder } from '../../src/recording/recorder.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const POLYCALL = path.join(ROOT, 'native', 'windows-x86_64', 'bin', 'polycall.exe');
const PLUGIN = path.join(ROOT, 'native', 'windows-x86_64', 'lib', 'anytune_recorder.dll');
const staged = os.platform() === 'win32' && fs.existsSync(POLYCALL) && fs.existsSync(PLUGIN);
const SKIP = staged ? false : 'Polycall and the recorder plugin are not staged (npm run native:stage && npm run native:recorder)';

const TOKEN = crypto.randomBytes(32).toString('base64url');
const SHUTDOWN = crypto.randomBytes(24).toString('base64url');
let dir = '';
let runtime: ChildProcess | null = null;
let transport: TcpPolycallTransport;
let recorder: PolycallRecorder;

before(async () => {
  if (!staged) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-recordings-'));
  const endpointFile = path.join(dir, 'endpoint.txt');
  runtime = spawn(POLYCALL, ['start', '--endpoint', '127.0.0.1:0', '--endpoint-file', endpointFile, '--auth-token', SHUTDOWN, '--load', PLUGIN], {
    env: { ...process.env, ANYTUNE_RECORDINGS_DIR: dir, ANYTUNE_RECORDER_TOKEN: TOKEN },
    // Polycall writes its telemetry under its working directory (.polycall/): the temporary directory, never the repository
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = Date.now();
  while (!fs.existsSync(endpointFile) || fs.readFileSync(endpointFile, 'utf8').trim() === '') {
    if (Date.now() - started > 15000 || runtime.exitCode !== null) throw new Error(`polycall start did not bind (exit ${runtime.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  transport = new TcpPolycallTransport(fs.readFileSync(endpointFile, 'utf8').trim());
  recorder = new PolycallRecorder(transport, TOKEN);
});

after(async () => {
  if (runtime === null) return;
  const exited = new Promise((resolve) => runtime?.once('exit', resolve));
  await transport.control('shutdown', SHUTDOWN);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
  if (runtime.exitCode === null) runtime.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Each record's offset, type and payload length, walked from the file header. */
const recordsOf = (bytes: Uint8Array): { offset: number; type: number; length: number }[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { offset: number; type: number; length: number }[] = [];
  for (let at = 16; at + 12 <= bytes.length; at += 12 + view.getUint32(at + 4, true)) out.push({ offset: at, type: bytes[at] as number, length: view.getUint32(at + 4, true) });
  return out;
};
const fileOf = (id: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(dir, `${id}.atrec`)));
const META = { referenceId: 'ref-c82120509bb3', songId: 'fur-elise', clock: { domain: 'capture-monotonic', unit: 's' }, sources: [{ id: 'mic', kind: 'microphone', units: 'Hz' }] };

test('the runtime describes the recorder’s five operations beside its built-ins — loaded from the plugin, with no Polycall rebuild', { skip: SKIP }, async () => {
  const reply = await transport.control('describe');
  assert.ok(reply.ok, JSON.stringify(reply));
  const names = JSON.stringify(reply.output);
  for (const op of ['create', 'append', 'finish', 'read', 'list']) assert.match(names, new RegExp(`"service":"recording","operation":"${op}"`));
});

test('every operation is refused without the session token, or with a wrong one — Polycall itself authenticates no request', { skip: SKIP }, async () => {
  const none = await transport.call('recording', 'list', {});
  assert.deepEqual(none.ok ? null : none.error.code, 'auth.denied');
  const wrong = await new PolycallRecorder(transport, `${TOKEN.slice(0, -1)}x`).list();
  assert.deepEqual(wrong.ok ? null : wrong.error.code, 'auth.denied');
});

test('an attempt is recorded and replayed through Polycall: header, every event in order, complete and intact — and the TypeScript codec reads the file the same', { skip: SKIP }, async () => {
  const created = await recorder.create('attempt', META);
  assert.ok(created.ok, JSON.stringify(created));
  const id = created.value.recordingId;
  assert.match(id, /^[0-9a-f]{32}$/);
  const batches: RecordedEvent[][] = [
    [{ t: 0.012, kind: 'pitch', hz: 329.6, cents: -3.1, confidence: 0.94, source: 'mic' }, { t: 0.02, kind: 'onset', strength: 0.8 }],
    [{ t: 0.5, kind: 'chord', candidates: [{ symbol: 'Am', score: 0.71 }, { symbol: 'C', score: 0.22 }], note: 'É — not a symbol AnyTune decides here' }],
    [{ t: 0.5, kind: 'feedback', target: 'n7', timing: 'late', dtSeconds: 0.061, pitch: 'correct' }, { t: 1.25, kind: 'onset', strength: 0.5 }],
  ];
  for (const batch of batches) {
    const appended = await recorder.append(id, batch);
    assert.ok(appended.ok, JSON.stringify(appended));
  }
  const finished = await recorder.finish(id);
  assert.ok(finished.ok && finished.value.events === 5, JSON.stringify(finished));

  const replay = await recorder.replay(id);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.deepEqual(replay.value.events, batches.flat());
  assert.equal(replay.value.complete, true);
  assert.equal(replay.value.intact, true);
  assert.equal(replay.value.header.kind, 'attempt');
  assert.equal(replay.value.header.format, 'anytune-recording');
  assert.equal(replay.value.header.version, '1.0');
  assert.deepEqual(replay.value.header.meta, META);

  const independent = readRecording(fileOf(id));
  assert.ok(independent.ok);
  assert.deepEqual(independent.events, batches.flat());
  assert.deepEqual(independent.header, replay.value.header);
  assert.deepEqual({ complete: independent.complete, intact: independent.intact, events: independent.end?.events, lastT: independent.end?.lastT }, { complete: true, intact: true, events: 5, lastT: 1.25 });
});

test('the module keeps time order and refuses what is not an event; a finished recording takes no more; an attempt must name its reference', { skip: SKIP }, async () => {
  const noReference = await recorder.create('attempt', { songId: 'x' });
  assert.equal(noReference.ok ? null : noReference.error.code, 'input.invalid');
  const created = await recorder.create('attempt', META);
  assert.ok(created.ok);
  const id = created.value.recordingId;
  assert.ok((await recorder.append(id, [{ t: 2, kind: 'onset' }])).ok);
  const backwards = await recorder.append(id, [{ t: 1.999, kind: 'onset' }]);
  assert.equal(backwards.ok ? null : backwards.error.code, 'recording.order');
  const untimed = await transport.call('recording', 'append', { token: TOKEN, recordingId: id, events: [{ kind: 'onset' }] });
  assert.equal(untimed.ok ? null : untimed.error.code, 'input.invalid');
  assert.ok((await recorder.finish(id)).ok);
  const late = await recorder.append(id, [{ t: 3, kind: 'onset' }]);
  assert.equal(late.ok ? null : late.error.code, 'recording.not_open');
  // the refused appends wrote nothing
  const replay = await recorder.replay(id);
  assert.ok(replay.ok);
  assert.deepEqual(replay.value.events, [{ t: 2, kind: 'onset' }]);
});

test('a recording id is never a path: anything but 32 lowercase hex digits is refused before any file is touched', { skip: SKIP }, async () => {
  for (const recordingId of ['../../etc/passwd', '..\\..\\Windows\\win.ini', 'ABCDEF0123456789ABCDEF0123456789', '0'.repeat(31), `${'0'.repeat(32)}/x`]) {
    const reply = await transport.call('recording', 'read', { token: TOKEN, recordingId });
    assert.equal(reply.ok ? null : reply.error.code, 'input.invalid', recordingId);
  }
});

test('a long recording is replayed in pages under Polycall’s 64 KiB reply limit, and the pages join into every event, in order', { skip: SKIP }, async () => {
  const created = await recorder.create('reference', { referenceId: 'ref-long', source: 'midi' });
  assert.ok(created.ok);
  const id = created.value.recordingId;
  const events: RecordedEvent[] = Array.from({ length: 3000 }, (_, i) => ({ t: i * 0.01, kind: 'note', key: 60 + (i % 12), velocity: 64, durationSeconds: 0.0095 }));
  assert.ok((await recorder.append(id, events.slice(0, 1500))).ok);
  assert.ok((await recorder.append(id, events.slice(1500))).ok);
  assert.ok((await recorder.finish(id)).ok);
  const first = await recorder.read(id, 0, 400);
  assert.ok(first.ok);
  assert.equal(first.value.events.length, 400, 'max is honoured when the page fits');
  assert.equal(first.value.next, 400);
  assert.equal(first.value.total, 3000);
  // asked for 5000, a page stops where the reply would outgrow Polycall's 64 KiB: some hundreds of these ~100-byte events, and a cursor to go on
  const unbounded = await recorder.read(id, 0, 5000);
  assert.ok(unbounded.ok && unbounded.value.next !== null && unbounded.value.next === unbounded.value.events.length && unbounded.value.next < 3000);
  assert.ok(JSON.stringify(unbounded.value).length < 64 * 1024);
  const replay = await recorder.replay(id);
  assert.ok(replay.ok);
  assert.deepEqual(replay.value.events, events);
});

test('what the TypeScript codec writes, the C module replays — the two implementations agree in both directions', { skip: SKIP }, async () => {
  const id = crypto.randomBytes(16).toString('hex');
  const header: RecordingHeader = { format: 'anytune-recording', version: '1.0', recordingId: id, kind: 'attempt', createdAt: '2026-10-11T00:00:00Z', meta: META };
  const batches: RecordedEvent[][] = [[{ t: 0, kind: 'onset' }], [{ t: 0.25, kind: 'pitch', hz: 110 }, { t: 0.5, kind: 'pitch', hz: 110.4 }]];
  fs.writeFileSync(path.join(dir, `${id}.atrec`), writeRecording(header, batches, { events: 3, lastT: 0.5, finishedAt: '2026-10-11T00:00:01Z' }));
  const replay = await recorder.replay(id);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.deepEqual(replay.value.header, header);
  assert.deepEqual(replay.value.events, batches.flat());
  assert.equal(replay.value.complete, true);
});

test('a recording cut short by a crash is replayed as far as it was written, reported incomplete and not intact — the C module and the TypeScript codec stop at the same byte, for the same reason', { skip: SKIP }, async () => {
  const created = await recorder.create('attempt', META);
  assert.ok(created.ok);
  const id = created.value.recordingId;
  assert.ok((await recorder.append(id, [{ t: 0.1, kind: 'onset' }])).ok);
  assert.ok((await recorder.append(id, [{ t: 0.2, kind: 'onset' }, { t: 0.3, kind: 'onset' }])).ok);
  assert.ok((await recorder.finish(id)).ok);
  const whole = fileOf(id);
  const tornId = crypto.randomBytes(16).toString('hex');
  // cut inside the second EVENTS record's payload: the END is gone with it. The records' boundaries are read from the file, not guessed.
  const records = recordsOf(whole);
  assert.deepEqual(records.map((r) => r.type), [1, 2, 2, 3]);
  const second = records[2] as { offset: number; length: number };
  const cut = second.offset + 12 + Math.floor(second.length / 2);
  fs.writeFileSync(path.join(dir, `${tornId}.atrec`), whole.subarray(0, cut));
  const replay = await recorder.replay(tornId);
  assert.ok(replay.ok, JSON.stringify(replay));
  const independent = readRecording(fileOf(tornId));
  assert.ok(independent.ok);
  assert.deepEqual(replay.value.events, [{ t: 0.1, kind: 'onset' }]);
  assert.deepEqual(independent.events, replay.value.events);
  assert.deepEqual([replay.value.complete, replay.value.intact], [false, false]);
  assert.deepEqual(replay.value.stop, independent.stop);
  assert.equal(replay.value.stop?.reason, 'a record cut short');
  // a flipped byte in a payload: the CRC catches it, on both sides
  const flipped = new Uint8Array(whole);
  flipped[second.offset + 12 + 3] = (flipped[second.offset + 12 + 3] as number) ^ 0x20;
  fs.writeFileSync(path.join(dir, `${tornId}.atrec`), flipped);
  const crcReplay = await recorder.replay(tornId);
  const crcLocal = readRecording(flipped);
  assert.ok(crcReplay.ok && crcLocal.ok);
  assert.deepEqual(crcReplay.value.stop, crcLocal.stop);
  assert.equal(crcReplay.value.stop?.reason, 'a record whose CRC does not hold');
});

test('the recordings of one reference are listed — kind, creation time, completeness, count — and only theirs', { skip: SKIP }, async () => {
  const listed = await recorder.list('ref-long');
  assert.ok(listed.ok, JSON.stringify(listed));
  assert.equal(listed.value.recordings.length, 1);
  assert.deepEqual({ ...listed.value.recordings[0], recordingId: '', createdAt: '' }, { recordingId: '', kind: 'reference', createdAt: '', referenceId: 'ref-long', complete: true, events: 3000 });
  const attempts = await recorder.list(META.referenceId);
  assert.ok(attempts.ok);
  assert.ok(attempts.value.recordings.length >= 3 && attempts.value.recordings.every((r) => r.referenceId === META.referenceId));
});
