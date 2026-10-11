/**
 * AnyTune's import worker, from the command line (a desktop companion — the phone does not run it):
 *
 *   node services/import-worker/src/cli.ts doctor
 *   node services/import-worker/src/cli.ts import --file furelise.mp4 [--instrument acoustic-guitar]
 *   node services/import-worker/src/cli.ts import --midi song.mid
 *   node services/import-worker/src/cli.ts import --url "https://youtu.be/…" --permission "I own this recording"
 *   node services/import-worker/src/cli.ts playlist --url "https://www.youtube.com/playlist?list=…" --permission "…"   (deliberate: one job per video)
 *   node services/import-worker/src/cli.ts review --job <id> --accept
 *   node services/import-worker/src/cli.ts status [--job <id>]
 *   node services/import-worker/src/cli.ts retry --job <id>
 *
 * --library DIR (or ANYTUNE_LIBRARY) is where jobs, references and recordings are kept (default: <repo>/library). Ctrl-C cancels a running job: it is saved
 * as cancelled. Exit codes: 0 done (or waiting for review), 1 failed, 2 usage, 3 cancelled.
 */
import path from 'node:path';
import { retry as retryJob } from '../../../src/import/job.ts';
import { decideUrl, DEFAULT_LIMITS } from '../../../src/import/url-policy.ts';
import type { InstrumentProfileId } from '../../../src/music/reference.ts';
import { acceptReview, createJob, loadJob, runJob, saveJob, type WorkerConfig } from './pipeline.ts';
import { runTool } from './process.ts';
import { findTools } from './tools.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function option(args: readonly string[], name: string): string | null {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const library = path.resolve(option(args, '--library') ?? process.env.ANYTUNE_LIBRARY ?? path.join(ROOT, 'library'));
  const tools = await findTools();
  const config: WorkerConfig = { library, tools, limits: DEFAULT_LIMITS, instrument: (option(args, '--instrument') ?? 'acoustic-guitar') as InstrumentProfileId, log: (line) => console.error(line) };
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const finish = (job: ReturnType<typeof loadJob>): number => {
    console.log(JSON.stringify({ job: job.id, stage: job.stage, outputs: job.outputs, failure: job.failure, diagnostics: job.diagnostics }, null, 2));
    if (job.stage === 'reviewing') console.error(`\nThe transcription is an estimate. Check ${path.join(library, 'jobs', job.id, 'reference.json')}, then accept it:\n  node services/import-worker/src/cli.ts review --job ${job.id} --accept`);
    return job.stage === 'failed' ? 1 : job.stage === 'cancelled' ? 3 : 0;
  };
  switch (command) {
    case 'doctor': {
      for (const tool of Object.values(tools)) console.log(tool.found ? `✓ ${tool.name}: ${tool.version} (${tool.path})` : `✗ ${tool.name}: ${tool.reason} — needed for ${tool.neededFor}`);
      return Object.values(tools).every((t) => t.found) ? 0 : 1;
    }
    case 'import': {
      const file = option(args, '--file');
      const midi = option(args, '--midi');
      const url = option(args, '--url');
      if ([file, midi, url].filter((x) => x !== null).length !== 1) return usage();
      const source = file !== null ? { kind: 'file' as const, path: path.resolve(file) } : midi !== null ? { kind: 'midi' as const, path: path.resolve(midi) } : { kind: 'url' as const, url: url as string, mode: 'single' as const };
      if (source.kind === 'url') {
        const decision = decideUrl(source.url, 'single');
        if (!decision.ok) {
          console.error(`refused: ${decision.reason}`);
          return 2;
        }
        for (const note of decision.ignored) console.error(`note: ${note}`);
      }
      const job = createJob(config, source, option(args, '--permission'));
      return finish(await runJob(config, job, controller.signal));
    }
    case 'playlist': {
      const url = option(args, '--url');
      const permission = option(args, '--permission');
      if (url === null || permission === null) return usage();
      const decision = decideUrl(url, 'playlist');
      if (!decision.ok || decision.kind !== 'playlist') {
        console.error(`refused: ${decision.ok ? 'not a playlist' : decision.reason}`);
        return 2;
      }
      const tool = tools['yt-dlp'];
      if (!tool.found) {
        console.error(`yt-dlp is needed: ${tool.reason}`);
        return 1;
      }
      const listed = await runTool(tool.path, ['--ignore-config', '--flat-playlist', '--playlist-end', String(DEFAULT_LIMITS.maxPlaylistItems), '--print', 'id', '--', decision.url], { timeoutMs: 120000, signal: controller.signal });
      if (listed.status !== 'ok') {
        console.error(`the playlist could not be listed: ${listed.message}`);
        return 1;
      }
      const ids = listed.stdout.toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{11}$/.test(s));
      console.error(`${ids.length} videos (at most ${DEFAULT_LIMITS.maxPlaylistItems}); one job each`);
      let worst = 0;
      for (const id of ids) {
        if (controller.signal.aborted) return 3;
        const job = createJob(config, { kind: 'url', url: `https://www.youtube.com/watch?v=${id}`, mode: 'single' }, permission);
        worst = Math.max(worst, finish(await runJob(config, job, controller.signal)));
      }
      return worst;
    }
    case 'review': {
      const id = option(args, '--job');
      if (id === null || !args.includes('--accept')) return usage();
      return finish(await acceptReview(config, loadJob(config, id)));
    }
    case 'retry': {
      const id = option(args, '--job');
      if (id === null) return usage();
      const t = retryJob(loadJob(config, id), new Date().toISOString());
      if (!t.ok) {
        console.error(t.reason);
        return 1;
      }
      saveJob(config, t.job);
      return finish(await runJob(config, t.job, controller.signal));
    }
    case 'status': {
      const id = option(args, '--job');
      if (id === null) return usage();
      return finish(loadJob(config, id));
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error('usage: cli.ts doctor | import (--file P | --midi P | --url U --permission TEXT) | playlist --url U --permission TEXT | review --job ID --accept | status --job ID | retry --job ID   [--library DIR] [--instrument ID]');
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
