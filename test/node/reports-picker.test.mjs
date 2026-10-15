import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { decodeKeys, formatBytes, friendlyTime, reducePicker, renderPicker, runPicker, runTitle, visibleRuns } from '../../dist/cli/reports-picker.js';
import { INTRO_NAMES, intros, pickIntro, WORDMARK } from '../../dist/cli/title-intros.js';

const now = new Date(2026, 9, 15, 16, 0).getTime();
const at = (days, hour = 10) => new Date(2026, 9, 15 - days, hour, 29).toISOString();
const run = (id, fields) => ({ version: 1, id, platforms: ['ios'], createdAt: at(0), savedAt: at(0), bytes: 6_000_000, ...fields });
const RUNS = [
  run('local-1', { kind: 'local', title: 'HEAD vs main', repository: 'brentvatne/euxy', head: { ref: 'HEAD', sha: 'a8e71e1aaaa', subject: 'Refresh the explore report' },
    base: { ref: 'main', sha: 'aef021fbbbb', subject: 'Bump workflows' }, device: 'iPhone 17 · light + dark', changes: { modified: 32, added: 2, removed: 2 } }),
  run('pr-157', { kind: 'pull-request', number: 157, title: 'Splash screen and about page', repository: 'brentvatne/euxy', createdAt: at(1),
    head: { ref: 'about', sha: '3f09c2eaaaa', subject: 'Add /about' }, base: { ref: 'main', sha: 'aef021fbbbb' }, changes: { modified: 15, 'needs-review': 17 } }),
  run('local-2', { kind: 'local', title: 'uncommitted changes vs main', repository: 'brentvatne/euxy', uncommittedFiles: 3, platforms: ['ios', 'android'], createdAt: at(3),
    head: { ref: 'uncommitted changes', sha: '9c1d2aaaaaa', subject: 'Wire up the BPM column' }, base: { ref: 'main', sha: '71be0f3bbbb' }, changes: {} }),
  run('compare-1', { kind: 'compare', title: 'v1.4.0 vs v1.3.0', repository: 'expo/other', createdAt: at(6), head: { ref: 'v1.4.0', sha: 'e81f00baaaa' }, base: { ref: 'v1.3.0', sha: 'c2a9d41bbbb' } }),
  run('explore-acme', { kind: 'exploration', title: 'Acme 2.0 (41) on Pixel 9', platforms: ['android'], createdAt: new Date(2026, 8, 30).toISOString(),
    explored: { app: 'Acme', version: '2.0', buildNumber: '41', screens: 41, unexplored: 3 } }),
];
const state = (fields = {}) => ({ runs: RUNS, repository: 'brentvatne/euxy', scope: 'repository', filter: '', filtering: false, selected: 0, offset: 0, ...fields });
const screen = (fields, options = {}) => renderPicker(state(fields), { width: 100, height: 30, now, color: false, totalBytes: 184 * 1024 * 1024, ...options });

