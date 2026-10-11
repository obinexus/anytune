/**
 * What a pasted URL may be, before anything is downloaded. AnyTune acquires media only from providers it names, over HTTPS, one video at a time unless the
 * learner deliberately asks for a playlist; it never follows a URL to a private network, and never carries credentials or a non-default port. It adds no way
 * around a provider's access controls or DRM: what yt-dlp cannot fetch plainly is not fetched. The learner declares that they may use what they import; the
 * declaration is kept with the import.
 *
 * Pure: the address check (isPrivateAddress) is given the addresses a name resolves to; resolving them is the worker's (services/import-worker).
 */

export type ImportMode = 'single' | 'playlist';

export type UrlDecision =
  | {
      readonly ok: true;
      readonly kind: 'video';
      readonly provider: 'youtube';
      readonly videoId: string;
      /** the canonical URL that is handed to yt-dlp: nothing of the pasted URL but the video's id */
      readonly url: string;
      readonly host: string;
      /** what of the pasted URL was left out, said */
      readonly ignored: readonly string[];
    }
  | { readonly ok: true; readonly kind: 'playlist'; readonly provider: 'youtube'; readonly playlistId: string; readonly url: string; readonly host: string; readonly ignored: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export const ALLOWED_HOSTS: readonly string[] = Object.freeze(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

export function decideUrl(input: string, mode: ImportMode = 'single'): UrlDecision {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'this is not a URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: `only https URLs are imported, not ${url.protocol.replace(':', '')}` };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'a URL with a user name or password in it is not imported' };
  if (url.port !== '') return { ok: false, reason: 'a URL with an explicit port is not imported' };
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) return { ok: false, reason: `${host} is not a supported provider (supported: YouTube and YouTube Music)` };
  const list = url.searchParams.get('list');
  if (mode === 'playlist') {
    if (list === null || !PLAYLIST_ID.test(list)) return { ok: false, reason: 'importing a playlist needs a URL with its list= id' };
    const ignored = [...url.searchParams.keys()].filter((k) => k !== 'list').map((k) => `the ${k} parameter`);
    return { ok: true, kind: 'playlist', provider: 'youtube', playlistId: list, url: `https://www.youtube.com/playlist?list=${list}`, host, ignored };
  }
  let videoId: string | null = null;
  if (host === 'youtu.be') videoId = url.pathname.slice(1).split('/')[0] ?? null;
  else if (url.pathname === '/watch') videoId = url.searchParams.get('v');
  else if (/^\/(shorts|live|embed)\/[^/]+$/.test(url.pathname)) videoId = url.pathname.split('/')[2] ?? null;
  if (videoId === null || !VIDEO_ID.test(videoId)) {
    return list !== null
      ? { ok: false, reason: 'this URL names a playlist and no single video: import it with the playlist action, deliberately' }
      : { ok: false, reason: 'no video id was found in this URL' };
  }
  const ignored: string[] = [];
  if (list !== null) ignored.push('the playlist (list=): only this one video is imported; importing the playlist is a separate, deliberate action');
  for (const key of url.searchParams.keys()) if (key !== 'v' && key !== 'list') ignored.push(`the ${key} parameter`);
  return { ok: true, kind: 'video', provider: 'youtube', videoId, url: `https://www.youtube.com/watch?v=${videoId}`, host, ignored };
}

const ipv4 = (address: string): number[] | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
};

/** Whether an address (v4 or v6) is one a server-side import must never reach: loopback, private, link-local, shared, multicast, reserved, unspecified. */
export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (!v6.includes(':')) return true; // neither: refuse
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1] as string);
  if (v6 === '::' || v6 === '::1') return true;
  const first = parseInt(v6.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || v6.startsWith('2001:db8:') || v6.startsWith('64:ff9b:');
}

export interface DownloadLimits {
  /** the longest media accepted, in seconds */
  readonly maxDurationSeconds: number;
  /** the largest file accepted, in megabytes */
  readonly maxMegabytes: number;
  /** for a playlist: at most this many items */
  readonly maxPlaylistItems: number;
  readonly socketTimeoutSeconds: number;
}

export const DEFAULT_LIMITS: DownloadLimits = Object.freeze({ maxDurationSeconds: 20 * 60, maxMegabytes: 200, maxPlaylistItems: 25, socketTimeoutSeconds: 20 });

/**
 * yt-dlp's arguments, as an array (never a shell string): no user configuration (--ignore-config), the best audio as the provider serves it (decoding is
 * FFmpeg's, after), the limits enforced by yt-dlp itself (duration, size, no live streams), a fixed output name inside the job's own directory, the metadata
 * written beside it, and the final path printed — nothing else.
 */
export function ytDlpArguments(decision: Extract<UrlDecision, { ok: true }>, directory: string, limits: DownloadLimits = DEFAULT_LIMITS): string[] {
  const args = [
    '--ignore-config',
    '--no-cookies-from-browser',
    decision.kind === 'video' ? '--no-playlist' : '--yes-playlist',
    ...(decision.kind === 'playlist' ? ['--playlist-end', String(limits.maxPlaylistItems)] : []),
    '--format', 'bestaudio[ext=m4a]/bestaudio/best',
    '--max-filesize', `${limits.maxMegabytes}M`,
    '--match-filters', `duration <= ${limits.maxDurationSeconds} & !is_live`,
    '--socket-timeout', String(limits.socketTimeoutSeconds),
    '--retries', '3',
    '--no-mtime',
    '--restrict-filenames',
    '--write-info-json',
    '--paths', directory,
    '--output', decision.kind === 'video' ? 'source.%(ext)s' : '%(playlist_index)03d-%(id)s.%(ext)s',
    '--print', 'after_move:filepath',
    '--no-simulate',
    '--',
    decision.url,
  ];
  return args;
}

/** FFmpeg's arguments to decode a file's first audio stream to mono 32-bit float PCM at `sampleRate`, on stdout, at most `maxSeconds` of it. */
export function ffmpegDecodeArguments(file: string, sampleRate: number, maxSeconds: number): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(sampleRate), '-t', String(maxSeconds), '-f', 'f32le', 'pipe:1'];
}

export function ffprobeArguments(file: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
}
