/**
 * The recorder inside the Android app: the WebView's narrow bridge (MainActivity.AnyTuneAndroid) carries each call to Kotlin, which adds the session token and
 * reaches AnyTune's recorder through Polycall's polycall_call (apps/android, docs/ANDROID.md). The page never sees the token and never names a file. Outside
 * the app — a browser — there is no bridge, and attempts are said to be unsaved.
 */
import type { AttemptStore } from '../app/practice.ts';
import { parseReply } from '../polycall/wire.ts';

interface AndroidBridge {
  recording(operation: string, inputObjectJson: string): string;
}

const bridge = (): AndroidBridge | null => {
  const candidate = (globalThis as { AnyTuneAndroid?: Partial<AndroidBridge> }).AnyTuneAndroid;
  return candidate !== undefined && typeof candidate.recording === 'function' ? (candidate as AndroidBridge) : null;
};

export function androidRecorder(): AttemptStore | null {
  const b = bridge();
  if (b === null) return null;
  const call = (operation: string, input: Record<string, unknown>): ReturnType<typeof parseReply> => parseReply(b.recording(operation, JSON.stringify(input)));
  return {
    async create(kind, meta) {
      const reply = call('create', { kind, meta });
      if (!reply.ok) return reply;
      const id = (reply.output as { recordingId?: unknown } | null)?.recordingId;
      return typeof id === 'string' ? { ok: true, value: { recordingId: id } } : { ok: false, error: { code: 'protocol.malformed', message: 'the recorder gave no recording id' } };
    },
    async append(recordingId, events) {
      const reply = call('append', { recordingId, events });
      return reply.ok ? { ok: true } : { ok: false, error: reply.error };
    },
    async finish(recordingId) {
      const reply = call('finish', { recordingId });
      return reply.ok ? { ok: true } : { ok: false, error: reply.error };
    },
  };
}

export const BROWSER_RECORDER_NOTE = 'in a browser there is no recorder (it runs through Polycall in the AnyTune Android app and the desktop import worker)';
