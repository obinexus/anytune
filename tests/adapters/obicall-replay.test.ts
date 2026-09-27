/**
 * A7 — the conformance of ObicallReplayReader to Obicall's real replay format, on Obicall's real recording (tests/fixtures/obicall/demo.obr, copied from the
 * staged build of obicall ae5581a, its SHA-256 pinned to Obicall's own manifest). A FORMAT adapter, never a pitch provider: what demo.obr holds is 2-D
 * positions in metres, and they are read as what they are — never as a frequency. Obicall has no unit for one (docs/OBICALL.md).
 *
 * The oracle is Obicall itself: tools/obicall/record-oracle.ts gave the recording and every torn variant of it (tools/obicall/torn-variants.ts) to the real
 * staged `obicall replay`, and kept what it said (tests/fixtures/obicall/replay-oracle.json); the last test asks it again when the staged build is present.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JORB_MAGIC, OBICALL_SHAPES, OBICALL_UNITS, ObicallReplayReader, RECORD_HEADER_LEN, crc32, readReplay } from '../../src/adapters/obicall-replay.ts';
import { DEMO_RECORD_LEN, tornVariants } from '../../tools/obicall/torn-variants.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEMO = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'obicall', 'demo.obr')));
const ORACLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'obicall', 'replay-oracle.json'), 'utf8'));
/** Obicall's manifest of the staged build (stage-anytune/OBICALL_ARTIFACTS.json): share/obicall/recordings/demo.obr */
const DEMO_SHA256 = '3838115346787cfacb55674dd738b5437ec01858a6fd28651ccad417786c79b4';

test('the fixture is Obicall’s real recording: 19 992 bytes, the SHA-256 of Obicall’s own manifest', () => {
  assert.equal(DEMO.length, 19992);
  assert.equal(crypto.createHash('sha256').update(DEMO).digest('hex'), DEMO_SHA256);
  assert.equal(ORACLE.demoSha256, DEMO_SHA256, 'the oracle was asked about this very file');
});

