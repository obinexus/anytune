/**
 * What the microphone delivered (src/app/capture.ts) and the input check before an assessed attempt (src/app/input-check.ts): real sound covers time;
 * digital silence, a gap with no frames, and the time after the device ended do not — and are said apart. The check is ready on a heard note, never on the
 * permission alone, and says when the input is silent, faint or unclear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveAnalyser } from '../../src/analysis/live.ts';
import { CaptureMonitor, captureText } from '../../src/app/capture.ts';
import { InputCheck } from '../../src/app/input-check.ts';
import { renderNotes } from '../../src/synthesis/pluck.ts';

const SR = 48000;
const FRAME = 1024;
const D = FRAME / SR;
/** a frame of room noise at about −60 dBFS: real sound, no music */
const room = (): Float32Array => Float32Array.from({ length: FRAME }, (_, i) => 0.001 * Math.sin(i * 1.7) + 0.0005 * Math.sin(i * 0.31));
const zeros = (): Float32Array => new Float32Array(FRAME);

test('real sound covers the time it was captured; digital silence, a gap and the time after the device ended do not — each said apart', () => {
  const m = new CaptureMonitor(SR);
  let t = 100;
  for (let i = 0; i < 50; i++, t += D) m.push(room(), t); // ~1.07 s of sound
  const soundEnd = t;
  for (let i = 0; i < 30; i++, t += D) m.push(zeros(), t); // ~0.64 s of zeros
  const silentEnd = t;
  t += 0.5; // half a second with no frames
  const resumed = t;
  for (let i = 0; i < 20; i++, t += D) m.push(room(), t);
  m.ended(t);
  assert.equal(m.healthyBetween(100.1, soundEnd - 0.05), true);
  assert.equal(m.healthyBetween(soundEnd + 0.1, silentEnd - 0.1), false, 'digital silence is not coverage');
  assert.equal(m.healthyBetween(silentEnd + 0.1, resumed - 0.1), false, 'a gap is not coverage');
  assert.equal(m.healthyBetween(resumed + 0.05, t - 0.05), true, 'capture that resumes covers again');
  assert.equal(m.healthyBetween(t + 0.1, t + 1), false, 'nothing after the device ended');
  const s = m.summary();
  assert.deepEqual(s.problems.map((p) => p.why), ['digital-silence', 'gap', 'ended']);
  assert.ok(Math.abs(s.gapSeconds - 0.5) < 0.01 && Math.abs(s.silentSeconds - 30 * D) < 1e-9);
  const text = captureText(s, 100);
  assert.match(text[0] ?? '', /^Audio received from 0\.0 s to \d+\.\d s: 1\.5 s of sound; loudest -57 dBFS\.$/);
  assert.match(text.join(' '), /0\.6 s of digital silence.*0\.5 s with no audio at all.*stopped at/);
});

test('the input check: ready on the first clearly heard note — and only then; digital silence is said as silent; faint input as quiet; an onset without a pitch as unclear', () => {
  // a pluck of A2, captured: ready, naming what it heard
  const m = new CaptureMonitor(SR);
  const a = new LiveAnalyser({ sampleRate: SR, listenFor: 'notes' });
  const check = new InputCheck(10);
  const pluck = renderNotes([{ key: 45, onsetSeconds: 0.4, durationSeconds: 0.8, velocity: 90 }], SR);
  const verdicts: string[] = [];
  for (let i = 0; i + FRAME <= pluck.length; i += FRAME) {
    const frame = pluck.slice(i, i + FRAME);
    const at = 10 + i / SR;
    m.push(frame, at);
    const v = check.update(m, at + D, a.push(frame, at));
    verdicts.push(v.kind === 'ready' ? `ready:${v.heard}` : v.kind === 'checking' ? v.hint : v.kind);
  }
  assert.equal(verdicts[0], 'pluck', 'the permission alone is not readiness');
  assert.ok(verdicts.includes('ready:A2'), verdicts.join(','));

  // zeros: silent after 1.5 s — not "quiet", not "denied"
  const muted = new CaptureMonitor(SR);
  const c2 = new InputCheck(0);
  let last = '';
  for (let t = 0; t < 2; t += D) {
    muted.push(zeros(), t);
    last = c2.update(muted, t + D, []).kind;
  }
  assert.equal(last, 'silent');

  // faint room sound for 6 s: quiet
  const faint = new CaptureMonitor(SR);
  const c3 = new InputCheck(0);
  let hint = '';
  for (let t = 0; t < 6; t += D) {
    faint.push(room(), t);
    const v = c3.update(faint, t + D, []);
    hint = v.kind === 'checking' ? v.hint : v.kind;
  }
  assert.equal(hint, 'quiet');

  // an onset with no pitch: unclear
  const c4 = new InputCheck(0);
  const v4 = c4.update(faint, 6, [{ kind: 'unclear', time: 5.9, strength: 0.2 }]);
  assert.deepEqual(v4, { kind: 'checking', hint: 'unclear' });
});
