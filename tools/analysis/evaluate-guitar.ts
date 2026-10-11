/**
 * Evaluates AnyTune's guitar analysis on SYNTHETIC signals and writes docs/evaluation/guitar-synthetic.{json,md}. Everything here is Karplus–Strong plucked
 * strings (src/synthesis/pluck.ts) with seeded strum spreads, velocities, detuning and white noise — not recordings of a guitar. It says what the analysis does
 * on idealised strings; what it does on a real guitar, in a real room, through a phone's microphone, is a separate measurement that has not been made.
 *
 * The seeds here (1000 and up) are HELD OUT: the open-set thresholds (src/analysis/chords.ts FIT_THRESHOLDS) were calibrated on seeds 1–15.
 *
 *   node tools/analysis/evaluate-guitar.ts [--quick]
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CHORD_FRAME_SIZE, FIT_THRESHOLDS, createChordAnalyser, type ChordReading } from '../../src/analysis/chords.ts';
import { trackNotes } from '../../src/analysis/notes.ts';
import { detectOnsets } from '../../src/analysis/onsets.ts';
import { MVP_CHORDS } from '../../src/music/chords.ts';
import { OPEN_VOICINGS, soundingKeys } from '../../src/music/guitar.ts';
import { referenceFromMidi } from '../../src/music/reference.ts';
import { mixInto, pluck, renderNotes, seeded } from '../../src/synthesis/pluck.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SR = 48000;
export const MIN_CONFIDENCE = 0.6;

/** A strum of `keys`: strings struck in turn (down or up, 8–23 ms apart), each at its own velocity and brightness, detuned ±8 cents, in white noise. */
export function strum(keys: readonly number[], seed: number, snrDb: number | null, seconds = 1.2): Float32Array {
  const r = seeded(seed);
  const out = new Float32Array(Math.round(SR * seconds));
  const order = r() < 0.5 ? keys : [...keys].reverse();
  order.forEach((k, i) => mixInto(out, pluck(440 * 2 ** ((k - 69 + (r() - 0.5) * 0.16) / 12), { sampleRate: SR, duration: seconds - 0.15, velocity: 0.5 + 0.4 * r(), seed: seed * 10 + i, brightness: 0.5 + 0.4 * r() }), 0.1 + i * (0.008 + 0.015 * r()), SR, 0.3));
  if (snrDb !== null) addNoise(out, snrDb, r);
  return out;
}

function addNoise(out: Float32Array, snrDb: number, r: () => number): void {
  let power = 0;
  for (const v of out) power += v * v;
  power /= out.length;
  const amplitude = Math.sqrt(power / 10 ** (snrDb / 10)) * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + amplitude * (r() * 2 - 1);
}

/** What practice does: find the strum's onset, then read the chord from the frame 20 ms after it. */
export function readStrum(signal: Float32Array, analyser = createChordAnalyser()): ChordReading | null {
  const onset = detectOnsets(signal, SR)[0]?.time ?? 0.1;
  const start = Math.round((onset + 0.02) * SR);
  return analyser.read(signal.subarray(start, start + CHORD_FRAME_SIZE), SR);
}

export const verdictOf = (reading: ChordReading | null): string => (reading === null || reading.confidence < MIN_CONFIDENCE ? 'uncertain' : (reading.candidates[0]?.symbol ?? 'uncertain'));

export const REFUSALS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  'single note E4': [64],
  'single note A2': [45],
  'single note G3': [55],
  'power chord E5': [40, 47, 52],
  'power chord A5': [45, 52, 57],
  'F major (barre)': [41, 48, 53, 57, 60, 65],
  'B minor x24432': [47, 54, 59, 62, 66],
  'C7 x32310': [48, 52, 58, 60, 64],
  'Fmaj7 xx3210': [53, 57, 60, 64],
  'Asus2 x02200': [45, 52, 57, 59, 64],
  'Dsus4 xx0233': [50, 57, 62, 67],
});

