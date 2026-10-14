import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { gunzipSync } from 'node:zlib';
import { captureLaunch, detectLaunch, filmstripIndices, grayFrames, parseLaunchSetting, THUMB_HEIGHT, THUMB_WIDTH } from '../../dist/capture/launch-capture.js';

const frame = value => PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4, value) });
const settledPng = frame(255);
const splashPng = frame(16);
const previousPng = frame(128);

// Synthetic thumbnails: one gray level per screen, a frame per 100 ms.
const gray = (level, count) => Array.from({ length: count }, () => Buffer.alloc(THUMB_WIDTH * THUMB_HEIGHT, level));
const mixed = (from, to, share) => { const frame = Buffer.alloc(THUMB_WIDTH * THUMB_HEIGHT, from); frame.fill(to, 0, Math.floor(frame.length * share)); return frame; };

test('the splash is the stable screen held before the transition into the settled first screen', () => {
  // previous app → home → zoom → splash (1.2 s) → fade → settled
  const frames = [...gray(200, 4), ...gray(60, 4), mixed(60, 240, 0.5), ...gray(240, 12), mixed(240, 120, 0.5), ...gray(120, 10)];
  const detected = detectLaunch(frames);
  assert.deepEqual(detected.splash, { start: 9, end: 20, index: 14, frames: 12, steady: { start: 9, end: 20 } });
  assert.deepEqual(detected.settled, { index: frames.length - 1, start: 22 });
  assert.equal(detected.launchStart, 4);
  assert.equal(detected.firstScreenMs, 1800, 'launch transition to the first settled frame');
  // no splash: the launcher pause (0.4 s) is too short to count, the first screen is immediate
  const fast = detectLaunch([...gray(200, 4), ...gray(60, 4), mixed(60, 120, 0.5), ...gray(120, 10)]);
  assert.equal(fast.splash, undefined);
  assert.equal(fast.firstScreenMs, 500);
  // the first screen keeps animating: the splash is still the stable screen before the final frames
  assert.deepEqual(detectLaunch([...gray(200, 3), ...gray(60, 3), ...gray(240, 9), mixed(240, 120, 0.3), mixed(240, 120, 0.6), mixed(240, 120, 0.9), ...gray(120, 1)]).splash,
    { start: 6, end: 14, index: 10, frames: 9, steady: { start: 6, end: 14 } });
  // a one-frame flicker and a status bar clock change inside the splash do not end it
  const flicker = [...gray(200, 4), ...gray(60, 4), mixed(60, 240, 0.5), ...gray(240, 8), mixed(240, 200, 0.2), ...gray(240, 8), ...gray(120, 10)];
  flicker[12].fill(255, 0, THUMB_WIDTH * 2);
  assert.deepEqual(detectLaunch(flicker).splash, { start: 9, end: 25, index: 17, frames: 17, steady: { start: 9, end: 25 } }, 'one-frame changes do not end the steady run either');
  assert.equal(detectLaunch([]), undefined);
  assert.equal(detectLaunch(gray(1, 1)).splash, undefined);
  // a crossfade that pauses on two grey frames is part of the transition, not a screen before the splash
  const paused = [...gray(200, 4), ...gray(60, 2), ...gray(10, 20), ...gray(90, 2), mixed(90, 120, 0.5), ...gray(120, 10)];
  assert.deepEqual(detectLaunch(paused).splash, { start: 6, end: 25, index: 15, frames: 20, steady: { start: 6, end: 25 } });
  // a long launcher pause before a splash too short to count is still no splash: the launcher is not reported as one
  const launcherPause = [...gray(200, 4), ...gray(60, 12), ...gray(10, 4), ...gray(120, 10)];
  assert.equal(detectLaunch(launcherPause).splash, undefined);
  assert.equal(detectLaunch(launcherPause).firstScreenMs, 1600);
});

test('the filmstrip shows the pre-launch state, the transition, the splash ends, the crossfade, and the first screen', () => {
  assert.deepEqual(filmstripIndices({ settled: { index: 40, start: 30 }, launchStart: 5, splash: { start: 10, end: 25, index: 17, frames: 16 } }, 41), [0, 5, 10, 25, 27, 30]);
  assert.deepEqual(filmstripIndices({ settled: { index: 40, start: 30 }, launchStart: 5, splash: { start: 10, end: 29, index: 19, frames: 20 } }, 41), [0, 5, 10, 29, 30], 'no crossfade tile when the splash hands over directly');
  assert.deepEqual(filmstripIndices({ settled: { index: 12, start: 6 }, launchStart: 3 }, 13), [0, 3, 4, 6], 'no splash: before, transition, midway, first screen');
  assert.deepEqual(filmstripIndices({ settled: { index: 5, start: 0 } }, 6), [0], 'a recording that never changed is one tile');
});

