import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { regionShifts } from "../../dist/review/region-shift.js";

/** A 120×160 frame of a light background with dark text-like bars, drawn `offsetY` pixels lower (fractions blend rows). */
function frame(offsetY, { barColor = 40, extraBar = false } = {}) {
  const width = 120, height = 160;
  const data = Buffer.alloc(width * height * 4, 240);
  const bars = [[10, 20, 80, 6], [10, 34, 60, 4], [10, 60, 90, 8], ...(extraBar ? [[10, 90, 70, 6]] : [])];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Coverage of the pixel row [y, y+1) by each bar after the vertical offset, for sub-pixel moves.
      let coverage = 0;
      for (const [bx, by, bw, bh] of bars) {
        if (x < bx || x >= bx + bw) continue;
        const top = by + offsetY, bottom = top + bh;
        coverage += Math.max(0, Math.min(y + 1, bottom) - Math.max(y, top));
      }
      const value = Math.round(240 - Math.min(1, coverage) * (240 - barColor));
      data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

const region = { x: 0, y: 10, width: 110, height: 70 };

test("a region whose content only moved reports how far, to a sixth of a pixel", () => {
  assert.deepEqual(regionShifts(frame(0), frame(2), [region]), [{ x: 0, y: 2 }]);
  assert.deepEqual(regionShifts(frame(0), frame(-4), [region]), [{ x: 0, y: -4 }]);
  const [third] = regionShifts(frame(0), frame(1 / 3), [region]);
  assert.ok(third && Math.abs(third.y - 1 / 3) < 0.1 && third.x === 0, JSON.stringify(third));
});

test("a region whose content changed, or that did not change, has no shift", () => {
  assert.deepEqual(regionShifts(frame(0), frame(0, { barColor: 200 }), [region]), [undefined], "another colour is a change, not a move");
  assert.deepEqual(regionShifts(frame(0), frame(0, { extraBar: true }), [{ x: 0, y: 80, width: 110, height: 30 }]), [undefined], "new content is a change");
  assert.deepEqual(regionShifts(frame(0), frame(0), [region]), [undefined], "identical pixels have nothing to explain");
});

test("screenshots of different sizes are not measured", () => {
  const small = { ...frame(0), width: 60, data: Buffer.alloc(60 * 160 * 4, 240) };
  assert.deepEqual(regionShifts(small, frame(2), [region]), [undefined]);
});

test("a third of a pixel counts as a move even when re-rasterized text explains only part of it, but changed content does not", () => {
  // A third of a pixel down, then every bar a shade darker: the shift explains roughly a third of the difference,
  // as re-rasterized text does on a 3x screen.
  const shifted = frame(1 / 3), base = frame(0);
  const noisy = { ...shifted, data: Buffer.from(shifted.data.map((value, index) => (index % 4 === 3 || value === 240 ? value : Math.max(0, value - 14)))) };
  const [move] = regionShifts(base, noisy, [region]);
  assert.ok(move && Math.abs(move.y - 1 / 3) < 0.1, JSON.stringify(move));
});

test("a best fit at the edge of the search is not a move: repeating content lines up with itself a pitch away", () => {
  // Bars repeating every 12 pixels; After is the same pattern 12 pixels lower, which also matches unshifted rows.
  const stripes = offset => {
    const width = 60, height = 120, data = Buffer.alloc(width * height * 4, 240);
    for (let y = 0; y < height; y += 1) if (((y - offset) % 12 + 12) % 12 < 4) for (let x = 0; x < width; x += 1) data.fill(30, (y * width + x) * 4, (y * width + x) * 4 + 3);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width, height, data };
  };
  const [shift] = regionShifts(stripes(0), stripes(5), [{ x: 0, y: 20, width: 60, height: 60 }]);
  assert.ok(!shift || Math.abs(shift.y) <= 10.5, JSON.stringify(shift));
});