function main(quick: boolean): void {
  const perChord = quick ? 6 : 25;
  const analyser = createChordAnalyser();
  const report: Record<string, unknown> = { generatedBy: 'tools/analysis/evaluate-guitar.ts', signals: 'synthetic Karplus–Strong strums — not recordings', sampleRate: SR, minConfidence: MIN_CONFIDENCE, fitThresholds: FIT_THRESHOLDS, strumsPerChord: perChord };

  // 1. the vocabulary: a confusion matrix per noise level
  const matrices: Record<string, Record<string, Record<string, number>>> = {};
  for (const snr of [30, 20, 10]) {
    const m: Record<string, Record<string, number>> = {};
    for (const chord of MVP_CHORDS) {
      const row: Record<string, number> = Object.fromEntries([...MVP_CHORDS, 'uncertain'].map((c) => [c, 0]));
      for (let s = 0; s < perChord; s++) {
        const v = verdictOf(readStrum(strum(soundingKeys(OPEN_VOICINGS[chord] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 1000 + s * 37 + chord.length * 7, snr), analyser));
        row[v] = (row[v] ?? 0) + 1;
      }
      m[chord] = row;
    }
    matrices[`${snr} dB`] = m;
  }
  report['chords'] = matrices;

  // 2. what is not in the vocabulary, or not a chord: it should be "uncertain"
  const refusals: Record<string, Record<string, number>> = {};
  for (const [name, keys] of Object.entries(REFUSALS)) {
    const said: Record<string, number> = {};
    for (let s = 0; s < (quick ? 3 : 10); s++) {
      const v = verdictOf(readStrum(strum(keys, 2000 + s * 13, 20), analyser));
      said[v] = (said[v] ?? 0) + 1;
    }
    refusals[name] = said;
  }
  const noise: Record<string, number> = {};
  for (let s = 0; s < (quick ? 3 : 10); s++) {
    const r = seeded(3000 + s);
    const signal = new Float32Array(SR);
    for (let i = 0; i < signal.length; i++) signal[i] = 0.1 * (r() * 2 - 1);
    const v = verdictOf(analyser.read(signal.subarray(4800, 4800 + CHORD_FRAME_SIZE), SR));
    noise[v] = (noise[v] ?? 0) + 1;
  }
  refusals['white noise'] = noise;
  refusals['silence'] = { [verdictOf(analyser.read(new Float32Array(CHORD_FRAME_SIZE), SR))]: 1 };
  report['refusals'] = refusals;

  // 3. speaker bleed: the reference's correct chord leaking into the microphone while the learner plays a wrong one
  const bleed: Record<string, Record<string, number>> = {};
  for (const db of [-20, -12, -6]) {
    const said: Record<string, number> = {};
    for (let s = 0; s < (quick ? 4 : 12); s++) {
      const learner = strum(soundingKeys(OPEN_VOICINGS['Em'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 4000 + s, 30);
      const reference = strum(soundingKeys(OPEN_VOICINGS['C'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 5000 + s, null);
      mixInto(learner, reference, 0, SR, 10 ** (db / 20));
      const v = verdictOf(readStrum(learner, analyser));
      said[v] = (said[v] ?? 0) + 1;
    }
    bleed[`learner Em, reference C at ${db} dB`] = said;
  }
  report['speakerBleed'] = bleed;

  // 4. single notes: Für Elise's melody an octave down (the guitar arrangement), plucked at ♩ = 72 then 60, read back
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid')));
  const made = referenceFromMidi(bytes, { song: { id: 'fe', title: 'Für Elise', composer: null }, arrangement: { id: 'fe', version: 1, instrument: 'acoustic-guitar', part: 'melody' }, provenance: { kind: 'midi-import', midi: { role: 'midi', fileName: 'f.mid', mediaType: 'audio/midi', sha256: 'f', bytes: 1 } } });
  if (!made.ok) throw new Error(made.reason);
  const melody = made.reference.notes.filter((n) => n.track === 1).map((n) => ({ key: n.key - 12, onsetSeconds: n.onsetSeconds + 0.2, durationSeconds: n.releaseSeconds - n.onsetSeconds, velocity: 80 }));
  const notesReport: Record<string, unknown> = {};
  for (const snr of [null, 20]) {
    const signal = renderNotes(melody, SR);
    if (snr !== null) addNoise(signal, snr, seeded(6000));
    const heard = trackNotes(signal, SR);
    const used = new Set<number>();
    const errors: number[] = [];
    let hits = 0;
    for (const target of melody) {
      const match = heard.findIndex((h, i) => !used.has(i) && h.key === target.key && Math.abs(h.time - target.onsetSeconds) <= 0.05);
      if (match >= 0) {
        used.add(match);
        hits++;
        errors.push(Math.abs((heard[match] as { time: number }).time - target.onsetSeconds) * 1000);
      }
    }
    errors.sort((a, b) => a - b);
    notesReport[snr === null ? 'clean' : `${snr} dB`] = {
      targets: melody.length,
      heard: heard.length,
      recall: hits / melody.length,
      precision: heard.length === 0 ? 0 : hits / heard.length,
      onsetErrorMs: { median: errors[Math.floor(errors.length / 2)] ?? null, p95: errors[Math.floor(errors.length * 0.95)] ?? null, max: errors[errors.length - 1] ?? null },
    };
  }
  report['melody'] = notesReport;

  // 5. compute time per analysis frame on this machine (Node): not a device latency
  const frame = strum(soundingKeys(OPEN_VOICINGS['G'] as NonNullable<(typeof OPEN_VOICINGS)[string]>), 7000, 20).subarray(9600, 9600 + CHORD_FRAME_SIZE);
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) analyser.read(frame, SR);
  report['computeMsPerChordFrame'] = Math.round(((performance.now() - t0) / 50) * 100) / 100;

  const dir = path.join(ROOT, 'docs', 'evaluation');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'guitar-synthetic.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'guitar-synthetic.md'), markdown(report, matrices, refusals, bleed, notesReport));
  console.log(`docs/evaluation/guitar-synthetic.{json,md} written (${perChord} strums per chord per noise level)`);
}

function markdown(report: Record<string, unknown>, matrices: Record<string, Record<string, Record<string, number>>>, refusals: Record<string, Record<string, number>>, bleed: Record<string, Record<string, number>>, notes: Record<string, unknown>): string {
  const columns = [...MVP_CHORDS, 'uncertain'];
  const lines: string[] = [
    '# Guitar analysis on synthetic signals',
    '',
    '> **These signals are synthetic.** They are Karplus–Strong plucked strings, with seeded strum spreads, velocities, ±8-cent detuning and white noise. They are **not recordings of a guitar**. The numbers say what the analysis does on idealised strings. **Nothing here is a claim about a real guitar, a real room or a phone microphone**: that measurement has not been made, and it needs recordings of the acoustic guitar under declared conditions.',
    '',
    'This file is generated by `node tools/analysis/evaluate-guitar.ts`. Don\'t edit it by hand.',
    '',
    'How the run was set up:',
    '',
    `- **Seeds:** held out (1000 and up). The open-set thresholds (coverage ≥ ${FIT_THRESHOLDS.minCoverage}, outside ≤ ${FIT_THRESHOLDS.maxOutside}) were calibrated on seeds 1–15.`,
    `- **Verdict:** a reading counts when its confidence is ≥ ${MIN_CONFIDENCE}. Below that it is **uncertain**, which is never counted as right or wrong.`,
    `- **Sample:** ${String(report['strumsPerChord'])} strums per chord per noise level, at ${SR} Hz.`,
    '- **Frame:** the chord frame is read 20 ms after the detected onset.',
    '',
    '## The vocabulary: confusion matrices',
    '',
  ];
  for (const [level, m] of Object.entries(matrices)) {
    lines.push(`### White noise at ${level} SNR`, '', `| played ↓ / read → | ${columns.join(' | ')} | right |`, `|---|${columns.map(() => '---:').join('|')}|---:|`);
    for (const chord of MVP_CHORDS) {
      const row = m[chord] as Record<string, number>;
      const total = columns.reduce((s, c) => s + (row[c] ?? 0), 0);
      lines.push(`| **${chord}** | ${columns.map((c) => (c === chord ? `**${row[c] ?? 0}**` : String(row[c] ?? 0))).join(' | ')} | ${Math.round((100 * (row[chord] ?? 0)) / total)} % |`);
    }
    lines.push('');
  }
  lines.push('## What should be refused (strummed at 20 dB SNR)', '', 'Each of these should come out **uncertain**: none is a chord of the vocabulary.', '', '| sound | what was said |', '|---|---|');
  for (const [name, said] of Object.entries(refusals)) lines.push(`| ${name} | ${Object.entries(said).map(([k, v]) => `${k} × ${v}`).join(', ')} |`);
  lines.push('', '## Speaker bleed', '', 'The reference\'s correct chord (C) leaks into the microphone while the learner plays a wrong one (Em). The question is whether the leak can make the wrong chord read as **right**, crediting the learner with the playback. This measures one pair of chords at three levels, on synthetic strings. It doesn\'t show that bleed is harmless in a room, and AnyTune still asks for headphones during microphone practice.', '', '| case | what was said |', '|---|---|');
  for (const [name, said] of Object.entries(bleed)) lines.push(`| ${name} | ${Object.entries(said).map(([k, v]) => `${k} × ${v}`).join(', ')} |`);
  lines.push('', '## Single notes: Für Elise\'s melody, an octave down', '', 'A note counts when its pitch is exact and its onset is within 50 ms.', '', '| condition | targets | heard | recall | precision | onset error median / p95 / max (ms) |', '|---|---:|---:|---:|---:|---|');
  for (const [name, r] of Object.entries(notes)) {
    const x = r as { targets: number; heard: number; recall: number; precision: number; onsetErrorMs: { median: number | null; p95: number | null; max: number | null } };
    const ms = (v: number | null): string => (v === null ? '–' : v.toFixed(1));
    lines.push(`| ${name} | ${x.targets} | ${x.heard} | ${(100 * x.recall).toFixed(1)} % | ${(100 * x.precision).toFixed(1)} % | ${ms(x.onsetErrorMs.median)} / ${ms(x.onsetErrorMs.p95)} / ${ms(x.onsetErrorMs.max)} |`);
  }
  lines.push('', `Compute time per chord frame (${CHORD_FRAME_SIZE} samples), in Node on the development machine: **${String(report['computeMsPerChordFrame'])} ms**. This is not a device latency. Capture-to-feedback latency on a phone has to be measured on the phone.`, '');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main(process.argv.includes('--quick'));
