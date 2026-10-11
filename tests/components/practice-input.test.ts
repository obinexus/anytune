/**
 * The microphone before and during an assessed attempt, and what the review may say — on the Vue runtime and on OBIX's native runtime, in jsdom, through
 * the real ShellApp, analysis, practice session, views and components (tests/support/shell-harness.ts fakes only the audio device and the display's frames):
 *
 *   - Start asks for the microphone and checks it; a heard pluck makes it ready; only Begin starts an assessed attempt
 *   - a refusal, a missing device, digital silence (raw, then processed) and a faint input are each said apart — none is a "missed note"
 *   - a capture that stalls part-way leaves that part UNASSESSED, and the review counts only what was covered
 *   - a microphone that disconnects: "This attempt could not be assessed — check your microphone", never every note missed
 *   - played along without assessment: no score of any kind
 *   - a known performance with known mistakes gets the review that explains them — against the guitar arrangement, an octave lower than written
 *
 * The learner here plays where they would hear the reference: the browser-reported latency (made-up numbers of the test audio, 61 ms) after each due time.
 */
import '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteOf } from '../../src/domain/pitch.ts';
import { NOT_ASSESSED } from '../../src/lesson/feedback.ts';

const { RUNTIMES } = await import('../support/runtimes.ts');
const { FRAME, MemoryStore, TestAudio, performance, roomNoise, shellUi, SR } = await import('../support/shell-harness.ts');

/** the test audio's reported latencies, summed: the learner's sound reaches the capture this much after a note is due */
const LAG = 0.006 + 0.045 + 0.01;

