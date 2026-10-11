/**
 * The transcription engine: Spotify's Basic Pitch (@spotify/basic-pitch 1.0.1, Apache-2.0 — R. M. Bittner et al., "A Lightweight Instrument-Agnostic Model
 * for Polyphonic Note Transcription and Multipitch Estimation", ICASSP 2022), run in Node on TensorFlow.js's CPU backend. Its model ships in the package and
 * is loaded from there, in memory: nothing is fetched. It estimates notes — key, onset, duration and a strength — from mono audio at 22 050 Hz; AnyTune's
 * clean-up of its octave ghosts and the scores of what it got right are AnyTune's (src/import/transcription.ts).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { EngineNote } from '../../../src/import/transcription.ts';
import type { TranscriptionEngine } from '../../../src/music/reference.ts';

const require = createRequire(import.meta.url);

export const ENGINE_SAMPLE_RATE = 22050;

/** Basic Pitch's own defaults for its note post-processing (outputToNotesPoly), recorded with every transcription. */
export const PARAMETERS = Object.freeze({ onsetThreshold: 0.5, frameThreshold: 0.3, minNoteLengthFrames: 5, inferOnsets: true, melodiaTrick: true, energyTolerance: 11 });

interface BasicPitchModule {
  BasicPitch: new (model: Promise<unknown>) => { evaluateModel(audio: Float32Array, onComplete: (frames: number[][], onsets: number[][], contours: number[][]) => void, onProgress: (p: number) => void): Promise<void> };
  outputToNotesPoly(frames: number[][], onsets: number[][], onsetThresh: number, frameThresh: number, minNoteLen: number, inferOnsets: boolean, maxFreq: number | null, minFreq: number | null, melodiaTrick: boolean, energyTolerance: number): unknown[];
  addPitchBendsToNoteEvents(contours: number[][], notes: unknown[]): unknown[];
  noteFramesToTime(notes: unknown[]): { pitchMidi: number; startTimeSeconds: number; durationSeconds: number; amplitude: number }[];
}

let loaded: { bp: BasicPitchModule; engine: InstanceType<BasicPitchModule['BasicPitch']> } | null = null;

function load(): NonNullable<typeof loaded> {
  if (loaded !== null) return loaded;
  const tf = require('@tensorflow/tfjs') as { loadGraphModel(io: unknown): Promise<unknown>; io: { fromMemory(artifacts: unknown): unknown }; setBackend(name: string): Promise<boolean> };
  const bp = require('@spotify/basic-pitch') as BasicPitchModule;
  const dir = path.join(path.dirname(require.resolve('@spotify/basic-pitch/package.json')), 'model');
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')) as { modelTopology: unknown; weightsManifest: { paths: string[]; weights: unknown[] }[]; format?: string; generatedBy?: string; convertedBy?: string };
  const manifest = json.weightsManifest[0] as { paths: string[]; weights: unknown[] };
  const weights = Buffer.concat(manifest.paths.map((p) => fs.readFileSync(path.join(dir, p))));
  const model = tf.loadGraphModel(tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs: manifest.weights, weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength), format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy }));
  loaded = { bp, engine: new bp.BasicPitch(model) };
  return loaded;
}

export function engineInfo(): TranscriptionEngine {
  const version = (JSON.parse(fs.readFileSync(require.resolve('@spotify/basic-pitch/package.json'), 'utf8')) as { version: string }).version;
  const tfVersion = (JSON.parse(fs.readFileSync(require.resolve('@tensorflow/tfjs/package.json'), 'utf8')) as { version: string }).version;
  return { name: '@spotify/basic-pitch', version, parameters: { ...PARAMETERS, sampleRate: ENGINE_SAMPLE_RATE, runtime: `@tensorflow/tfjs ${tfVersion} (cpu)` } };
}

/** Notes estimated from mono audio at 22 050 Hz. `onProgress` is given 0…1. */
export async function transcribe(audio: Float32Array, onProgress: (fraction: number) => void = () => {}): Promise<EngineNote[]> {
  const { bp, engine } = load();
  // TensorFlow.js prints a one-time hint about its Node backend to the console; it is not AnyTune's to show
  const log = console.log;
  console.log = (...args: unknown[]): void => {
    const line = String(args[0] ?? '');
    if (!line.includes('TensorFlow.js') && !line.includes('tfjs-node') && !/^=+$/.test(line.trim())) log(...args);
  };
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  try {
    await engine.evaluateModel(audio, (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    }, onProgress);
  } finally {
    console.log = log;
  }
  const p = PARAMETERS;
  const notes = bp.noteFramesToTime(bp.addPitchBendsToNoteEvents(contours, bp.outputToNotesPoly(frames, onsets, p.onsetThreshold, p.frameThreshold, p.minNoteLengthFrames, p.inferOnsets, null, null, p.melodiaTrick, p.energyTolerance)));
  return notes.map((n) => ({ key: n.pitchMidi, onsetSeconds: n.startTimeSeconds, durationSeconds: n.durationSeconds, strength: n.amplitude })).sort((a, b) => a.onsetSeconds - b.onsetSeconds || a.key - b.key);
}
