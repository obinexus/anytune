/**
 * The external tools the worker needs, found explicitly and reported with their versions: yt-dlp (downloads permitted media — it does not transcribe), FFmpeg
 * and ffprobe (decode and inspect audio — they do not transcribe either). Each is taken from its environment variable when set (ANYTUNE_YTDLP,
 * ANYTUNE_FFMPEG, ANYTUNE_FFPROBE), else looked for on PATH — by scanning PATH's directories, never through a shell. A missing tool is reported as missing,
 * with what it is needed for; nothing is downloaded or installed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runTool } from './process.ts';

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe';

export type Tool = { readonly name: ToolName; readonly found: true; readonly path: string; readonly version: string } | { readonly name: ToolName; readonly found: false; readonly reason: string; readonly neededFor: string };

const ENV: Readonly<Record<ToolName, string>> = { 'yt-dlp': 'ANYTUNE_YTDLP', ffmpeg: 'ANYTUNE_FFMPEG', ffprobe: 'ANYTUNE_FFPROBE' };
const NEEDED: Readonly<Record<ToolName, string>> = { 'yt-dlp': 'importing from a URL', ffmpeg: 'decoding any media file to audio', ffprobe: 'inspecting a media file before decoding it' };
const VERSION_ARGS: Readonly<Record<ToolName, readonly string[]>> = { 'yt-dlp': ['--version'], ffmpeg: ['-hide_banner', '-version'], ffprobe: ['-hide_banner', '-version'] };

function onPath(name: string): string | null {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';').filter((e) => e !== '') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

export async function findTool(name: ToolName): Promise<Tool> {
  const explicit = process.env[ENV[name]];
  const located = explicit !== undefined && explicit !== '' ? explicit : onPath(name);
  if (located === null) return { name, found: false, reason: `${name} is not on PATH and ${ENV[name]} is not set`, neededFor: NEEDED[name] };
  if (!fs.existsSync(located)) return { name, found: false, reason: `${ENV[name]} names ${located}, which does not exist`, neededFor: NEEDED[name] };
  const probe = await runTool(located, VERSION_ARGS[name], { timeoutMs: 20000 });
  if (probe.status !== 'ok') return { name, found: false, reason: `${located} did not run: ${probe.message}`, neededFor: NEEDED[name] };
  return { name, found: true, path: located, version: probe.stdout.toString('utf8').trim().split('\n')[0]?.trim() ?? '' };
}

export async function findTools(): Promise<Readonly<Record<ToolName, Tool>>> {
  const [ytDlp, ffmpeg, ffprobe] = await Promise.all([findTool('yt-dlp'), findTool('ffmpeg'), findTool('ffprobe')]);
  return { 'yt-dlp': ytDlp, ffmpeg, ffprobe };
}
