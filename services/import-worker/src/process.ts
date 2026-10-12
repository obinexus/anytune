/**
 * Running a tool: always an executable path and an argument array — never a shell, never a string to interpolate — with a time limit, a cancellation signal,
 * and a cap on what is kept of its output. A tool that cannot be found, times out, is cancelled or fails says so as a result, never as an exception.
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  readonly status: 'ok' | 'failed' | 'timeout' | 'cancelled' | 'not-runnable';
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly message: string;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** stdout beyond this many bytes is an error (a decoder producing far more than the limits allow) */
  readonly maxStdoutBytes?: number;
}

export function runTool(executable: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    try {
      child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 'not-runnable', exitCode: null, stdout: Buffer.alloc(0), stderr: '', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: 'timeout', exitCode: null, stdout: Buffer.concat(out), stderr: err, message: `${executable} took longer than ${options.timeoutMs} ms and was stopped` });
    }, options.timeoutMs);
    const onAbort = (): void => {
      child.kill();
      finish({ status: 'cancelled', exitCode: null, stdout: Buffer.concat(out), stderr: err, message: 'cancelled' });
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (options.maxStdoutBytes !== undefined && outBytes > options.maxStdoutBytes) {
        child.kill();
        finish({ status: 'failed', exitCode: null, stdout: Buffer.alloc(0), stderr: err, message: `${executable} produced more than ${options.maxStdoutBytes} bytes` });
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < 64 * 1024) err += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ status: 'not-runnable', exitCode: null, stdout: Buffer.alloc(0), stderr: err, message: error.message }));
    child.on('close', (code) => finish({ status: code === 0 ? 'ok' : 'failed', exitCode: code, stdout: Buffer.concat(out), stderr: err, message: code === 0 ? 'ok' : `${executable} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}` }));
  });
}