test('real euxy launch recordings: the whole splash is measured, on light and dark, iOS and Android', async () => {
  const expected = {
    // sampled at 10 fps from the recordings `capture:baseline` kept with `capture.launch: video`
    'ios-light': { splash: [16, 37], firstScreenMs: 3000 }, 'ios-dark': { splash: [12, 36], firstScreenMs: 3000 },
    'ios2-light': { splash: [18, 39], firstScreenMs: 2800 }, 'ios2-dark': { splash: [15, 39], firstScreenMs: 2800 },
    // Android's system splash hands over to the app-drawn one with a one-frame flicker; the span is still one splash
    'android-light': { splash: [17, 48], firstScreenMs: 3700 }, 'android-dark': { splash: [11, 38], firstScreenMs: 3300 },
  };
  for (const [name, want] of Object.entries(expected)) {
    const raw = gunzipSync(await readFile(new URL(`../fixtures/launch/${name}-36x64.gray.gz`, import.meta.url)));
    const detected = detectLaunch(grayFrames(raw, 36, 64), { width: 36 });
    assert.deepEqual([detected.splash?.start, detected.splash?.end], want.splash, name);
    assert.equal(detected.firstScreenMs, want.firstScreenMs, name);
  }
});

test('real euxy launch recordings at full thumbnail size: the steady splash and its first change, from euxy #156', async () => {
  // Sampled at 10 fps from the recordings the euxy #156 review kept (head side). iOS: the native launch screen hands over
  // to the app-drawn one 1.3 s after the launch transition (the home indicator appears), then the type-on animation
  // and the crossfade; Android: the system splash animates in for 0.3 s and stays as it is until the crossfade.
  const expected = {
    'ios-light-head': { statusBar: 6.5, launchStart: 3, splash: [5, 26], steady: [5, 15], changed: 16, firstScreenMs: 2600, filmstrip: [0, 3, 5, 16, 26, 27, 29] },
    'ios-dark-head': { statusBar: 6.5, launchStart: 3, splash: [4, 24], steady: [4, 13], changed: 14, firstScreenMs: 2400, filmstrip: [0, 3, 4, 14, 24, 25, 27] },
    'android-light-head': { statusBar: 5, launchStart: 4, splash: [9, 49], steady: [12, 49], changed: undefined, firstScreenMs: 4900, filmstrip: [0, 4, 9, 49, 51, 53] },
    'android-dark-head': { statusBar: 5, launchStart: 5, splash: [9, 34], steady: [9, 34], changed: undefined, firstScreenMs: 3200, filmstrip: [0, 5, 9, 34, 35, 37] },
  };
  for (const [name, want] of Object.entries(expected)) {
    const frames = grayFrames(gunzipSync(await readFile(new URL(`../fixtures/launch/euxy156-${name}-108x192.gray.gz`, import.meta.url))));
    const detected = detectLaunch(frames, { statusBarPercent: want.statusBar });
    assert.equal(detected.launchStart, want.launchStart, name);
    assert.deepEqual([detected.splash.start, detected.splash.end], want.splash, `${name} splash span`);
    assert.deepEqual([detected.splash.steady.start, detected.splash.steady.end], want.steady, `${name} steady run`);
    assert.equal(detected.splash.changed, want.changed, `${name} first change`);
    assert.equal(detected.firstScreenMs, want.firstScreenMs, name);
    assert.deepEqual(filmstripIndices(detected, frames.length), want.filmstrip, `${name} filmstrip`);
  }
});

test('capture.launch accepts screenshot, video, or off and defaults to screenshot', () => {
  assert.equal(parseLaunchSetting(undefined, 'capture.launch'), 'screenshot');
  assert.equal(parseLaunchSetting('video', 'capture.launch'), 'video');
  assert.throws(() => parseLaunchSetting('always', 'capture.launch'), /capture\.launch must be/);
});