test('CRC-32 is Obicall’s: CRC-32/ISO-HDLC — the check value of "123456789" is cbf43926, and the empty input is 0', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('demo.obr is 102 records of 196 bytes: each a JORB header of 40 little-endian bytes whose lengths and CRC hold, then the observation it seals', () => {
  const { records, stop } = readReplay(DEMO);
  assert.equal(records.length, 102);
  assert.deepEqual(stop, { kind: 'end', offset: DEMO.length });
  records.forEach((record, i) => {
    assert.equal(record.offset, i * DEMO_RECORD_LEN);
    assert.equal(record.header.magic, JORB_MAGIC);
    assert.equal(record.header.observationLen, DEMO_RECORD_LEN - RECORD_HEADER_LEN);
    assert.equal(record.header.recordLen, RECORD_HEADER_LEN + record.header.observationLen);
    assert.equal(record.header.crc32, crc32(DEMO.subarray(record.offset + RECORD_HEADER_LEN, record.offset + record.header.recordLen)));
    assert.equal(record.header.reserved, 0);
  });
  // "JORB" is the magic read as a little-endian u32: the bytes on disk are B R O J
  assert.deepEqual([...DEMO.subarray(0, 4)], [0x42, 0x52, 0x4f, 0x4a]);
});

test('the window sequence runs 1…102, every record admitted (reason 0, ADMIT_OK), and the admission time never goes back', () => {
  const { records } = readReplay(DEMO);
  assert.deepEqual(records.map((r) => r.header.windowSeq), records.map((_, i) => BigInt(i + 1)));
  assert.ok(records.every((r) => r.header.admissionReason === 0));
  for (let i = 1; i < records.length; i++) assert.ok((records[i]?.header.admittedAtNs as bigint) >= (records[i - 1]?.header.admittedAtNs as bigint));
});

test('the observations decode from Obicall’s wire format: two sensors, each restarted once, their sequences rising within a boot — 2-D positions in METRES with a 2×2 covariance, never a pitch', () => {
  const { records } = readReplay(DEMO);
  for (const { observation } of records) {
    assert.equal(OBICALL_SHAPES[observation.payloadShape], 'position-2d');
    assert.equal(OBICALL_UNITS[observation.units], 'meters');
    assert.equal(observation.payload.length, 2);
    assert.equal(observation.covariance.length, 4);
    assert.ok(observation.payload.every(Number.isFinite) && observation.covariance.every(Number.isFinite));
    assert.ok(observation.sampleTimeNs <= observation.arrivalTimeNs);
  }
  // a boot id is a source's restart, and its sequence numbering restarts with it (include/obicall/journal.h): per sensor and boot, 1 … n, rising
  const sources = new Map<string, bigint[]>();
  for (const { observation } of records) {
    const key = `${observation.sensorId}#${observation.sourceBootId}`;
    sources.set(key, [...(sources.get(key) ?? []), observation.sequence]);
  }
  const bySensor = new Map<string, number[]>();
  for (const [key, sequences] of sources) {
    assert.deepEqual(sequences, sequences.map((_, i) => BigInt(i + 1)), key);
    const sensor = key.split('#')[0] as string;
    bySensor.set(sensor, [...(bySensor.get(sensor) ?? []), sequences.length]);
  }
  assert.deepEqual(Object.fromEntries(bySensor), { cam_position_a: [29, 29], imu_a: [22, 22] });
  // Obicall's units are metres, metres per second and radians: there is no unit a frequency could be read in
  assert.deepEqual(Object.values(OBICALL_UNITS), ['unspecified', 'meters', 'meters-per-second', 'radians']);
});

test('read one record at a time, as obicall_journal_read_record reads them: a record, then the clean end — and the end again, however often it is asked', () => {
  const reader = new ObicallReplayReader(DEMO);
  let count = 0;
  for (let step = reader.next(); step.kind === 'record'; step = reader.next()) count++;
  assert.equal(count, 102);
  assert.deepEqual(reader.next(), { kind: 'end', offset: DEMO.length });
  assert.equal(reader.offset, DEMO.length);
});

test('torn and malformed recordings: the reader stops at the first bad record — never skips past it — keeps what came before, and says what Obicall says', () => {
  for (const variant of tornVariants(DEMO)) {
    const expected = ORACLE.variants[variant.name];
    assert.ok(expected, `the oracle knows ${variant.name}`);
    const { records, stop } = readReplay(variant.bytes);
    const said = {
      recordsTotal: records.length,
      admitted: records.filter((r) => r.header.admissionReason === 0).length,
      finalWindowSeq: records.length === 0 ? 0 : Number(records[records.length - 1]?.header.windowSeq),
      stoppedAt: stop.kind === 'end' ? null : stop.obicallStatus,
    };
    assert.deepEqual(said, { recordsTotal: expected.recordsTotal, admitted: expected.admitted, finalWindowSeq: expected.finalWindowSeq, stoppedAt: expected.stoppedAt }, `${variant.name}: ${variant.what}`);
    // the offset is left at the start of the bad record, as Obicall leaves the file position — so a writer can truncate it
    if (stop.kind !== 'end') assert.equal(stop.offset, records.length * DEMO_RECORD_LEN, variant.name);
  }
  // each kind of stop is among them
  assert.deepEqual(new Set(Object.values(ORACLE.variants).map((v) => (v as { stoppedAt: string | null }).stoppedAt)), new Set([null, 'malformed wire frame', 'wire checksum mismatch', 'wire frame too large']));
});

test('the live oracle: the staged `obicall replay` says of each recording what the committed oracle says it said', (t) => {
  const exe = process.env.OBICALL_EXE ?? path.resolve(ROOT, '..', 'obicall-reference', 'stage-anytune', 'bin', os.platform() === 'win32' ? 'obicall.exe' : 'obicall');
  if (!fs.existsSync(exe)) {
    t.skip(`the staged Obicall build is not at ${exe} (set OBICALL_EXE): the committed oracle stands`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-obr-'));
  try {
    for (const variant of tornVariants(DEMO)) {
      const file = path.join(dir, `${variant.name}.obr`);
      fs.writeFileSync(file, variant.bytes);
      const result = spawnSync(exe, ['replay', '--input', file, '--json'], { encoding: 'utf8' });
      assert.equal(result.status, 0, `obicall replay on ${variant.name}: ${result.stderr}`);
      const run = JSON.parse(result.stdout);
      const stoppedAt = /status=([^)]+)\)/.exec(result.stderr)?.[1] ?? null;
      const expected = ORACLE.variants[variant.name];
      assert.deepEqual({ recordsTotal: run.records_total, admitted: run.admitted, finalWindowSeq: run.final_window_seq, stoppedAt }, { recordsTotal: expected.recordsTotal, admitted: expected.admitted, finalWindowSeq: expected.finalWindowSeq, stoppedAt: expected.stoppedAt }, variant.name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
