/**
 * Owned media fixtures, made here and never downloaded: a score (a MIDI fixture) rendered as plucked strings (src/synthesis/pluck.ts), written as a WAV, and
 * encoded by FFmpeg into a real MP4 (AAC audio, an MPEG-4 Part 2 video track of a still frame) — what a learner's own `furelise.mp4` would be to the import,
 * with a known score to measure the transcription against. Generated when needed, into a directory the caller gives; not committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readMidiFile } from '../../src/music/midi-file.ts';
import { timelineOf } from '../../src/music/timeline.ts';
import { renderNotes, seeded, type RenderedNote } from '../../src/synthesis/pluck.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FUR_ELISE_MIDI = path.join(ROOT, 'tests', 'fixtures', 'midi', 'fur-elise-opening.mid');

/** 16-bit PCM WAV of mono samples in −1…1. */
export function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(s * 32767))), true));
  return out;
}

/** The notes of a MIDI file, track by track (all tracks when none is named), as the synthesiser renders them, shifted by `leadIn` seconds. */
export function notesOfMidi(file: string, tracks: readonly number[] | null = null, leadIn = 0.25): RenderedNote[] {
  const read = readMidiFile(new Uint8Array(fs.readFileSync(file)));
  if (!read.ok) throw new Error(read.reason);
  const t = timelineOf(read.file);
  if (!t.ok) throw new Error(t.reason);
  return t.timeline.notes
    .filter((n) => tracks === null || tracks.includes(n.track))
    .map((n) => ({ key: n.key, onsetSeconds: n.onSeconds + leadIn, durationSeconds: Math.max(0.05, n.sustainedOffSeconds - n.onSeconds), velocity: n.velocity }));
}

export function addNoise(samples: Float32Array, snrDb: number, seed: number): Float32Array {
  const r = seeded(seed);
  let power = 0;
  for (const s of samples) power += s * s;
  power /= samples.length;
  const amplitude = Math.sqrt(power / 10 ** (snrDb / 10)) * Math.sqrt(3);
  return samples.map((s) => s + amplitude * (r() * 2 - 1));
}

/** Render notes to `<dir>/<name>.wav`, then encode `<dir>/<name>.mp4` with FFmpeg (AAC 160 kb/s, a 320×240 still video). Returns the MP4's path. */
export function makeMp4(ffmpeg: string, notes: readonly RenderedNote[], dir: string, name: string, options: { readonly snrDb?: number } = {}): string {
  const sampleRate = 48000;
  let samples = renderNotes(notes, sampleRate);
  if (options.snrDb !== undefined) samples = addNoise(samples, options.snrDb, 77);
  const wav = path.join(dir, `${name}.wav`);
  fs.writeFileSync(wav, wavBytes(samples, sampleRate));
  const mp4 = path.join(dir, `${name}.mp4`);
  const seconds = (samples.length / sampleRate).toFixed(3);
  const r = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x202830:s=320x240:r=10:d=${seconds}`, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '160k', '-shortest', mp4], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`FFmpeg could not encode ${mp4}: ${r.stderr}`);
  return mp4;
}