function fakeController(options) {
  const calls = [];
  let shots = 0;
  const controller = (args, callOptions) => {
    calls.push({ args, ...callOptions });
    const command = args.slice(0, 2).join(' ');
    if (command === 'record start') {
      if (!options.recording) throw new Error('unknown command: record');
      return { stdout: JSON.stringify({ success: true, data: { recording: 'started', outPath: args[2] } }) };
    }
    if (command === 'record stop') { return { stdout: JSON.stringify({ success: true, data: { recording: 'stopped' } }) }; }
    if (args[0] === 'open') { assert.ok(args.includes('--relaunch')); return { stdout: JSON.stringify({ success: true, data: {} }) }; }
    if (args[0] === 'screenshot') {
      const bytes = options.frames[Math.min(shots, options.frames.length - 1)]; shots += 1;
      writeFileSync(args[1], bytes);
      return { stdout: '{"success":true,"data":{}}' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { controller, calls };
}

test('a screenshot burst keeps the first new frame as the splash when a later frame differs and settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-'));
  // The screenshot before the relaunch shows the previous app state; the burst then sees the splash twice and the first screen twice.
  const { controller, calls } = fakeController({ recording: false, frames: [previousPng, splashPng, splashPng, settledPng, settledPng] });
  let clock = 1_000_000;
  const result = await captureLaunch({ controller, bundleId: 'dev.example', directory: join(directory, 'launch/light'), relativeDirectory: 'launch/light', keepVideo: true, now: () => (clock += 500) });
  assert.equal(result.status, 'observed');
  assert.equal(result.source, 'screenshot');
  assert.equal(result.splash.sha256, createHash('sha256').update(splashPng).digest('hex'));
  assert.equal(result.settled.sha256, createHash('sha256').update(settledPng).digest('hex'));
  assert.deepEqual([result.splash.width, result.splash.height], [4, 6]);
  assert.equal(result.splashVisibleMs, 1500, 'measured to the last screenshot that still showed the splash (the clock advances 500 ms per read)');
  assert.equal(result.video, undefined, 'no recording when the controller cannot record');
  assert.deepEqual((await readdir(join(directory, 'launch/light'))).sort(), ['settled.png', 'splash.png']);
  assert.equal(calls.filter(call => call.args[0] === 'screenshot').length, 5);
  assert.equal(calls[0].allowFailure, true);
});

test('a status bar clock tick between the pre-relaunch screenshot and the burst does not turn the previous app state into a splash', async () => {
  // 4x40 frames: the top 3 rows are the iOS status bar band (6.5 %); the previous state's clock ticks after the relaunch.
  const tall = (value, tick = false) => { const data = Buffer.alloc(4 * 40 * 4, value); if (tick) data.fill(255, 0, 4 * 4); return PNG.sync.write({ width: 4, height: 40, data }); };
  const directory = await mkdtemp(join(tmpdir(), 'launch-'));
  const { controller } = fakeController({ recording: false, frames: [tall(128), tall(128, true), tall(128, true), tall(255), tall(255)] });
  let clock = 1_000_000;
  const result = await captureLaunch({ controller, bundleId: 'dev.example', directory: join(directory, 'launch/light'), relativeDirectory: 'launch/light', keepVideo: false, now: () => (clock += 500) });
  assert.equal(result.status, 'not-observed');
  assert.equal(result.splash, undefined);
  assert.equal(result.settled.sha256, createHash('sha256').update(tall(255)).digest('hex'));
});

test('screenshots of the previous app state after the relaunch are not the splash', async () => {
  // Android keeps the old process on screen for a moment after `open --relaunch`; without a recording that used to be reported as a splash.
  const lingering = await mkdtemp(join(tmpdir(), 'launch-'));
  const stale = fakeController({ recording: false, frames: [previousPng, previousPng, previousPng, settledPng, settledPng] });
  let clock = 1_000_000;
  const notObserved = await captureLaunch({ controller: stale.controller, bundleId: 'dev.example', directory: join(lingering, 'launch/light'), relativeDirectory: 'launch/light', keepVideo: false, now: () => (clock += 500) });
  assert.equal(notObserved.status, 'not-observed');
  assert.equal(notObserved.source, 'screenshot');
  assert.equal(notObserved.splash, undefined);
  assert.equal(notObserved.splashVisibleMs, undefined);
  assert.equal(notObserved.settled.sha256, createHash('sha256').update(settledPng).digest('hex'));
  assert.deepEqual(await readdir(join(lingering, 'launch/light')), ['settled.png']);
  // The splash shows up after the old state left: it is the splash, measured only from its own screenshot.
  const late = await mkdtemp(join(tmpdir(), 'launch-'));
  const seen = fakeController({ recording: false, frames: [previousPng, previousPng, splashPng, settledPng, settledPng] });
  const observed = await captureLaunch({ controller: seen.controller, bundleId: 'dev.example', directory: join(late, 'launch/light'), relativeDirectory: 'launch/light', keepVideo: false, now: () => (clock += 500) });
  assert.equal(observed.status, 'observed');
  assert.equal(observed.splash.sha256, createHash('sha256').update(splashPng).digest('hex'));
  assert.equal(observed.splashVisibleMs, 0, 'a single screenshot of the splash bounds its time on screen from below only');
  assert.deepEqual((await readdir(join(late, 'launch/light'))).sort(), ['settled.png', 'splash.png']);
});

