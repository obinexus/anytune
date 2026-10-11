/**
 * The conformance of AnyTune's own reader and writer of the `.obr` journal format (src/adapters/obr-journal.ts) — no Obicall code is loaded or run. The
 * evidence is the format's own demonstration journal (tests/fixtures/obr/demo.obr, copied unchanged, its SHA-256 pinned to the manifest it was published
 * with) and the answers the format's reference implementation gave, once, about it and about every torn variant of it (tests/fixtures/obr/replay-oracle.json,
 * frozen: the tool that asked was removed with Obicall, and the file is never edited). What demo.obr holds is 2-D positions in metres, read as what they
 * are — never as a pitch or a note.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JORB_MAGIC, OBR_SHAPES, OBR_UNITS, ObrJournalReader, RECORD_HEADER_LEN, crc32, describeForPractice, encodeObservation, encodeRecord, readObrJournal, writeObrJournal } from '../../src/adapters/obr-journal.ts';
import { DEMO_RECORD_LEN, tornVariants } from '../../tools/obr/torn-variants.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEMO = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'obr', 'demo.obr')));
const ORACLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'obr', 'replay-oracle.json'), 'utf8'));
/** the SHA-256 the demonstration journal was published with (its artifact manifest: share/obicall/recordings/demo.obr) */
const DEMO_SHA256 = '3838115346787cfacb55674dd738b5437ec01858a6fd28651ccad417786c79b4';

test('the fixture is the format’s own demonstration journal: 19 992 bytes, the SHA-256 it was published with', () => {
  assert.equal(DEMO.length, 19992);
  assert.equal(crypto.createHash('sha256').update(DEMO).digest('hex'), DEMO_SHA256);
  assert.equal(ORACLE.demoSha256, DEMO_SHA256, 'the oracle was asked about this very file');
});

