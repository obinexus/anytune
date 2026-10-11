/**
 * The real recorder, for the tests that save through it: the staged polycall.exe (Polycall 1.1.0, main at 2dcab63) started on loopback with AnyTune's
 * recorder plugin (native/windows-x86_64/lib/anytune_recorder.dll), recordings in a temporary directory, a fresh session token. Nothing is mocked. `SKIP`
 * says why when the native artifacts are not staged (npm run native:stage, npm run native:recorder).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TcpPolycallTransport } from '../../src/polycall/node/tcp-transport.ts';
import { PolycallRecorder } from '../../src/recording/recorder.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const POLYCALL = path.join(ROOT, 'native', 'windows-x86_64', 'bin', 'polycall.exe');
const PLUGIN = path.join(ROOT, 'native', 'windows-x86_64', 'lib', 'anytune_recorder.dll');
const staged = os.platform() === 'win32' && fs.existsSync(POLYCALL) && fs.existsSync(PLUGIN);
export const SKIP: string | false = staged ? false : 'Polycall and the recorder plugin are not staged (npm run native:stage && npm run native:recorder)';

export interface RunningRecorder {
  readonly dir: string;
  readonly token: string;
  readonly transport: TcpPolycallTransport;
  readonly recorder: PolycallRecorder;
  /** shuts the runtime down (with its shutdown token) and removes the recordings */
  stop(): Promise<void>;
}

export async function startRecorder(): Promise<RunningRecorder> {
  const token = crypto.randomBytes(32).toString('base64url');
  const shutdown = crypto.randomBytes(24).toString('base64url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anytune-recordings-'));
  const endpointFile = path.join(dir, 'endpoint.txt');
  const runtime: ChildProcess = spawn(POLYCALL, ['start', '--endpoint', '127.0.0.1:0', '--endpoint-file', endpointFile, '--auth-token', shutdown, '--load', PLUGIN], {
    env: { ...process.env, ANYTUNE_RECORDINGS_DIR: dir, ANYTUNE_RECORDER_TOKEN: token },
    // Polycall writes its telemetry under its working directory (.polycall/): the temporary directory, never the repository
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const started = Date.now();
  while (!fs.existsSync(endpointFile) || fs.readFileSync(endpointFile, 'utf8').trim() === '') {
    if (Date.now() - started > 15000 || runtime.exitCode !== null) throw new Error(`polycall start did not bind (exit ${runtime.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const transport = new TcpPolycallTransport(fs.readFileSync(endpointFile, 'utf8').trim());
  return {
    dir,
    token,
    transport,
    recorder: new PolycallRecorder(transport, token),
    async stop() {
      const exited = new Promise((resolve) => runtime.once('exit', resolve));
      await transport.control('shutdown', shutdown);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
      if (runtime.exitCode === null) runtime.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