test('a recording that can be decoded supplies the splash frame scaled to the screenshot size and the kept video', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-'));
  const { controller } = fakeController({ recording: true, frames: [settledPng] });
  const recordingTools = {
    async frames(recording) { await writeFile(recording, 'mp4-bytes'); return [...gray(200, 5), ...gray(60, 4), mixed(60, 240, 0.5), ...gray(240, 20), mixed(240, 120, 0.5), ...gray(120, 6)]; },
    async extractFrame(recording, seconds, width, height, output) { assert.equal(seconds, 1.9, 'the middle of the steady splash run'); assert.deepEqual([width, height], [4, 6]); await writeFile(output, splashPng); },
    async normalize(recording, window) { assert.deepEqual(window, { startMs: 200, endMs: 3700 }, 'trimmed from just before the launch transition to a second into the first screen'); await writeFile(recording, 'h264-bytes'); },
    async filmstrip(recording, indices, originMs, output) { assert.deepEqual(indices, [0, 5, 10, 29, 30, 31]); assert.equal(originMs, 500); await writeFile(output, splashPng); },
  };
  // The controller writes the recording when it stops; the fake does it when the tools first read it.
  await writeFile(join(directory, 'placeholder'), '');
  const stopAware = (args, options) => {
    if (args.slice(0, 2).join(' ') === 'record stop') writeFileSync(join(directory, 'launch/light', 'launch.mp4'), 'mp4-bytes');
    return controller(args, options);
  };
  let clock = 0;
  const result = await captureLaunch({ controller: stopAware, bundleId: 'dev.example', directory: join(directory, 'launch/light'), relativeDirectory: 'launch/light', keepVideo: true, recordingTools, now: () => (clock += 3000) });
  assert.equal(result.status, 'observed');
  assert.equal(result.source, 'recording');
  assert.equal(result.splashVisibleMs, 2000);
  assert.equal(result.splashChangedMs, undefined, 'the synthetic splash left unchanged');
  assert.equal(result.firstScreenMs, 2600);
  assert.equal(result.splash.path, 'launch/light/splash.png');
  assert.deepEqual(result.video, { path: 'launch/light/launch.mp4', sha256: createHash('sha256').update('h264-bytes').digest('hex'), bytes: 10, mimeType: 'video/mp4', durationMs: 3500 });
  assert.equal(result.filmstrip.path, 'launch/light/filmstrip.png');
  assert.deepEqual(result.filmstrip.frameTimesMs, [-500, 0, 500, 2400, 2500, 2600], 'tile times are relative to the launch transition');
  assert.deepEqual([result.filmstrip.width, result.filmstrip.height], [4, 6]);
  assert.deepEqual((await readdir(join(directory, 'launch/light'))).sort(), ['filmstrip.png', 'launch.mp4', 'settled.png', 'splash.png']);
});

test('without a video setting the recording is deleted after it was decoded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'launch-'));
  const { controller } = fakeController({ recording: true, frames: [settledPng] });
  const stopAware = (args, options) => {
    if (args.slice(0, 2).join(' ') === 'record stop') writeFileSync(join(directory, 'launch/light', 'launch.mp4'), 'mp4-bytes');
    return controller(args, options);
  };
  const recordingTools = { async frames() { return [...gray(200, 3), mixed(200, 120, 0.5), ...gray(120, 6)]; }, async extractFrame() { throw new Error('not reached'); } };
  const result = await captureLaunch({ controller: stopAware, bundleId: 'dev.example', directory: join(directory, 'launch/light'), relativeDirectory: 'launch/light', keepVideo: false, recordingTools, now: (() => { let c = 0; return () => (c += 3000); })() });
  assert.equal(result.status, 'not-observed');
  assert.equal(result.source, 'recording', 'the recording was decoded; the launch was simply too fast for a splash');
  assert.equal(result.firstScreenMs, 100);
  assert.equal(result.filmstrip, undefined, 'no filmstrip without a tool for it');
  assert.deepEqual(await readdir(join(directory, 'launch/light')), ['settled.png']);
});
