/**
 * Follow my playing on the page — Play's default mode, in the journey's shell, on the Vue runtime and on OBIX's native runtime, in jsdom, through the real
 * ShellApp, follow session, live analysis, views and components (tests/support/shell-harness.ts fakes only the audio device and the display's frames):
 * the microphone checked before anything is judged; the target held until it is heard — nothing played, the wrong note, the right one; Skip, Hear this
 * target and Show fingering; the microphone stalling and ending with the place kept; a phrase repeated and compared; the capo; axe.
 *
 * What the learner plays here is SYNTHETIC (plucked-string synthesis, src/synthesis/pluck.ts) — no real guitar recording is used, and none establishes
 * how well a real microphone in a real room is heard.
 */
import '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

const { RUNTIMES } = await import('../support/runtimes.ts');
const { performance, shellUi, violations } = await import('../support/shell-harness.ts');

// Für Elise's guitar melody, an octave lower: E4 D♯4 | E4 D♯4 E4 B3 D4 C4 | A3 …
const E4 = 64;
const DS4 = 63;
const F4 = 65;
const A2 = 45;

for (const runtime of RUNTIMES) {
  type Ui = ReturnType<typeof shellUi>;

  async function followScreen(): Promise<Ui> {
    const ui = shellUi(runtime);
    await ui.click(ui.button('Play'));
    return ui;
  }

  /** the learner plays: [key, onset seconds from now], then the room's noise to `seconds` */
  async function play(ui: Ui, notes: readonly (readonly [number, number])[], seconds: number): Promise<void> {
    ui.audio.deliver(performance(notes, seconds), ui.frame);
    await ui.settle();
  }

  /** Start listening, pluck A2 for the check, Begin */
  async function listening(ui: Ui): Promise<void> {
    await ui.click(ui.button('Start listening'));
    await play(ui, [[A2, 0.2]], 1);
    await ui.click(ui.button('Begin'));
  }

  const count = (ui: Ui): string => ui.text('.follow-position .target-count');
  const message = (ui: Ui): [string, string] => [ui.text('.follow-message'), ui.$('.follow-message').dataset['tone'] ?? ''];

  test(`[${runtime.name}] Play opens on Follow my playing: the first target, where to play it, the next — and no microphone until Start`, async () => {
    const ui = await followScreen();
    assert.deepEqual(ui.texts('.mode-switch .mode'), ['Follow my playing', 'Play along (keeps time)']);
    assert.deepEqual(ui.$$('.mode-switch .mode').map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
    assert.equal(count(ui), 'Target 1 of 35 · the pickup');
    assert.equal(ui.text('.session-time'), '', 'no session yet');
    assert.equal(ui.text('.follow-now .current'), 'E4');
    assert.equal(ui.text('.follow-now .instruction'), 'Play E4 — high E string, open (0).');
    assert.equal(ui.text('.follow-now .finger-text'), 'No finger: an open string — a suggestion');
    assert.equal(ui.text('.follow-now .next'), 'Next: D♯4 — B string, fret 4.');
    // the fretboard: the current note named in its marker, the next outlined and named too; finger numbers apart, in their own badges
    assert.equal(ui.text('.fretboard-instruction'), 'Play E4 — high E string, open (0).');
    const markers = ui.$$('.fretboard .diagram .note-marker').map((m) => m.dataset['kind']);
    assert.deepEqual(markers, ['current', 'next']);
    assert.deepEqual(ui.texts('.fretboard .diagram .note-name'), ['E4', 'D♯4']);
    assert.ok(ui.texts('.fretboard-legend .legend-item').some((t) => t.startsWith('Current: E4')), ui.texts('.fretboard-legend .legend-item').join(' | '));
    assert.deepEqual(ui.texts('.transport button'), ['Start listening']);
    assert.equal(ui.audio.requests.length, 0, 'no microphone before Start');
    assert.equal(ui.$$('.hand-legend').length, 0);
    assert.equal(ui.$$('.follow-message').length, 0, 'no line repeating the instruction');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the microphone checked first; then the target waits: nothing played → it stays; the wrong note → the same target; the right one → exactly one on`, async () => {
    const ui = await followScreen();
    await ui.click(ui.button('Start listening'));
    assert.equal(ui.audio.requests.length, 1);
    assert.equal(ui.$('.input-check').dataset['state'], 'checking');
    assert.deepEqual(ui.texts('.transport button'), ['Cancel'], 'nothing judged, and no Begin, before a string is heard');
    await play(ui, [[A2, 0.2]], 1);
    assert.deepEqual(ui.texts('.transport button'), ['Begin', 'Cancel']);
    await ui.click(ui.button('Begin'));
    assert.equal(ui.text('.follow-now .phase'), 'Listening — at your own pace.');
    assert.deepEqual(ui.texts('.transport button'), ['Hear this target', 'Show fingering', 'Skip', 'Repeat this bar', 'Stop']);
    // nothing played, for a long while: the same target, nothing marked — no clock moves it
    await play(ui, [], 6.1);
    assert.equal(count(ui), 'Target 1 of 35 · the pickup');
    assert.equal(ui.text('.follow-now .current'), 'E4');
    assert.equal(ui.text('.session-time'), 'Session 0:06', 'the session time runs apart from the target');
    // the wrong note: said, and the same target
    await play(ui, [[F4, 0.1]], 1);
    assert.deepEqual(message(ui), ['Heard F4; try E4 again.', 'wrong']);
    assert.equal(count(ui), 'Target 1 of 35 · the pickup');
    // the right one: "Correct", and exactly one target on
    await play(ui, [[E4, 0.1]], 0.5);
    assert.deepEqual(message(ui), ['Correct — after one retry', 'correct']);
    assert.equal(count(ui), 'Target 2 of 35 · the pickup');
    assert.equal(ui.text('.follow-now .current'), 'D♯4');
    assert.equal(ui.text('.follow-now .instruction'), 'Play D♯4 — B string, fret 4.');
    assert.equal(ui.text('.fretboard-instruction'), 'Play D♯4 — B string, fret 4.');
    assert.equal(ui.text('.follow-now .finger-text'), 'Little finger (4) — a suggestion');
    // the note died away, then a long silence: still the second target — one attack, one decision
    await play(ui, [], 4);
    assert.equal(count(ui), 'Target 2 of 35 · the pickup');
    assert.equal(ui.$$('.follow-message').length, 0, '"Correct" shown briefly; then the instruction alone');
    await ui.click(ui.button('Stop'));
    assert.deepEqual(ui.texts('.review .sentences li').slice(0, 1), ['First try: 0 · Corrected: 1 (1 retry) · Skipped: 0 · Unassessed: 0']);
    assert.deepEqual(ui.texts('.review .corrections li'), ['Target 1 · E4: corrected after 1 retry (heard F4)']);
    assert.equal(ui.$$('.input-check').length, 0, 'the microphone released');
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), ['Follow my playing, targets 1–35 (stopped after 1): 0 first try, 1 corrected (1 retry), 0 skipped, 0 unassessed']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Show fingering, Hear this target, Skip: the finger named on the hand; a demonstration never answers itself; a skip recorded apart`, async () => {
    const ui = await followScreen();
    await listening(ui);
    await ui.click(ui.button('Show fingering'));
    assert.equal(ui.text('.hand-legend .hand-text'), 'No finger presses: open strings only.');
    assert.deepEqual(ui.texts('.hand-legend .finger-name'), ['1 = Index', '2 = Middle', '3 = Ring', '4 = Little']);
    await ui.click(ui.button('Skip'));
    assert.deepEqual(message(ui), ['Skipped E4.', 'skipped']);
    assert.equal(count(ui), 'Target 2 of 35 · the pickup');
    assert.deepEqual(ui.$$('.hand-legend .fingertip').map((f) => f.dataset['active']), ['false', 'false', 'false', 'true'], 'the little finger, for D♯4 at fret 4');
    assert.equal(ui.text('.hand-legend .hand-text'), 'Use: little (4). Your thumb stays behind the neck.');
    // the demonstration: the target sounds, and the microphone hearing it changes nothing
    const before = ui.audio.notes.length;
    await ui.click(ui.button('Hear this target'));
    assert.equal(ui.text('.follow-now .phase'), 'Listening paused while the target plays.');
    assert.deepEqual(ui.audio.notes.slice(before).map((n) => n.key), [DS4]);
    await play(ui, [[DS4, 0.05]], 0.6);
    assert.equal(count(ui), 'Target 2 of 35 · the pickup', 'its own sound is no answer');
    await play(ui, [], 2);
    assert.equal(ui.text('.follow-now .phase'), 'Listening — at your own pace.');
    await play(ui, [[DS4, 0.1]], 0.6);
    assert.equal(count(ui), 'Target 3 of 35 · bar 1');
    await ui.click(ui.button('Hide fingering'));
    assert.equal(ui.$$('.hand-legend').length, 0);
    await ui.click(ui.button('Stop'));
    assert.equal(ui.texts('.review .sentences li')[0], 'First try: 1 · Corrected: 0 (0 retries) · Skipped: 1 · Unassessed: 0');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the microphone stalls, then ends: assessment paused, the place kept, nothing marked; checked again — the same target`, async () => {
    const ui = await followScreen();
    await listening(ui);
    await play(ui, [[E4, 0.1]], 0.6);
    assert.equal(count(ui), 'Target 2 of 35 · the pickup');
    // no frames for a second: paused, at once
    ui.audio.stall(1, ui.frame);
    await ui.settle();
    assert.equal(ui.$('.follow-now').dataset['phase'], 'input-paused');
    assert.equal(ui.text('.follow-now .phase'), 'Paused: the microphone is not delivering sound. Your place is kept.');
    assert.equal(ui.text('.capture-alert'), 'The microphone stopped delivering sound: this part is not being assessed.');
    assert.equal(count(ui), 'Target 2 of 35 · the pickup');
    assert.ok(ui.hasButton('Move on without listening') && ui.hasButton('Check the microphone again'));
    // the frames come back: listening again, the same target
    await play(ui, [], 0.5);
    assert.equal(ui.$('.follow-now').dataset['phase'], 'listening');
    assert.deepEqual(message(ui), ['The microphone is back. Play D♯4.', 'info']);
    // the device ends: paused; checked again, then Begin — the same place
    ui.audio.end();
    await play(ui, [], 0.2);
    assert.equal(ui.$('.follow-now').dataset['phase'], 'input-paused');
    await ui.click(ui.button('Check the microphone again'));
    assert.equal(ui.audio.requests.length, 2);
    await play(ui, [[A2, 0.2]], 1);
    assert.equal(count(ui), 'Target 2 of 35 · the pickup', 'the check pluck is no answer');
    await ui.click(ui.button('Begin'));
    assert.equal(ui.$('.follow-now').dataset['phase'], 'listening');
    assert.equal(count(ui), 'Target 2 of 35 · the pickup');
    await play(ui, [[DS4, 0.1]], 0.6);
    assert.equal(count(ui), 'Target 3 of 35 · bar 1');
    await ui.click(ui.button('Stop'));
    assert.equal(ui.texts('.review .sentences li')[0], 'First try: 2 · Corrected: 0 (0 retries) · Skipped: 0 · Unassessed: 0', 'the pause marked nothing');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a bar repeated, then again: the second pass compared with the first — fewer retries`, async () => {
    const ui = await followScreen();
    await listening(ui);
    await ui.click(ui.button('Repeat this bar'));
    assert.equal(count(ui), 'Target 1 of 35 · the pickup');
    // the pickup bar, E4 D♯4: one wrong note on each
    await play(ui, [[F4, 0.1], [E4, 0.8]], 1.4);
    await play(ui, [[E4, 0.1], [DS4, 0.8]], 1.4);
    assert.equal(ui.$('.follow-now').dataset['phase'], 'phrase-done');
    assert.equal(ui.text('.follow-now .phase'), 'Phrase done.');
    assert.deepEqual(ui.texts('.review .corrections li'), ['Target 1 · E4: corrected after 1 retry (heard F4)', 'Target 2 · D♯4: corrected after 1 retry (heard E4)']);
    assert.ok(ui.hasButton('Repeat this phrase') && ui.hasButton('Continue to the end'));
    await ui.click(ui.button('Repeat this phrase'));
    assert.equal(count(ui), 'Target 1 of 35 · the pickup');
    await play(ui, [[E4, 0.1], [DS4, 0.8]], 1.4);
    assert.equal(ui.$('.follow-now').dataset['phase'], 'phrase-done');
    assert.match(ui.text('.review .comparison'), /^You corrected this passage with two fewer retries \(0; last time 2\)\. First try: 2 of 2 \(last time 0\)\./);
    await ui.click(ui.button('Continue to the end'));
    assert.equal(count(ui), 'Target 3 of 35 · bar 1');
    await ui.click(ui.button('Stop'));
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the capo: the same notes, their places counted from the capo; Play along and back`, async () => {
    const ui = await followScreen();
    const capo = ui.$$('.play-settings select').find((s) => [...(s as HTMLSelectElement).options].some((o) => o.text === 'Capo at fret 2')) as HTMLElement;
    await ui.choose(capo, '2');
    assert.equal(ui.text('.follow-now .current'), 'E4', 'a capo moves where a note is played, never which note');
    assert.match(ui.text('.follow-now .instruction'), /^Play E4 — .+ above the capo\.$|^Play E4 — .+ open at the capo \(0\)\.$/);
    assert.equal(ui.text('.fretboard .diagram .capo-label'), 'Capo 2');
    await ui.click(ui.button('Play along (keeps time)'));
    assert.deepEqual(ui.$$('.mode-switch .mode').map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
    assert.equal(ui.text('.play-now .current'), 'First: E4');
    await ui.click(ui.button('Follow my playing'));
    assert.equal(ui.text('.follow-now .current'), 'E4');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] axe-core (automated) finds no violation on Follow: ready, checking, listening, a wrong note, fingering shown, paused, phrase done, stopped`, async () => {
    const ui = await followScreen();
    const found: Record<string, string[]> = {};
    found['ready'] = await violations(ui.host);
    await ui.click(ui.button('Start listening'));
    found['checking'] = await violations(ui.host);
    await play(ui, [[A2, 0.2]], 1);
    await ui.click(ui.button('Begin'));
    found['listening'] = await violations(ui.host);
    await play(ui, [[F4, 0.1]], 1);
    found['wrong'] = await violations(ui.host);
    await ui.click(ui.button('Show fingering'));
    found['fingering'] = await violations(ui.host);
    ui.audio.stall(1, ui.frame);
    await ui.settle();
    found['paused'] = await violations(ui.host);
    await play(ui, [], 0.5);
    await ui.click(ui.button('Repeat this bar'));
    await play(ui, [[E4, 0.1], [DS4, 0.8]], 1.4);
    found['phrase-done'] = await violations(ui.host);
    await ui.click(ui.button('Stop'));
    found['stopped'] = await violations(ui.host);
    assert.deepEqual(found, { ready: [], checking: [], listening: [], wrong: [], fingering: [], paused: [], 'phrase-done': [], stopped: [] });
    ui.mounted.unmount();
  });
}
