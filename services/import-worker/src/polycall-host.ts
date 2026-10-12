/**
 * The worker's Polycall runtime: the staged polycall.exe (native/windows-x86_64/bin) with AnyTune's recorder plugin loaded, a fresh session token, the
 * library's recordings directory, an ephemeral loopback port — started for the recording stage and stopped after it. The worker reaches the recorder through
 * Polycall like any other client (src/recording/recorder.ts over src/polycall/node/tcp-transport.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TcpPolycallTransport } from '../../../src/polycall/node/tcp-transport.ts';
import { PolycallRecorder } from '../../../src/recording/recorder.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export interface PolycallHost {
  readonly recorder: PolycallRecorder;
  readonly endpoint: string;
  stop(): Promise<void>;
}

export function stagedPolycall(): { readonly polycall: string; readonly plugin: string } | null {
  const polycall = process.env.ANYTUNE_POLYCALL ?? path.join(ROOT, 'native', 'windows-x86_64', 'bin', process.platform === 'win32' ? 'polycall.exe' : 'polycall');
  const plugin = process.env.ANYTUNE_RECORDER_PLUGIN ?? path.join(ROOT, 'native', 'windows-x86_64', 'lib', process.platform === 'win32' ? 'anytune_recorder.dll' : 'anytune_recorder.so');
  return fs.existsSync(polycall) && fs.existsSync(plugin) ? { polycall, plugin } : null;
}

export async function startPolycallHost(recordingsDirectory: string): Promise<PolycallHost> {
  const staged = stagedPolycall();
  if (staged === null) throw new Error('Polycall and the recorder plugin are not staged: npm run native:stage && npm run native:recorder');
  fs.mkdirSync(recordingsDirectory, { recursive: true });
  const token = crypto.randomBytes(32).toString('base64url');
  const shutdown = crypto.randomBytes(24).toString('base64url');
  const runDir = fs.mkdtempSync(path.join(recordingsDirectory, '.polycall-'));
  const endpointFile = path.join(runDir, 'endpoint');
  const child: ChildProcess = spawn(staged.polycall, ['start', '--endpoint', '127.0.0.1:0', '--endpoint-file', endpointFile, '--auth-token', shutdown, '--load', staged.plugin], {
    cwd: runDir, // Polycall's telemetry goes here, never into the repository
    env: { ...process.env, ANYTUNE_RECORDINGS_DIR: recordingsDirectory, ANYTUNE_RECORDER_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const started = Date.now();
  while (!fs.existsSync(endpointFile) || fs.readFileSync(endpointFile, 'utf8').trim() === '') {
    if (child.exitCode !== null) throw new Error(`polycall start exited ${child.exitCode}: ${stderr.trim()}`);
    if (Date.now() - started > 15000) {
      child.kill();
      throw new Error('polycall start did not bind within 15 s');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const endpoint = fs.readFileSync(endpointFile, 'utf8').trim();
  const transport = new TcpPolycallTransport(endpoint);
  return {
    endpoint,
    recorder: new PolycallRecorder(transport, token),
    async stop() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await transport.control('shutdown', shutdown);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
      if (child.exitCode === null) child.kill();
      fs.rmSync(runDir, { recursive: true, force: true });
    },
  };
}
