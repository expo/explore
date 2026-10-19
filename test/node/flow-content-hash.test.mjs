import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { contentSha256 } from '../../dist/shared/png-evidence.js';

const { PNG } = createRequire(import.meta.url)('pngjs');
function frame(width, height, paint) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y); const i = (y * width + x) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('contentSha256 ignores the status-bar and home-indicator bands and sees everything between them', () => {
  const bands = { top: 6.5, bottom: 3 };
  const body = (x, y) => [x % 256, y % 256, 40];
  const base = frame(60, 200, body);
  const clockTicked = frame(60, 200, (x, y) => (y < 10 ? [255, 255, 255] : body(x, y)));
  const indicatorInverted = frame(60, 200, (x, y) => (y >= 196 ? [0, 0, 0] : body(x, y)));
  const contentChanged = frame(60, 200, (x, y) => (y === 100 && x === 30 ? [9, 9, 9] : body(x, y)));
  assert.equal(contentSha256(clockTicked, bands), contentSha256(base, bands), 'a change inside the top band does not count');
  assert.equal(contentSha256(indicatorInverted, bands), contentSha256(base, bands), 'a change inside the bottom band does not count');
  assert.notEqual(contentSha256(contentChanged, bands), contentSha256(base, bands), 'one pixel between the bands does');
  assert.notEqual(contentSha256(base, bands), contentSha256(base, { top: 0, bottom: 0 }), 'the hashed region is part of the hash');
  assert.match(contentSha256(base, bands), /^[a-f0-9]{64}$/);
});
