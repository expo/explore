import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settledScreenshot } from '../../dist/capture/flows/worker.js';

function fakeDevice(frames) {
  const shots = [];
  return { shots, client: { capture: { async screenshot({ path }) { const frame = frames[Math.min(shots.length, frames.length - 1)]; shots.push(frame); await writeFile(path, frame); } } } };
}

test('a step frame is shot again until two shots agree, and the last shot is kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'explore-settled-'));
  const pauses = [];
  const sleep = async ms => { pauses.push(ms); };
  const settling = fakeDevice(['easing-1', 'easing-2', 'settled', 'settled']);
  const file = join(dir, 'a.png');
  assert.deepEqual(await settledScreenshot(settling.client, file, { sleep, pauseMs: 150 }), { tries: 4, settled: true });
  assert.equal(settling.shots.length, 4, 'three re-shots after the first');
  assert.deepEqual(pauses, [150, 150, 150]);
  assert.equal(await readFile(file, 'utf8'), 'settled');

  const still = fakeDevice(['same']);
  assert.deepEqual(await settledScreenshot(still.client, join(dir, 'b.png'), { sleep }), { tries: 2, settled: true }, 'a still screen costs one re-shot');

  const restless = fakeDevice(['1', '2', '3', '4', '5', '6']);
  const result = await settledScreenshot(restless.client, join(dir, 'c.png'), { sleep, tries: 3 });
  assert.deepEqual(result, { tries: 3, settled: false }, 'bounded: an animating screen is kept after the last try');
  assert.equal(await readFile(join(dir, 'c.png'), 'utf8'), '3');

  const closing = fakeDevice(['x', 'y', 'z']);
  let open = true;
  const stopAfterFirstPause = async ms => { pauses.push(ms); open = false; };
  assert.deepEqual(await settledScreenshot(closing.client, join(dir, 'd.png'), { sleep: stopAfterFirstPause, more: () => open }), { tries: 1, settled: false },
    'once the device is going away the shot in hand is kept instead of asking for another');
  assert.equal(closing.shots.length, 1);
});