for (const runtime of RUNTIMES) {
  type Ui = ReturnType<typeof shellUi>;

  /** Für Elise, bar 1 looped (six notes), ready to start */
  async function bar1(options: Parameters<typeof shellUi>[1] = {}): Promise<Ui> {
    const ui = shellUi(runtime, options);
    await ui.click('button.primary');
    await ui.choose(ui.$$('.settings select')[1] as HTMLElement, '1');
    await ui.choose(ui.$$('.settings select')[2] as HTMLElement, '1');
    return ui;
  }

  /** after Begin: the targets of pass 0, their capture-clock times (where the learner's sound arrives), and the end of the pass */
  function plan(ui: Ui) {
    const p = ui.app.shell.practice;
    assert.ok(p);
    const targets = p.getState().loopTargets;
    const arrives = (i: number): number => (p.due(0, (targets[i] as { time: number }).time) as number) + LAG;
    const passEnd = (p.due(1, (targets[0] as { time: number }).time) as number) + LAG;
    return { p, targets, arrives, passEnd };
  }

  /** the learner plays [key, capture-clock time] until `until` — rendered once, delivered up to each pause in turn (a check runs at each) */
  async function play(ui: Ui, notes: readonly (readonly [number, number])[], until: number, pauses: readonly { at: number; check: () => void }[] = []): Promise<void> {
    const from = ui.audio.t;
    const sound = performance(notes.map(([k, at]) => [k, at - from] as const), until - from);
    let done = 0;
    for (const pause of pauses) {
      const upTo = Math.floor(((pause.at - from) * SR) / FRAME) * FRAME;
      ui.audio.deliver(sound.subarray(done, upTo), ui.frame);
      done = upTo;
      await ui.settle();
      pause.check();
    }
    ui.audio.deliver(sound.subarray(done), ui.frame);
    await ui.settle();
  }

  test(`[${runtime.name}] Start does not start an assessed attempt: the microphone is asked for, then checked — a pluck heard makes it ready — and only Begin counts in`, async () => {
    const ui = await bar1();
    await ui.click(ui.button('Start'));
    assert.deepEqual(ui.audio.requests, [{ processing: false }], 'raw audio asked for first');
    assert.equal(ui.$('.input-check').dataset['state'], 'checking');
    assert.equal(ui.text('.input-text'), 'Checking the microphone: pluck any string and let it ring.');
    assert.equal(ui.$$('.input-check meter').length, 1, 'the input level meter');
    assert.equal(ui.app.shell.practice?.getState().phase, 'ready', 'no count-in, nothing judged');
    assert.equal(ui.audio.clicks.length, 0);
    assert.deepEqual(ui.texts('.actions button'), ['Cancel']);
    // room noise only: still checking — the meter moves, nothing is judged
    ui.audio.deliver(roomNoise(0.5), ui.frame);
    await ui.settle();
    assert.equal(ui.$('.input-check').dataset['state'], 'checking');
    assert.match(ui.$('.input-check meter').getAttribute('aria-valuetext') ?? '', /^-\d+ dBFS$/);
    // a pluck of the A string
    ui.audio.deliver(performance([[45, 0.2]], 1), ui.frame);
    await ui.settle();
    assert.equal(ui.$('.input-check').dataset['state'], 'ready');
    assert.equal(ui.text('.input-text'), 'Heard A2: the microphone hears your guitar. Press Begin when you are ready.');
    assert.deepEqual(ui.texts('.actions button'), ['Begin', 'Cancel']);
    await ui.click(ui.button('Begin'));
    assert.equal(ui.app.shell.practice?.getState().phase, 'count-in');
    assert.equal(ui.audio.clicks.length >= 3, true, 'the count-in');
    assert.equal(ui.text('.input-text'), 'Listening. What the microphone hears is analysed on this device and never uploaded.');
    assert.deepEqual(ui.texts('.actions button'), ['Stop']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] bar 1 played in time, as captured audio: every note right and on time; the review says what the microphone delivered; Progress lists it`, async () => {
    const ui = await bar1();
    await ui.checkInput();
    await ui.click(ui.button('Begin'));
    const { targets, arrives, passEnd } = plan(ui);
    await play(ui, targets.map((t, i) => [t.key, arrives(i)] as const), passEnd + 0.285);
    await ui.settle();
    assert.equal(ui.text('.phase'), 'Playing — pass 2');
    assert.deepEqual(ui.texts('.review .bars li'), ['Bar 1: 6 of 6 right, 6 on time']);
    await ui.click(ui.button('Stop'));
    assert.equal(ui.text('.phase'), 'Review');
    assert.ok(ui.texts('.review .sentences li').includes('Every note I heard clearly was the right one (6 notes).'));
    assert.equal(ui.text('.attempt'), 'This attempt is not saved: no recorder in this test.');
    const capture = ui.texts('.capture-lines li');
    assert.match(capture[0] ?? '', /^Audio received from 0\.0 s to \d+\.\d s: \d+\.\d s of sound; loudest -\d+ dBFS\.$/);
    assert.equal(capture.at(-1), 'No interruption.');
    assert.equal(ui.$$('.input-check').length, 0, 'the microphone released after the attempt');
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), ['6 of 6 right, 6 on time — not saved']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a known performance with known mistakes — late, a different note, the written octave, one not played — gets a review that explains each, against the guitar arrangement`, async () => {
    const ui = await bar1();
    await ui.checkInput();
    await ui.click(ui.button('Begin'));
    const { targets, arrives, passEnd } = plan(ui);
    const k = (i: number): number => (targets[i] as { key: number }).key;
    // 0 right · 1 right, 100 ms late · 2 a semitone sharp · 3 right · 4 the written pitch (an octave above the guitar arrangement) · 5 not played
    const notes = [[k(0), arrives(0)], [k(1), arrives(1) + 0.1], [k(2) + 1, arrives(2)], [k(3), arrives(3)], [k(4) + 12, arrives(4)]] as const;
    // the brief words as it goes: after the late note, after the wrong one — what to play instead — and after the octave
    const words: string[] = [];
    const word = (): void => void words.push(ui.$$('.live').length === 0 ? '' : ui.text('.live'));
    await play(ui, notes, passEnd + 0.285, [{ at: arrives(1) + 0.1 + 0.18, check: word }, { at: arrives(2) + 0.18, check: word }, { at: arrives(4) + 0.18, check: word }]);
    assert.deepEqual(words, ['A little late', `Try ${noteOf(k(2)).label}`, `Right note, other octave — try ${noteOf(k(4)).label}`]);
    await ui.click(ui.button('Stop'));
    const sentences = ui.texts('.review .sentences li');
    // pitch and timing apart: the two different notes were played on time, so they count as on time — and as a different note
    assert.deepEqual(ui.texts('.review .bars li'), ['Bar 1: 3 of 6 right, 4 on time, 2 a different note, 1 not heard']);
    assert.ok(sentences.includes('3 of the 5 notes I heard clearly were right.'), sentences.join(' | '));
    assert.ok(sentences.includes('Try bar 1 again: that is where most notes went astray.'));
    assert.ok(sentences.includes('1 note was the right note in the wrong octave.'), 'the written pitch is not the guitar arrangement’s');
    assert.ok(sentences.includes('I did not hear 1 note where it was due.'));
    assert.ok(sentences.includes('Timing: 4 on time, 0 early, 1 late.'));
    assert.equal(ui.$$('.review button').length, 1, 'repeating bar 1 is offered: enough was assessed');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the microphone refused: said, with what to do — no attempt starts, so there is no score and nothing in Progress`, async () => {
    const audio = new TestAudio();
    audio.outcome = 'denied';
    const ui = await bar1({ audio });
    await ui.click(ui.button('Start'));
    assert.equal(ui.$('.input-check').dataset['state'], 'denied');
    assert.match(ui.text('.input-text'), /^The microphone was not allowed\. Allow it for this page .* or play along without assessment\.$/);
    assert.deepEqual(ui.texts('.actions button'), ['Try again', 'Play along without assessment', 'Listen first']);
    assert.equal(ui.app.shell.practice?.getState().phase, 'ready');
    assert.equal(ui.$$('.review').length, 0);
    await ui.click(ui.button('Progress'));
    assert.equal(ui.$$('.attempts li').length, 0);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] no microphone, and a device that cannot be opened: each said as itself`, async () => {
    for (const [outcome, start] of [['no-device', /^No microphone was found\./], ['unreadable', /^The microphone could not be opened: another app may be using it\./]] as const) {
      const audio = new TestAudio();
      audio.outcome = outcome;
      const ui = await bar1({ audio });
      await ui.click(ui.button('Start'));
      assert.equal(ui.$('.input-check').dataset['state'], outcome);
      assert.match(ui.text('.input-text'), start);
      ui.mounted.unmount();
    }
  });

  test(`[${runtime.name}] digital silence: raw audio is asked for again with the browser's processing; still silent, the microphone is said to be muted — not refused, not quiet`, async () => {
    const ui = await bar1();
    await ui.click(ui.button('Start'));
    ui.audio.deliver(new Float32Array(Math.ceil(1.6 * SR)), ui.frame);
    await ui.settle();
    assert.deepEqual(ui.audio.requests, [{ processing: false }, { processing: true }]);
    assert.equal(ui.$('.input-check').dataset['state'], 'checking');
    assert.match(ui.text('.input-text'), /The browser’s audio processing is on: the raw microphone sent only silence\./);
    ui.audio.deliver(new Float32Array(Math.ceil(1.6 * SR)), ui.frame);
    await ui.settle();
    assert.equal(ui.$('.input-check').dataset['state'], 'muted');
    assert.match(ui.text('.input-text'), /^The microphone is sending only silence, raw and with the browser’s processing: it may be muted\./);
    assert.deepEqual(ui.texts('.actions button'), ['Try again', 'Play along without assessment', 'Listen first']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a faint input: after a few seconds, said to be faint with its level — and still checking, never a failure`, async () => {
    const ui = await bar1();
    await ui.click(ui.button('Start'));
    ui.audio.deliver(roomNoise(5.5), ui.frame);
    await ui.settle();
    assert.equal(ui.$('.input-check').dataset['state'], 'checking');
    assert.match(ui.text('.input-text'), /^I can hear the microphone, but only faintly \(loudest -\d+ dBFS\)\. Move it closer to the guitar, or raise its input level, then pluck a string\.$/);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the capture stalls part-way: said at once; that part is unassessed — the review counts only what the microphone covered`, async () => {
    const ui = await bar1();
    await ui.checkInput();
    await ui.click(ui.button('Begin'));
    const { targets, arrives, passEnd } = plan(ui);
    // the first three notes, in time — then, once the third note's window has passed, no frames at all until just before the pass ends
    await play(ui, [0, 1, 2].map((i) => [(targets[i] as { key: number }).key, arrives(i)] as const), arrives(2) + 0.3);
    ui.audio.stall(passEnd - 0.05 - ui.audio.t, ui.frame);
    await ui.settle();
    assert.equal(ui.text('.capture-alert'), 'The microphone stopped delivering sound: this part is not being assessed.');
    ui.audio.deliver(roomNoise(passEnd + 0.285 - ui.audio.t), ui.frame);
    await ui.settle();
    assert.equal(ui.text('.capture-alert'), 'The microphone is back: assessment resumed. The interrupted part is not counted.');
    await ui.click(ui.button('Stop'));
    assert.deepEqual(ui.texts('.review .bars li'), ['Bar 1: 3 of 3 right, 3 on time, 3 not assessed']);
    const sentences = ui.texts('.review .sentences li');
    assert.ok(sentences.includes('Assessed: 3 of 6 notes. For the other 3 the microphone was not delivering sound, so they are not counted.'), sentences.join(' | '));
    assert.ok(!sentences.some((s) => /did not hear/.test(s)), 'not one unheard note is called missed');
    assert.ok(ui.texts('.capture-lines li').some((l) => /^0\.\d s with no audio at all \(capture interrupted\)\.$/.test(l)));
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), ['3 of 3 assessed right, 3 on time (3 not assessed) — not saved']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the microphone disconnects as the attempt begins: "${NOT_ASSESSED}" — not every note missed, no bar to repeat`, async () => {
    const ui = await bar1();
    await ui.checkInput();
    await ui.click(ui.button('Begin'));
    const { passEnd } = plan(ui);
    ui.audio.end();
    ui.frame();
    await ui.settle();
    assert.equal(ui.text('.capture-alert'), 'The microphone was disconnected, or its permission withdrawn: the rest of this attempt is not being assessed.');
    ui.audio.stall(passEnd + 0.285 - ui.audio.t, ui.frame);
    await ui.click(ui.button('Stop'));
    assert.deepEqual(ui.texts('.review .sentences li'), [NOT_ASSESSED]);
    assert.deepEqual(ui.texts('.review .bars li'), ['Bar 1: not assessed']);
    assert.equal(ui.$$('.review button').length, 0, 'no bar to repeat');
    assert.ok(ui.texts('.capture-lines li').some((l) => /^The microphone stopped at \d+\.\d s \(disconnected, or the permission was withdrawn\)\.$/.test(l)));
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), ['Could not be assessed: the microphone was not delivering sound — not saved']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] played along without assessment: no microphone, nothing listened to, no score of any kind`, async () => {
    const ui = await bar1();
    await ui.click(ui.button('Play along without assessment'));
    assert.equal(ui.audio.requests.length, 0, 'the microphone is not asked for');
    const { targets, arrives, passEnd } = plan(ui);
    assert.ok(ui.audio.notes.length >= targets.length, 'the reference plays');
    await play(ui, targets.map((t, i) => [t.key, arrives(i)] as const), passEnd + 0.285); // sound in the room: nobody listens
    await ui.settle();
    assert.equal(ui.text('.phase'), 'Playing along — not assessed');
    assert.equal(ui.$$('.live').length, 0);
    await ui.click(ui.button('Stop'));
    assert.equal(ui.text('.phase'), 'Review — played along without assessment');
    assert.deepEqual(ui.texts('.review .sentences li'), ['Played along without assessment: nothing was listened to, so there is no score.']);
    assert.equal(ui.$$('.review .bars li').length, 0);
    assert.equal(ui.$$('.review button').length, 0);
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), ['Played along without assessment — no score']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a recorder connected: the assessed attempt is said to be saved, apart from the reference`, async () => {
    const store = new MemoryStore();
    const ui = await bar1({ store });
    await ui.checkInput();
    await ui.click(ui.button('Begin'));
    await ui.click(ui.button('Stop'));
    assert.equal(ui.text('.attempt'), `This attempt is saved (${store.events} events), apart from the reference.`);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the page hidden: a microphone check is closed; an attempt is stopped and the microphone released`, async () => {
    const ui = await bar1();
    await ui.click(ui.button('Start'));
    ui.app.pause();
    await ui.settle();
    assert.equal(ui.audio.stops, 1);
    assert.equal(ui.$$('.input-check').length, 0);
    await ui.checkInput();
    await ui.click(ui.button('Begin'));
    ui.app.pause();
    await ui.settle();
    assert.equal(ui.app.shell.practice?.getState().phase, 'reviewing');
    assert.equal(ui.audio.stops, 2);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the timing details name what the browser reports — never "measured" — and the microphone in use`, async () => {
    const ui = await bar1();
    await ui.checkInput();
    const lines = ui.texts('.timing-line');
    assert.equal(lines[0], 'Timing is judged after subtracting 61 ms: the sum of what the browser reports — AudioContext.baseLatency 6 ms, AudioContext.outputLatency 45 ms, the microphone track’s latency setting 10 ms.');
    assert.match(lines.join(' '), /not a measurement: AnyTune has not measured the delay from the speaker to the microphone on this device/);
    assert.ok(lines.includes('Microphone: Test microphone, 48 kHz, raw (no echo cancellation, noise suppression or gain control).'));
    assert.equal(ui.$('.diagnostics').hasAttribute('open'), false, 'collapsed: a detail, not the lesson');
    ui.mounted.unmount();
  });
}
