/**
 * The whole app on the page — the journey's shell (src/harness/shell-app.ts, the .obix screens) on the official Vue runtime and on OBIX's native runtime, from
 * the same .obix files, in jsdom: Home, the navigation, the Library (a MIDI file opened, an .obr refused, the import explained), the tuner inside the shell,
 * Practise before a start, and accessibility on every screen. The microphone check and the assessed attempts: tests/components/practice-input.test.ts.
 *
 * What is faked, and only here: the practice audio, the files the learner chose, and the display's frames (tests/support/shell-harness.ts). The analysis, the
 * sessions, the views and the components are the real ones.
 */
import { window } from '../support/dom.ts';
import '../support/obix-loader.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_NOTE } from '../../src/harness/shell-app.ts';

const { RUNTIMES } = await import('../support/runtimes.ts');
const { FIXTURE, shellUi, violations } = await import('../support/shell-harness.ts');

for (const runtime of RUNTIMES) {
  const app = (options: Parameters<typeof shellUi>[1] = {}) => shellUi(runtime, options);

  test(`[${runtime.name}] Home: the motto, the journey, and the way in — one navigation, the screen shown marked as the current page`, async () => {
    const ui = app();
    assert.equal(ui.text('main h1'), 'Groove to any tune.');
    assert.deepEqual(ui.texts('.journey li'), ['Choose a song', 'Tune your guitar', 'Listen to it', 'Practise, slowly at first', 'Review what to repeat', 'Repeat']);
    assert.equal(ui.text('button.primary'), 'Practise Für Elise (opening)');
    assert.equal(ui.$$('nav').length, 1);
    const current = (): string[] => ui.$$('.nav-item').filter((b) => b.getAttribute('aria-current') === 'page').map((b) => (b.textContent ?? '').trim());
    assert.deepEqual(ui.texts('.nav-item'), ['Home', 'Library', 'Tune', 'Practise', 'Play', 'Progress']);
    assert.deepEqual(current(), ['Home']);
    await ui.click(ui.button('Library'));
    assert.equal(ui.text('main h1'), 'Library');
    assert.deepEqual(current(), ['Library']);
    await ui.click(ui.button('Progress'));
    assert.equal(ui.text('main h1'), 'Progress');
    assert.equal(ui.text('.empty'), 'No attempts yet: practise a song, and each attempt is listed here.');
    await ui.click(ui.button('Practise'));
    assert.equal(ui.text('.arrangement'), 'Choose a song in the Library to practise it.', 'nothing chosen yet: said, not an empty screen');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Library: a MIDI file opened becomes a song (its melody said); an .obr is read and refused, in words; a recording or a link is explained`, async () => {
    const midi = FIXTURE('midi', 'fur-elise-opening.mid');
    const ui = app({ files: { 'midi-file': { name: 'my-song.mid', bytes: midi }, 'obr-file': { name: 'demo.obr', bytes: FIXTURE('obr', 'demo.obr') } } });
    await ui.click(ui.button('Library'));
    assert.deepEqual(ui.texts('.song-title'), ['Für Elise (opening)']);
    ui.$('#midi-file').dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.settle();
    assert.deepEqual(ui.texts('.song-title'), ['Für Elise (opening)', 'my-song']);
    assert.match(ui.texts('.song-detail')[1] ?? '', /^MIDI file my-song\.mid; melody from track 1 \(C4–E5\), the highest of its 2 parts$/);
    assert.match(ui.text('.message'), /^my-song added: 35 melody notes\./);
    assert.equal(ui.$('.message').getAttribute('role'), 'status');
    ui.$('#obr-file').dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.settle();
    assert.match(ui.text('.message'), /^demo\.obr: /);
    assert.doesNotMatch(ui.text('.message'), /added/);
    assert.equal(ui.$$('.song').length, 2, 'the .obr added nothing');
    await ui.click(ui.button('Import a recording or a link'));
    assert.equal(ui.text('.message'), IMPORT_NOTE);
    // the song opened is practised like the bundled one
    await ui.click(ui.$$('.song button')[1] as HTMLElement);
    assert.equal(ui.text('main h1'), 'Practise');
    assert.equal(ui.text('.title'), 'my-song');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] the tuner, inside the shell: shown on Tune, and stopped when the learner goes elsewhere`, async () => {
    const ui = app();
    await ui.click(ui.button('Tune your guitar first'));
    assert.equal(ui.$('section.tuner-display').getAttribute('aria-label'), 'Tuner');
    await ui.click('button.start');
    assert.equal(ui.tuning.session.getState().session, 'listening');
    await ui.click(ui.button('Home'));
    assert.notEqual(ui.tuning.session.getState().session, 'listening', 'nothing keeps listening off the Tune screen');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Practise, before Start: the first note and where to play it — a suggestion — on the diagram, and the settings`, async () => {
    const ui = app();
    await ui.click('button.primary');
    assert.equal(ui.text('main h1'), 'Practise');
    assert.equal(ui.text('.title'), 'Für Elise (opening)');
    assert.equal(ui.text('.arrangement'), 'Melody on guitar, an octave lower than written');
    assert.equal(ui.text('.phase'), 'Press Start: the microphone is checked first — pluck a string — then a count-in, and play along.');
    assert.equal(ui.text('.current'), 'First: E4');
    assert.match(ui.text('.position'), /^high E string, open — a suggestion$/);
    assert.equal(ui.text('.next'), 'Then: D#4');
    // the enlarged fretboard: the first note is the open high e (○ before the nut), the next D#4 a dashed preview at fret 4 with its finger, at one unit per px
    const diagram = ui.$('svg.diagram');
    assert.deepEqual(ui.$$('svg.diagram circle.marker').map((m) => m.dataset['kind']), ['next']);
    assert.deepEqual(ui.$$('svg.diagram .string-mark').map((m) => [m.dataset['kind'], m.dataset['state'], m.textContent]), [['now', 'open', '○']]);
    assert.deepEqual(ui.$$('svg.diagram .finger').map((m) => m.textContent), ['4']);
    assert.deepEqual(ui.$$('svg.diagram .string-name').map((m) => m.textContent), ['e', 'B', 'G', 'D', 'A', 'E']);
    assert.deepEqual(ui.$$('svg.diagram .fret-number').map((m) => m.textContent), ['', '1', '2', '3', '4']);
    assert.equal(diagram.getAttribute('viewBox'), `0 0 ${diagram.getAttribute('width')} ${diagram.getAttribute('height')}`, 'one unit per CSS pixel');
    assert.match(diagram.getAttribute('aria-label') ?? '', /Now: E4, high E string, open — a suggestion\. Next: D#4, B string, fret 4, little finger \(4\) — a suggestion\./);
    // the artwork, horizontal: the image and the markers under one transformation, the whole drawing decorative (the words and the fretboard carry it)
    const artwork = ui.$('.artwork-svg');
    assert.equal(artwork.getAttribute('aria-hidden'), 'true');
    assert.equal(artwork.getAttribute('viewBox'), '0 0 1997.1 774.83');
    const turned = ui.$('.artwork-svg > g');
    assert.equal(turned.getAttribute('transform'), 'matrix(0 -1 1 0 0 774.83)');
    assert.equal(turned.querySelectorAll('image').length, 1);
    assert.equal(turned.querySelectorAll('circle.marker').length, 2, 'the markers are inside the same transformation as the image');
    assert.equal(ui.$('.fretboard').dataset['hand'], 'right');
    await ui.choose(ui.$$('.settings select')[4] as HTMLElement, 'left');
    assert.equal(ui.$('.fretboard').dataset['hand'], 'left');
    assert.equal(ui.$('.artwork-svg > g').getAttribute('transform'), 'matrix(0 -1 -1 0 1997.1 774.83)');
    assert.equal(ui.$$('.input-check').length, 0, 'the microphone is not asked for before Start');
    assert.deepEqual(ui.texts('.actions button'), ['Start', 'Play along without assessment', 'Listen first']);
    assert.equal(ui.audio.requests.length, 0);
    assert.equal(ui.$$('.review').length, 0, 'no review before a practice');
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] Listen first: the loop's notes are played on the audio clock, slower at a slower tempo`, async () => {
    const ui = app();
    await ui.click('button.primary');
    await ui.choose(ui.$$('.settings select')[1] as HTMLElement, '1');
    await ui.choose(ui.$$('.settings select')[2] as HTMLElement, '1');
    await ui.choose(ui.$$('.settings select')[0] as HTMLElement, '0.5');
    const targets = ui.app.shell.practice?.getState().loopTargets ?? [];
    assert.ok(targets.length > 0);
    await ui.click(ui.button('Listen first'));
    assert.deepEqual(ui.audio.notes.map((n) => n.key), targets.map((t) => t.key));
    const first = targets[0]?.time ?? 0;
    for (const [i, n] of ui.audio.notes.entries()) assert.ok(Math.abs(n.at - (ui.audio.t + 0.3 + ((targets[i]?.time ?? 0) - first) / 0.5)) < 1e-9);
    ui.mounted.unmount();
  });

  test(`[${runtime.name}] axe-core (automated) finds no violation on any screen: Home, Library with a message, Tune, Practise — before, checking the microphone, ready, playing and reviewed — and Progress`, async () => {
    const ui = app({ files: { 'obr-file': { name: 'demo.obr', bytes: FIXTURE('obr', 'demo.obr') } } });
    const found: Record<string, string[]> = {};
    found['home'] = await violations(ui.host);
    await ui.click(ui.button('Library'));
    ui.$('#obr-file').dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.settle();
    found['library'] = await violations(ui.host);
    await ui.click(ui.button('Tune'));
    found['tune'] = await violations(ui.host);
    await ui.click(ui.button('Library'));
    await ui.click(ui.$$('.song button')[0] as HTMLElement);
    found['practise'] = await violations(ui.host);
    await ui.click(ui.button('Start'));
    found['checking'] = await violations(ui.host);
    ui.audio.deliver((await import('../support/shell-harness.ts')).performance([[45, 0.2]], 1), ui.frame);
    await ui.settle();
    found['ready'] = await violations(ui.host);
    await ui.click(ui.button('Begin'));
    found['playing'] = await violations(ui.host);
    await ui.click(ui.button('Stop'));
    found['reviewed'] = await violations(ui.host);
    await ui.click(ui.button('Progress'));
    found['progress'] = await violations(ui.host);
    assert.deepEqual(found, { home: [], library: [], tune: [], practise: [], checking: [], ready: [], playing: [], reviewed: [], progress: [] });
    ui.mounted.unmount();
  });
}