test('the CRC is the specification’s, CRC-32/ISO-HDLC — the check value of "123456789" is cbf43926, and the empty input is 0', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('demo.obr is 102 records of 196 bytes: each a JORB header of 40 little-endian bytes whose lengths and CRC hold, then the observation it seals', () => {
  const { records, stop } = readObrJournal(DEMO);
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
  const { records } = readObrJournal(DEMO);
  assert.deepEqual(records.map((r) => r.header.windowSeq), records.map((_, i) => BigInt(i + 1)));
  assert.ok(records.every((r) => r.header.admissionReason === 0));
  for (let i = 1; i < records.length; i++) assert.ok((records[i]?.header.admittedAtNs as bigint) >= (records[i - 1]?.header.admittedAtNs as bigint));
});

test('the observations decode from the format’s encoding: two sensors, each restarted once, their sequences rising within a boot — 2-D positions in METRES with a 2×2 covariance, never a pitch', () => {
  const { records } = readObrJournal(DEMO);
  for (const { observation } of records) {
    assert.equal(OBR_SHAPES[observation.payloadShape], 'position-2d');
    assert.equal(OBR_UNITS[observation.units], 'meters');
    assert.equal(observation.payload.length, 2);
    assert.equal(observation.covariance.length, 4);
    assert.ok(observation.payload.every(Number.isFinite) && observation.covariance.every(Number.isFinite));
    assert.ok(observation.sampleTimeNs <= observation.arrivalTimeNs);
  }
  // a boot id is a source's restart, and its sequence numbering restarts with it (the specification's journal.h): per sensor and boot, 1 … n, rising
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
  // the format's units are metres, metres per second and radians: there is no unit a frequency or a note could be read in
  assert.deepEqual(Object.values(OBR_UNITS), ['unspecified', 'meters', 'meters-per-second', 'radians']);
});

test('read one record at a time, as the specification reads them: a record, then the clean end — and the end again, however often it is asked', () => {
  const reader = new ObrJournalReader(DEMO);
  let count = 0;
  for (let step = reader.next(); step.kind === 'record'; step = reader.next()) count++;
  assert.equal(count, 102);
  assert.deepEqual(reader.next(), { kind: 'end', offset: DEMO.length });
  assert.equal(reader.offset, DEMO.length);
});

test('torn and malformed recordings: the reader stops at the first bad record — never skips past it — keeps what came before, and says what the reference implementation said', () => {
  for (const variant of tornVariants(DEMO)) {
    const expected = ORACLE.variants[variant.name];
    assert.ok(expected, `the oracle knows ${variant.name}`);
    const { records, stop } = readObrJournal(variant.bytes);
    const said = {
      recordsTotal: records.length,
      admitted: records.filter((r) => r.header.admissionReason === 0).length,
      finalWindowSeq: records.length === 0 ? 0 : Number(records[records.length - 1]?.header.windowSeq),
      stoppedAt: stop.kind === 'end' ? null : stop.status,
    };
    assert.deepEqual(said, { recordsTotal: expected.recordsTotal, admitted: expected.admitted, finalWindowSeq: expected.finalWindowSeq, stoppedAt: expected.stoppedAt }, `${variant.name}: ${variant.what}`);
    // the offset is left at the start of the bad record, as the specification leaves the file position — so a writer can truncate it
    if (stop.kind !== 'end') assert.equal(stop.offset, records.length * DEMO_RECORD_LEN, variant.name);
  }
  // each kind of stop is among them
  assert.deepEqual(new Set(Object.values(ORACLE.variants).map((v) => (v as { stoppedAt: string | null }).stoppedAt)), new Set([null, 'malformed wire frame', 'wire checksum mismatch', 'wire frame too large']));
});

test('written back by AnyTune’s own writer, demo.obr is the same 19 992 bytes: every header, CRC, field and NUL-padded sensor id', () => {
  const { records } = readObrJournal(DEMO);
  const written = writeObrJournal(records);
  assert.equal(written.length, DEMO.length);
  assert.deepEqual(written, DEMO);
  assert.equal(crypto.createHash('sha256').update(written).digest('hex'), DEMO_SHA256);
});

test('a record the writer makes is one the reader reads back exactly, and a change of one bit is caught by the CRC', () => {
  const observation = {
    structSize: 384,
    schemaVersion: 1,
    sensorId: 'range_a',
    sourceBootId: 0xfedcba9876543210n,
    sequence: 7n,
    sampleTimeNs: -5n,
    arrivalTimeNs: 1234567890123n,
    clockDomain: 1,
    timeUncertaintyS: 0.001,
    coordinateFrame: 2,
    units: 1,
    calibrationVersion: 3,
    payloadShape: 4,
    payload: [12.5],
    covariance: [0.25],
  };
  const bytes = encodeRecord({ windowSeq: 9n, admittedAtNs: 10n, admissionReason: 0 }, observation);
  const { records, stop } = readObrJournal(bytes);
  assert.deepEqual(stop, { kind: 'end', offset: bytes.length });
  assert.deepEqual(records[0]?.observation, observation);
  assert.deepEqual([records[0]?.header.windowSeq, records[0]?.header.admittedAtNs, records[0]?.header.admissionReason], [9n, 10n, 0]);
  const flipped = new Uint8Array(bytes);
  flipped[RECORD_HEADER_LEN + 60] = (flipped[RECORD_HEADER_LEN + 60] as number) ^ 1;
  const torn = readObrJournal(flipped);
  assert.equal(torn.records.length, 0);
  assert.equal(torn.stop.kind === 'stopped' ? torn.stop.status : null, 'wire checksum mismatch');
  assert.throws(() => encodeObservation({ ...observation, payload: [1, 2, 3, 4, 5, 6, 7] }), /at most 6 doubles/);
  assert.throws(() => encodeObservation({ ...observation, sensorId: 'x'.repeat(32) }), /at most 31 bytes/);
});

test('to a learner, an .obr is never a practice reference: it is described — sensors, units, records — and refused in words; nothing is changed', () => {
  const verdict = describeForPractice(DEMO);
  assert.equal(verdict.practicable, false);
  assert.equal(verdict.records, 102);
  assert.deepEqual(verdict.sensors, ['cam_position_a', 'imu_a']);
  assert.deepEqual(verdict.units, ['meters']);
  assert.equal(verdict.intact, true);
  assert.match(verdict.reason, /102 sensor observations \(meters\): positions and ranges, not notes/);
  const midi = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]);
  const notObr = describeForPractice(midi);
  assert.equal(notObr.records, 0);
  assert.match(notObr.reason, /not a readable \.obr journal/);
  assert.deepEqual(midi, Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]), 'the bytes it was given are untouched');
});
