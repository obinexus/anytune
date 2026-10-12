/**
 * Media through FFmpeg: inspect a file (ffprobe — its duration and whether it has audio at all), then decode its first audio stream to mono 32-bit float PCM
 * at the transcription engine's sample rate. Decoding is not transcription: this gives sound, as samples; the engine estimates notes from them.
 */
import { ffmpegDecodeArguments, ffprobeArguments } from '../../../src/import/url-policy.ts';
import { runTool } from './process.ts';

export interface MediaInfo {
  readonly durationSeconds: number;
  readonly formatName: string;
  readonly audioStreams: number;
  readonly videoStreams: number;
  readonly audioCodec: string | null;
}

export type MediaResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean };

export async function probe(ffprobe: string, file: string, signal?: AbortSignal): Promise<MediaResult<MediaInfo>> {
  const r = await runTool(ffprobe, ffprobeArguments(file), { timeoutMs: 30000, ...(signal === undefined ? {} : { signal }), maxStdoutBytes: 4 * 1024 * 1024 });
  if (r.status === 'cancelled') return { ok: false, code: 'cancelled', message: 'cancelled', retryable: true };
  if (r.status !== 'ok') return { ok: false, code: 'media.unreadable', message: `ffprobe could not read the file: ${r.message}`, retryable: false };
  const info = JSON.parse(r.stdout.toString('utf8')) as { format?: { duration?: string; format_name?: string }; streams?: { codec_type?: string; codec_name?: string }[] };
  const streams = info.streams ?? [];
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration ?? NaN);
  if (audio.length === 0) return { ok: false, code: 'media.no-audio', message: 'the file has no audio stream to learn from', retryable: false };
  return { ok: true, value: { durationSeconds: duration, formatName: info.format?.format_name ?? 'unknown', audioStreams: audio.length, videoStreams: streams.filter((s) => s.codec_type === 'video').length, audioCodec: audio[0]?.codec_name ?? null } };
}

export async function decode(ffmpeg: string, file: string, sampleRate: number, maxSeconds: number, signal?: AbortSignal): Promise<MediaResult<Float32Array>> {
  const maxBytes = Math.ceil(maxSeconds * sampleRate * 4) + 4096;
  const r = await runTool(ffmpeg, ffmpegDecodeArguments(file, sampleRate, maxSeconds), { timeoutMs: Math.max(60000, maxSeconds * 1000), ...(signal === undefined ? {} : { signal }), maxStdoutBytes: maxBytes });
  if (r.status === 'cancelled') return { ok: false, code: 'cancelled', message: 'cancelled', retryable: true };
  if (r.status === 'timeout') return { ok: false, code: 'decode.timeout', message: r.message, retryable: true };
  if (r.status !== 'ok') return { ok: false, code: 'decode.failed', message: `FFmpeg could not decode the audio: ${r.message}`, retryable: false };
  const bytes = r.stdout;
  const samples = new Float32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
  if (samples.length === 0) return { ok: false, code: 'decode.empty', message: 'FFmpeg decoded no samples', retryable: false };
  return { ok: true, value: samples };
}