test('the list shows this repository\'s runs in aligned columns, and the selected one\'s commits and changes below', () => {
  const lines = screen();
  assert.ok(lines.includes(`   ${WORDMARK[0]}`), 'a tall terminal gets the wordmark');
  assert.ok(lines.some(line => line.includes('5 saved runs · 184 MB on disk · brentvatne/euxy')), 'the size says what it is');
  const rows = lines.filter(line => /^(▌ | {2})(Local|PR #|Compare|Explore)/.test(line));
  assert.deepEqual(rows.map(line => line.slice(2, 11).trim()), ['Local', 'PR #157', 'Local'], 'other repositories and explorations wait for tab');
  assert.match(rows[0], /^▌ Local {6}HEAD vs main {2,}a8e71e1 {2}iOS {10}this morning/);
  assert.match(rows[2], /HEAD \+ 3 uncommitted files vs main.*iOS Android {2}last Monday/);
  assert.equal(new Set(rows.map(row => row.indexOf('iOS'))).size, 1, 'the columns line up');
  assert.ok(lines.includes('  head  a8e71e1  Refresh the explore report'));
  assert.ok(lines.includes('  base  aef021f  Bump workflows  main'));
  assert.ok(lines.includes('  32 modified  2 added  2 removed   · iPhone 17 · light + dark'));
  assert.match(lines.at(-1), /↑↓ move {3}⏎ open {3}\/ filter {3}u upload {3}d delete {3}tab all repos {3}q quit/);
  assert.equal(lines.length, 30, 'it fills the terminal, with the keys on the last line');
});

test('tab shows every repository, and an exploration lists its screens', () => {
  const lines = screen({ scope: 'all', selected: 4 });
  assert.ok(lines.some(line => line.includes('· all repositories')));
  assert.ok(lines.some(line => /^▌ Explore {4}Acme 2\.0 \(41\) on Pixel 9 .* Android {6}Sep 30/.test(line)));
  assert.ok(lines.some(line => line.startsWith('  Compare    v1.3.0 → v1.4.0')));
  assert.ok(lines.includes('  41 screens  3 unexplored'));
});

test('a narrow or short terminal keeps the essentials', () => {
  const narrow = screen({}, { width: 60, height: 14 });
  assert.ok(narrow[0].includes('Expo Explore'), 'a plain name instead of the wordmark');
  assert.ok(!narrow.some(line => line.includes('a8e71e1  iOS')), 'the SHA and platform columns go first');
  assert.ok(narrow.every(line => [...line].length <= 60 || line.startsWith('─')), 'nothing runs past the edge');
  assert.ok(narrow.some(line => line.startsWith('▌ Local')));
});

test('filtering matches titles, commit subjects, SHAs and PR numbers, and says when nothing matches', () => {
  for (const [query, ids] of [['bpm', ['local-2']], ['157', ['pr-157']], ['a8e71e1', ['local-1']], ['ABOUT', ['pr-157']]]) {
    assert.deepEqual(visibleRuns(state({ filter: query })).map(each => each.id), ids, query);
  }
  assert.ok(screen({ filter: 'zzz' }).some(line => line.includes('Nothing matches "zzz".')));
  assert.ok(screen({ filtering: true, filter: 'bp' }).at(-1).includes('/ bp▏   1 of 5'));
  assert.ok(renderPicker(state({ runs: [] }), { width: 100, height: 30, now, color: false, totalBytes: 0 }).some(line => line.includes('No saved runs yet.')));
});

test('keys move, filter, open, upload, and delete only after y', () => {
  let current = state();
  const press = (...keys) => { let action; for (const key of keys) ({ state: current, action } = reducePicker(current, key)); return action; };
  press('down', 'down', 'down');
  assert.equal(current.selected, 2, 'the selection stops at the last run');
  press({ text: 'k' }, { text: 'g' });
  assert.equal(current.selected, 0);
  assert.deepEqual(press('enter'), { type: 'open', run: RUNS[0] });
  assert.deepEqual(press({ text: 'u' }), { type: 'upload', run: RUNS[0] });
  assert.equal(press({ text: 'd' }), undefined);
  assert.equal(current.confirming, 'local-1');
  assert.equal(press({ text: 'n' }), undefined);
  assert.equal(current.message, 'Kept it.');
  assert.deepEqual(press({ text: 'd' }, { text: 'y' }), { type: 'delete', run: RUNS[0] });
  press({ text: '/' }, { text: 'b' }, { text: 'p' }, { text: 'x' }, 'backspace');
  assert.deepEqual([current.filtering, current.filter], [true, 'bp']);
  assert.equal(press({ text: 'q' }), undefined, 'q is text while filtering');
  press('escape');
  assert.deepEqual([current.filtering, current.filter], [false, '']);
  press('tab');
  assert.equal(current.scope, 'all');
  assert.deepEqual(press('escape'), { type: 'quit' });
  assert.deepEqual(press('quit'), { type: 'quit' });
});

test('raw terminal input becomes keys, several at a time', () => {
  assert.deepEqual(decodeKeys('\x1b[A\x1b[B\r\tjk\x7f\x03\x1b'), ['up', 'down', 'enter', 'tab', { text: 'j' }, { text: 'k' }, 'backspace', 'quit', 'escape']);
  assert.deepEqual(decodeKeys('\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[C'), ['pageup', 'pagedown', 'home', 'end']);
});

test('times and sizes read like a person would say them', () => {
  assert.equal(friendlyTime(new Date(now - 30_000).toISOString(), now), 'just now');
  assert.equal(friendlyTime(new Date(now - 5 * 60_000).toISOString(), now), '5 min ago');
  assert.equal(friendlyTime(at(0, 9), now), 'this morning');
  assert.equal(friendlyTime(at(1), now), 'yesterday');
  assert.equal(friendlyTime(at(3), now), 'last Monday');
  assert.equal(friendlyTime(new Date(2025, 0, 2).toISOString(), now), 'Jan 2, 2025');
  assert.deepEqual([formatBytes(900), formatBytes(6_000_000), formatBytes(3 * 1024 ** 3)], ['1 KB', '6 MB', '3.0 GB']);
  assert.equal(runTitle(RUNS[2]), 'HEAD + 3 uncommitted files vs main');
});

test('every title animation ends on the wordmark, stays inside it, and one is picked at random unless named', () => {
  const plain = Object.fromEntries(['white', 'text', 'dim', 'faint', 'amber', 'green', 'yellow', 'blue'].map(name => [name, text => text]));
  for (const [name, intro] of Object.entries(intros(3))) {
    assert.deepEqual(intro.frame(1, plain).map(row => row.trimEnd()), WORDMARK.map(row => row.trimEnd()), name);
    for (const t of [0, 0.25, 0.5, 0.75]) assert.ok(intro.frame(t, plain).every(row => [...row].length <= WORDMARK[0].length + 24), `${name} at ${t}`);
    assert.ok(intro.duration <= 900, `${name} is quick`);
  }
  assert.equal(pickIntro({ EXPLORE_INTRO: 'off' }), undefined);
  assert.equal(pickIntro({ EXPLORE_INTRO: 'Beams' }), 'beams');
  assert.deepEqual(new Set([0, 0.2, 0.4, 0.6, 0.8].map(value => pickIntro({}, () => value))), new Set(INTRO_NAMES));
});

test('the picker restores the terminal however it ends', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, modes: [], setRawMode(mode) { this.modes.push(mode); return this; } });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
  let written = '';
  output.on('data', chunk => { written += chunk; });
  const removed = [];
  const picked = runPicker(state(), { input, output, color: false, remove: async each => { removed.push(each.id); }, totalBytes: () => 0 });
  input.write('jd');
  input.write('y');
  setTimeout(() => input.write('\r'), 20);
  const action = await picked;
  assert.deepEqual(removed, ['pr-157']);
  assert.deepEqual([action.type, action.run.id], ['open', 'local-2'], 'after a delete the selection moves to the next run');
  assert.deepEqual(input.modes, [true, false]);
  assert.ok(written.startsWith('\x1b[?1049h\x1b[?25l') && written.endsWith('\x1b[?25h\x1b[?1049l'), 'the alternate screen and cursor are restored');
  assert.ok(written.includes('Deleted Splash screen and about page.'));
});
