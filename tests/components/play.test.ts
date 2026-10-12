/**
 * Play on the page — the Play screen in the journey's shell, on the Vue runtime and on OBIX's native runtime, in jsdom, through the real ShellApp, play
 * session, views and components (tests/support/shell-harness.ts fakes only the audio device and the display's frames): the navigation's six screens; the
 * song and the arrangement; what to play now, big; the timeline's prompts arriving at a stationary "Now"; Play, Pause, Resume, Restart and Stop; a tempo
 * change; Play with feedback after the microphone check — and none without. Play opens on Follow my playing (tests/components/follow.test.ts); these tests
 * switch to Play along, the mode that keeps time.
 */
import '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

const { RUNTIMES } = await import('../support/runtimes.ts');
const { performance, shellUi, violations } = await import('../support/shell-harness.ts');

const LAG = 0.006 + 0.045 + 0.01;

for (const runtime of RUNTIMES) {
  type Ui = ReturnType<typeof shellUi>;

  async function playScreen(): Promise<Ui> {
    const ui = shellUi(runtime);
    await ui.click(ui.button('Play'));
    await ui.click(ui.button('Play along (keeps time)'));
    return ui;
  }

  /** let the audio clock run, frame by frame, with room noise on the microphone when it is open */
  async function run(ui: Ui, seconds: number): Promise<void> {
    ui.audio.deliver(performance([], seconds), ui.frame);
    await ui.settle();
  }

  const promptXs = (ui: Ui): number[] => ui.$$('.timeline-svg .prompt').map((p) => Number(p.getAttribute('x')));
  const playheadX = (ui: Ui): number => Number(ui.$('.timeline-svg .playhead').getAttribute('x1'));

  test(`[${runtime.name}] the navigation: Home · Library · Tune · Practise · Play · Progress — Play its own screen`, async () => {
    const ui = await playScreen();
    assert.deepEqual(ui.texts('.nav-item'), ['Home', 'Library', 'Tune', 'Practise', 'Play', 'Progress']);
    assert.deepEqual(ui.$$('.nav-item').filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent?.trim()), ['Play']);
    assert.equal(ui.text('main h1'), 'Play');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] before playing: the song and the arrangement chosen, the first note big with where to play it, the timeline with its first prompt at "Now" — and no lyrics, since none exist`, async () => {
    const ui = await playScreen();
    assert.deepEqual(ui.texts('.play-choice label:nth-child(1) option'), ['Für Elise (opening)']);
    assert.deepEqual(ui.texts('.play-choice label:nth-child(2) option'), ['Guitar — melody (octave lower)']);
    assert.equal(ui.text('.play-now .current'), 'First: E4');
    assert.equal(ui.text('.play-now .position'), 'high E string, open — a suggestion');
    assert.equal(ui.text('.play-now .next'), 'Then: D♯4');
    assert.equal(ui.text('.playhead-label'), 'Now');
    assert.deepEqual(ui.texts('.lane-name'), ['e', 'B', 'G', 'D', 'A', 'E']);
    const first = ui.$('.timeline-svg .prompt');
    assert.equal(Number(first.getAttribute('x')) + Number(first.getAttribute('width')) / 2, playheadX(ui), 'the first note waits at "Now"');
    assert.equal(first.dataset['kind'], 'now');
    assert.equal(ui.texts('.prompt-text')[0], '0', 'the open string');
    assert.deepEqual(ui.texts('.transport button'), ['Play song', 'Play song with feedback']);
    assert.equal(ui.$$('.lyrics').length, 0);
    assert.equal(ui.$('.play-settings').hasAttribute('open'), false, 'the settings are collapsed');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Play, Pause, Resume, Restart, Stop: the prompts move past a stationary "Now"; a pause freezes them; without feedback there is no score`, async () => {
    const ui = await playScreen();
    await ui.click(ui.button('Play song'));
    assert.equal(ui.audio.requests.length, 0, 'no microphone without feedback');
    assert.match(ui.text('.play-now .phase'), /^Get ready… \d$/);
    assert.deepEqual(ui.texts('.transport button'), ['Pause', 'Restart', 'Stop']);
    await run(ui, 2.2); // the count-in (three eighths at ♩ = 72: 1.25 s), then the song
    assert.equal(ui.text('.play-now .phase'), 'Playing — no feedback');
    const head = playheadX(ui);
    const before = promptXs(ui);
    assert.match(ui.text('.beat-text'), /^Bar \d · beat \d of 3$/);
    assert.equal(ui.$$('.beat-dot').length, 3);
    assert.equal(ui.$$('.beat-dot[data-on="true"]').length, 1);
    await run(ui, 0.5);
    assert.equal(playheadX(ui), head, 'the playhead does not move');
    assert.ok(promptXs(ui)[0] !== before[0], 'the prompts do');
    const progress = Number(ui.$('progress').getAttribute('value'));
    assert.ok(progress > 0);
    assert.ok(ui.audio.notes.length > 0, 'the reference plays');

    await ui.click(ui.button('Pause'));
    assert.equal(ui.text('.play-now .phase'), 'Paused');
    assert.deepEqual(ui.texts('.transport button'), ['Resume', 'Restart', 'Stop']);
    const frozen = promptXs(ui);
    await run(ui, 1);
    assert.deepEqual(promptXs(ui), frozen, 'paused: nothing moves');
    await ui.click(ui.button('Resume'));
    await run(ui, 1.4); // a count-in, then on from where it stopped
    assert.equal(ui.text('.play-now .phase'), 'Playing — no feedback');
    assert.ok(Number(ui.$('progress').getAttribute('value')) >= progress);

    await ui.click(ui.button('Restart'));
    assert.match(ui.text('.play-now .phase'), /^Get ready… \d$/);
    assert.equal(Number(ui.$('progress').getAttribute('value')), 0, 'from the beginning');
    await run(ui, 2);
    await ui.click(ui.button('Stop'));
    assert.equal(ui.text('.play-now .phase'), 'Finished — played without feedback');
    assert.deepEqual(ui.texts('.review .sentences li'), ['Played without feedback: nothing was listened to, so there is no score.']);
    assert.deepEqual(ui.texts('.transport button'), ['Play again', 'Play again with feedback']);
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), ['Played along (Play) without feedback — no score']);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] a tempo change while playing: the prompts spread out — time on the timeline is real time — and keep arriving at "Now"`, async () => {
    const ui = await playScreen();
    await ui.click(ui.button('Play song'));
    await run(ui, 2);
    const gap = (): number => {
      const xs = promptXs(ui);
      return (xs[xs.length - 1] as number) - (xs[xs.length - 2] as number);
    };
    const atFull = Math.abs(gap());
    await ui.choose(ui.$('.play-settings select') as HTMLElement, '0.5');
    await run(ui, 0.2);
    assert.equal(ui.text('.play-now .phase'), 'Playing — no feedback', 'the song goes on');
    assert.ok(Math.abs(Math.abs(gap()) - 2 * atFull) < 1, `${gap()} vs ${atFull}`);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Play with feedback: the microphone checked first; the whole melody played in time, as captured audio — every note right, on time; listed in Progress`, async () => {
    const ui = await playScreen();
    await ui.click(ui.button('Play song with feedback'));
    assert.equal(ui.$('.input-check').dataset['state'], 'checking');
    assert.deepEqual(ui.texts('.transport button'), ['Cancel']);
    ui.audio.deliver(performance([[45, 0.2]], 1), ui.frame);
    await ui.settle();
    assert.deepEqual(ui.texts('.transport button'), ['Begin', 'Cancel']);
    await ui.click(ui.button('Begin'));
    const session = ui.app.playSession;
    assert.ok(session !== null && session.getState().phase === 'count-in' && session.getState().assessing);
    // the learner plays every note where they hear it: the clock's due time, plus the reported latency
    const targets = session.getState().arrangement.targets;
    const arrivals = targets.map((t) => [t.key, (session.dueAt(t.time) as number) + LAG] as const);
    const from = ui.audio.t;
    const end = (arrivals[arrivals.length - 1] as readonly [number, number])[1] + 4;
    ui.audio.deliver(performance(arrivals.map(([k, at]) => [k, at - from] as const), end - from), ui.frame);
    await ui.settle();
    assert.equal(ui.text('.play-now .phase'), 'Finished');
    const sentences = ui.texts('.review .sentences li');
    assert.ok(sentences.includes(`Every note I heard clearly was the right one (${targets.length} notes).`), sentences.join(' | '));
    assert.equal(ui.$$('.input-check').length, 0, 'the microphone released at the end');
    assert.ok(ui.texts('.capture-lines li').includes('No interruption.'));
    await ui.click(ui.button('Progress'));
    assert.deepEqual(ui.texts('.attempts li p:last-child'), [`Played (Play): ${targets.length} of ${targets.length} right, ${targets.length} on time — ${targets.length} of ${targets.length} notes reached`]);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] axe-core (automated) finds no violation on Play: ready, playing, paused, checking the microphone, finished`, async () => {
    const ui = await playScreen();
    const found: Record<string, string[]> = {};
    found['ready'] = await violations(ui.host);
    await ui.click(ui.button('Play song'));
    await run(ui, 2);
    found['playing'] = await violations(ui.host);
    await ui.click(ui.button('Pause'));
    found['paused'] = await violations(ui.host);
    await ui.click(ui.button('Stop'));
    found['finished'] = await violations(ui.host);
    await ui.click(ui.button('Play again with feedback'));
    found['checking'] = await violations(ui.host);
    assert.deepEqual(found, { ready: [], playing: [], paused: [], finished: [], checking: [] });
    ui.mounted.unmount();
  });
}
