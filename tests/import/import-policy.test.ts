/**
 * The import's pure decisions (src/import/): which URLs are fetched and how; the job's stages; what is done with a transcription engine's notes and how they
 * are scored. The worker that runs subprocesses is tested in import-worker.test.ts, against the real FFmpeg and Basic Pitch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, cancel, fail, newJob, plannedStages, retry, type Job } from '../../src/import/job.ts';
import { dropOctaveGhosts, scoreNotes } from '../../src/import/transcription.ts';
import { DEFAULT_LIMITS, decideUrl, ffmpegDecodeArguments, isPrivateAddress, ytDlpArguments } from '../../src/import/url-policy.ts';

test('the owner’s example — a video URL that also names a playlist — imports that one video only, and says the playlist was left out', () => {
  const d = decideUrl('https://www.youtube.com/watch?v=_XG3h6LywNQ&list=OLAK5uy_n8AsZn9DMhRFVeT8gQcuWHX_zYZ6WdVjw');
  assert.ok(d.ok && d.kind === 'video');
  assert.equal(d.videoId, '_XG3h6LywNQ');
  assert.equal(d.url, 'https://www.youtube.com/watch?v=_XG3h6LywNQ');
  assert.match(d.ignored.join(), /only this one video is imported/);
  const playlist = decideUrl('https://www.youtube.com/watch?v=_XG3h6LywNQ&list=OLAK5uy_n8AsZn9DMhRFVeT8gQcuWHX_zYZ6WdVjw', 'playlist');
  assert.ok(playlist.ok && playlist.kind === 'playlist');
  assert.equal(playlist.url, 'https://www.youtube.com/playlist?list=OLAK5uy_n8AsZn9DMhRFVeT8gQcuWHX_zYZ6WdVjw');
});

test('accepted forms: youtu.be, music.youtube.com, shorts — each made canonical, nothing of the pasted URL handed on but the id', () => {
  for (const [input, id] of [['https://youtu.be/_XG3h6LywNQ?si=abc', '_XG3h6LywNQ'], ['https://music.youtube.com/watch?v=abcdefghijk&feature=share', 'abcdefghijk'], ['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk']] as const) {
    const d = decideUrl(input);
    assert.ok(d.ok && d.kind === 'video', input);
    assert.equal(d.url, `https://www.youtube.com/watch?v=${id}`);
  }
});

test('refused before anything is fetched: http, credentials, a port, another host, a playlist-only URL in single mode, a bad id, not a URL', () => {
  const reason = (input: string, mode: 'single' | 'playlist' = 'single'): string => {
    const d = decideUrl(input, mode);
    assert.equal(d.ok, false, input);
    return d.ok ? '' : d.reason;
  };
  assert.match(reason('http://www.youtube.com/watch?v=abcdefghijk'), /only https/);
  assert.match(reason('https://me:pw@www.youtube.com/watch?v=abcdefghijk'), /user name or password/);
  assert.match(reason('https://www.youtube.com:8443/watch?v=abcdefghijk'), /explicit port/);
  assert.match(reason('https://evil.example/watch?v=abcdefghijk'), /not a supported provider/);
  assert.match(reason('https://www.youtube.com.evil.example/watch?v=abcdefghijk'), /not a supported provider/);
  assert.match(reason('https://www.youtube.com/playlist?list=OLAK5uy_n8AsZn9DMhRFVeT8gQcuWHX_zYZ6WdVjw'), /playlist action, deliberately/);
  assert.match(reason('https://www.youtube.com/watch?v=abc;rm -rf'), /no video id/);
  assert.match(reason('not a url'), /not a URL/);
  assert.match(reason('https://www.youtube.com/watch?v=abcdefghijk', 'playlist'), /needs a URL with its list= id/);
});

test('private networks are never reached: loopback, RFC 1918, link-local, CGNAT, multicast, unique-local and mapped v6 — public addresses are fine', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', 'ff02::1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['142.250.180.14', '172.32.0.1', '8.8.8.8', '2a00:1450:4009:80b::200e']) assert.ok(!isPrivateAddress(a), a);
});

test('yt-dlp is given an argument array: no user config, one video, the limits, a fixed name in the job’s own directory, the URL alone after "--"', () => {
  const d = decideUrl('https://youtu.be/_XG3h6LywNQ');
  assert.ok(d.ok);
  const args = ytDlpArguments(d, 'C:/library/job-1234abcd');
  assert.deepEqual(args.slice(0, 3), ['--ignore-config', '--no-cookies-from-browser', '--no-playlist']);
  assert.ok(args.includes(`duration <= ${DEFAULT_LIMITS.maxDurationSeconds} & !is_live`));
  assert.deepEqual(args.slice(args.indexOf('--output'), args.indexOf('--output') + 2), ['--output', 'source.%(ext)s']);
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=_XG3h6LywNQ']);
  assert.ok(!args.some((a) => /--exec|--cookies\b|--batch-file/.test(a)));
  assert.deepEqual(ffmpegDecodeArguments('in.mp4', 22050, 1200).slice(-6), ['-ar', '22050', '-t', '1200', '-f', 'f32le', 'pipe:1'].slice(-6));
});

const AT = '2026-10-11T12:00:00Z';
const step = (job: Job): Job => {
  const t = advance(job, AT);
  assert.ok(t.ok, t.ok ? '' : t.reason);
  return t.job;
};

test('a file’s job: queued → decoding → transcribing → reviewing → recording → ready; a MIDI file skips what it does not need; a URL needs a declaration of permission', () => {
  let job = newJob('job-0001', { kind: 'file', path: 'furelise.mp4' }, null, AT);
  const seen = [job.stage];
  while (job.stage !== 'ready') seen.push((job = step(job)).stage);
  assert.deepEqual(seen, ['queued', 'decoding', 'transcribing', 'reviewing', 'recording', 'ready']);
  assert.equal(advance(job, AT).ok, false);
  assert.deepEqual(plannedStages({ kind: 'midi', path: 'x.mid' }), ['queued', 'recording', 'ready']);
  assert.deepEqual(plannedStages({ kind: 'url', url: 'u', mode: 'single' })[1], 'downloading');
  assert.throws(() => newJob('job-0002', { kind: 'url', url: 'https://youtu.be/_XG3h6LywNQ', mode: 'single' }, null, AT), /declaration/);
});

test('a failure names its stage and whether a retry can help; a retry resumes there, keeping what came before; a cancelled job stays cancelled', () => {
  let job = step(newJob('job-0003', { kind: 'file', path: 'a.mp4' }, null, AT));
  job = step({ ...job, outputs: { source: 'source.mp4' } });
  const failed = fail(job, AT, 'engine.crashed', 'the transcription engine stopped', true);
  assert.ok(failed.ok);
  assert.deepEqual(failed.job.failure, { stage: 'transcribing', code: 'engine.crashed', message: 'the transcription engine stopped', retryable: true });
  const again = retry(failed.job, AT);
  assert.ok(again.ok && again.job.stage === 'transcribing' && again.job.outputs['source'] === 'source.mp4');
  const fatal = fail(job, AT, 'media.unsupported', 'no audio stream', false);
  assert.ok(fatal.ok);
  assert.equal(retry(fatal.job, AT).ok, false);
  const cancelled = cancel(job, AT);
  assert.ok(cancelled.ok && cancelled.job.stage === 'cancelled');
  assert.equal(advance(cancelled.job, AT).ok, false);
});

test('octave ghosts — a weaker note 12, 19 or 24 semitones above a stronger one struck with it — are dropped, each drop listed; a real, equal octave is kept', () => {
  const played = { key: 57, onsetSeconds: 1.0, durationSeconds: 0.4, strength: 0.75 };
  const ghost = { key: 69, onsetSeconds: 1.01, durationSeconds: 0.1, strength: 0.4 };
  const twelfth = { key: 76, onsetSeconds: 0.99, durationSeconds: 0.1, strength: 0.3 };
  const realOctave = { key: 69, onsetSeconds: 2.0, durationSeconds: 0.4, strength: 0.7 };
  const below = { key: 57, onsetSeconds: 2.0, durationSeconds: 0.4, strength: 0.75 };
  const result = dropOctaveGhosts([played, ghost, twelfth, below, realOctave]);
  assert.deepEqual(result.kept, [played, below, realOctave]);
  assert.deepEqual(result.dropped.map((d) => [d.note.key, d.harmonicOf.key]), [[69, 57], [76, 57]]);
});

test('note scores: a match is the same key within 50 ms, each note once; precision, recall and F1 follow — and the sweep finds the most matches', () => {
  const reference = [{ key: 60, onsetSeconds: 0 }, { key: 60, onsetSeconds: 0.06 }, { key: 64, onsetSeconds: 0.5 }, { key: 67, onsetSeconds: 1.0 }];
  const estimated = [{ key: 60, onsetSeconds: 0.03 }, { key: 60, onsetSeconds: 0.09 }, { key: 64, onsetSeconds: 0.57 }, { key: 62, onsetSeconds: 1.0 }];
  const s = scoreNotes(reference, estimated);
  // 0.03 could match either reference 60; matching it to 0 lets 0.09 match 0.06: two matches, not one
  assert.deepEqual([s.matched, s.precision, s.recall], [2, 0.5, 0.5]);
  assert.equal(s.f1, 0.5);
  assert.deepEqual(scoreNotes([], []).f1, 0);
});
