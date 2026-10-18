import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { regionMoves, regionShifts } from "../../dist/review/region-shift.js";

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
  // Moved down 5 also fits as up 7: two fits that good are ambiguous, so the region is not a move rather than a wrong one.
  assert.deepEqual(regionShifts(stripes(0), stripes(5), [{ x: 0, y: 20, width: 60, height: 60 }]), [undefined]);
});

/** A frame painted by `paint(x, y)` (dark where true) on a light background, optionally in colour. */
function painted(width, height, paint, colour = [30, 30, 30]) {
  const data = Buffer.alloc(width * height * 4, 240);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    if (paint(x, y)) { data[offset] = colour[0]; data[offset + 1] = colour[1]; data[offset + 2] = colour[2]; }
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

test("content that is the same all along one axis is measured along the other: full-width bars and hairlines", () => {
  const bar = offset => painted(80, 100, (x, y) => y >= 40 + offset && y < 46 + offset);
  assert.deepEqual(regionShifts(bar(0), bar(2), [{ x: 0, y: 30, width: 80, height: 30 }]), [{ x: 0, y: 2 }]);
  const hairline = offset => painted(80, 100, (x, y) => y === 50 + offset);
  assert.deepEqual(regionShifts(hairline(0), hairline(1), [{ x: 0, y: 44, width: 80, height: 12 }]), [{ x: 0, y: 1 }]);
  assert.deepEqual(regionShifts(hairline(0), hairline(-3), [{ x: 0, y: 40, width: 80, height: 16 }]), [{ x: 0, y: -3 }]);
});

test("a region that moved and also changed is not a move: the leftover after aligning it gives the change away", () => {
  // Three bars moved down 2px, plus a new short bar inside the region, as a digit that changed in a row that moved.
  const bars = (offset, extra) => painted(120, 160, (x, y) => (x >= 10 && x < 90 && ((y >= 20 + offset && y < 26 + offset)
    || (y >= 34 + offset && y < 38 + offset) || (y >= 60 + offset && y < 68 + offset))) || (extra && x >= 95 && x < 105 && y >= 45 && y < 48));
  assert.deepEqual(regionShifts(bars(0, false), bars(2, false), [region]), [{ x: 0, y: 2 }]);
  assert.deepEqual(regionShifts(bars(0, false), bars(2, true), [region]), [undefined]);
  // Another colour of the same brightness, moved: luminance alone would call it moved.
  const red = painted(120, 160, (x, y) => x >= 10 && x < 90 && y >= 20 && y < 40, [200, 40, 40]);
  const green = painted(120, 160, (x, y) => x >= 10 && x < 90 && y >= 22 && y < 42, [40, 112, 40]);
  assert.deepEqual(regionShifts(red, green, [region]), [undefined]);
});

test("a half-pixel move up and down is judged alike", () => {
  const up = regionShifts(frame(0), frame(-0.5), [region])[0], down = regionShifts(frame(0), frame(0.5), [region])[0];
  assert.deepEqual([up?.y, down?.y], [-0.5, 0.5]);
});

/**
 * A light frame with a dark card of irregular blocks at (x, y): the blocks make every offset look different, as a
 * real card's text and icons do. `tile` repeats one such block pattern every `tile` pixels across the whole row
 * instead, as a grid of identical cells does, starting `x` pixels in.
 */
function cardFrame({ width = 600, height = 300, x = 60, y = 80, cardWidth = 150, cardHeight = 120, seed = 7, tile } = {}) {
  const data = Buffer.alloc(width * height * 4, 240);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  const paint = (px, py, value) => data.fill(value, (py * width + px) * 4, (py * width + px) * 4 + 3);
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const blocks = Array.from({ length: tile ? 6 : 40 }, () => {
    const span = tile ?? cardWidth;
    return [Math.floor(random() * (span - 12)), Math.floor(random() * (cardHeight - 8)), 4 + Math.floor(random() * 8), 3 + Math.floor(random() * 5), 80 + Math.floor(random() * 160)];
  });
  for (let py = y; py < y + cardHeight; py += 1) {
    for (let px = tile ? 0 : x; px < (tile ? width : x + cardWidth); px += 1) {
      const local = tile ? (((px - x) % tile) + tile) % tile : px - x;
      const block = blocks.find(([bx, by, bw, bh]) => local >= bx && local < bx + bw && py - y >= by && py - y < by + bh);
      paint(px, py, block ? block[4] : 12);
    }
  }
  return { width, height, data };
}

test("a card that moved far along a row is one move, from the regions where it left and where it arrived", () => {
  const regions = [
    { x: 60, y: 80, width: 150, height: 120, dominantChange: "brighter" },
    { x: 330, y: 80, width: 150, height: 120, dominantChange: "darker" },
  ];
  const shifts = regionShifts(cardFrame(), cardFrame({ x: 330 }), regions);
  assert.deepEqual(shifts, [undefined, undefined], "too far for the drift search");
  assert.deepEqual(regionMoves(cardFrame(), cardFrame({ x: 330 }), regions, shifts),
    [{ rect: { x: 330, y: 80, width: 150, height: 120 }, shift: { x: 270, y: 0 }, members: [1, 0] }], "the region it arrived in first");
});

test("a move whose old and new places overlap takes in the fragments of it the comparison found in between", () => {
  // A 300-wide card moved 120 right: the comparison sees where it only was, where it only is, and a fragment of the
  // overlap whose pixels differ because the card's own content moved over itself.
  const base = cardFrame({ width: 700, cardWidth: 300 }), head = cardFrame({ width: 700, cardWidth: 300, x: 180 });
  const regions = [
    { x: 60, y: 80, width: 120, height: 120, dominantChange: "brighter" },
    { x: 360, y: 80, width: 120, height: 120, dominantChange: "darker" },
    { x: 200, y: 100, width: 120, height: 40, dominantChange: "mixed" },
  ];
  const [move] = regionMoves(base, head, regions, regions.map(() => undefined));
  assert.deepEqual(move, { rect: { x: 180, y: 80, width: 300, height: 120 }, shift: { x: 120, y: 0 }, members: [1, 0, 2] });
});

test("a card that moved far down a column is a vertical move", () => {
  const regions = [
    { x: 100, y: 20, width: 150, height: 100, dominantChange: "brighter" },
    { x: 100, y: 330, width: 150, height: 100, dominantChange: "darker" },
  ];
  const base = cardFrame({ height: 480, x: 100, y: 20, cardHeight: 100 }), head = cardFrame({ height: 480, x: 100, y: 330, cardHeight: 100 });
  assert.deepEqual(regionMoves(base, head, regions, [undefined, undefined]),
    [{ rect: { x: 100, y: 330, width: 150, height: 100 }, shift: { x: 0, y: 310 }, members: [1, 0] }]);
});

test("content that left one place while other content arrived elsewhere is not a move", () => {
  const regions = [
    { x: 60, y: 80, width: 150, height: 120, dominantChange: "brighter" },
    { x: 330, y: 80, width: 150, height: 120, dominantChange: "darker" },
  ];
  assert.deepEqual(regionMoves(cardFrame(), cardFrame({ x: 330, seed: 99 }), regions, [undefined, undefined]), [], "another card arrived");
  // The pair must be opposite: two regions that both got darker are two changes.
  assert.deepEqual(regionMoves(cardFrame(), cardFrame({ x: 330 }), regions.map(region => ({ ...region, dominantChange: "darker" })), [undefined, undefined]), []);
  // Regions already explained by a small move are not reconsidered.
  assert.deepEqual(regionMoves(cardFrame(), cardFrame({ x: 330 }), regions, [{ x: 0, y: 1 }, undefined]), []);
});

test("repeating content that lines up at several distances is not a move: the distance would be a guess", () => {
  // A row of identical cells every 40 pixels, all moved 260 right: 220, 260 and 300 fit about as well.
  const regions = [
    { x: 60, y: 80, width: 100, height: 120, dominantChange: "brighter" },
    { x: 300, y: 80, width: 100, height: 120, dominantChange: "darker" },
  ];
  assert.deepEqual(regionMoves(cardFrame({ tile: 40 }), cardFrame({ tile: 40, x: 320 }), regions, [undefined, undefined]), []);
});

/** Two frames laid over each other: the darker pixel of each wins, so a dark card in either shows. */
function overlay(first, second) {
  const data = Buffer.from(first.data);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.min(first.data[index], second.data[index]);
  return { ...first, data };
}

/** Paints a block of one colour into a frame, as a badge or icon drawn on top. */
function withBlock(frame, { x, y, width, height, value }) {
  const data = Buffer.from(frame.data);
  for (let py = y; py < y + height; py += 1) for (let px = x; px < x + width; px += 1) data.fill(value, (py * frame.width + px) * 4, (py * frame.width + px) * 4 + 3);
  return { ...frame, data };
}

const farMove = [
  { x: 60, y: 80, width: 150, height: 120, dominantChange: "brighter" },
  { x: 330, y: 80, width: 150, height: 120, dominantChange: "darker" },
];

test("something new where the card was stays a change: the move takes only the place it arrived", () => {
  // The card moved right, and another card took its old place.
  const head = overlay(cardFrame({ x: 330 }), cardFrame({ x: 60, seed: 99 }));
  assert.deepEqual(regionMoves(cardFrame(), head, farMove, [undefined, undefined]),
    [{ rect: { x: 330, y: 80, width: 150, height: 120 }, shift: { x: 270, y: 0 }, members: [1] }]);
});

test("content that did not arrive intact is not a move: part of it deleted, or something changed inside it", () => {
  // Only the card's top half arrived; its body was deleted.
  const deleted = withBlock(cardFrame({ x: 330 }), { x: 330, y: 140, width: 150, height: 60, value: 240 });
  assert.deepEqual(regionMoves(cardFrame(), deleted, farMove, [undefined, undefined]), []);
  // The card moved, and an 8×8 white mark appeared inside it: a badge is a change, however small.
  const marked = withBlock(cardFrame({ x: 330 }), { x: 400, y: 130, width: 8, height: 8, value: 255 });
  assert.deepEqual(regionMoves(cardFrame(), marked, farMove, [undefined, undefined]), []);
});

test("content that is the same all down a move along a row keeps the move in line", () => {
  // Vertical bars of irregular widths: every small vertical drift fits as well as none.
  const bars = x => {
    const frame = cardFrame({ x });
    const data = Buffer.from(frame.data);
    const widths = [6, 11, 4, 9, 14, 5, 8, 12, 7, 10, 6, 13, 9, 5, 11, 7, 6, 8];
    let px = x, dark = true;
    for (const width of widths) {
      for (let py = 80; py < 200; py += 1) for (let column = px; column < Math.min(px + width, x + 150); column += 1) data.fill(dark ? 20 : 200, (py * frame.width + column) * 4, (py * frame.width + column) * 4 + 3);
      px += width; dark = !dark;
    }
    return { ...frame, data };
  };
  const [move] = regionMoves(bars(60), bars(330), farMove, [undefined, undefined]);
  assert.deepEqual(move?.shift, { x: 270, y: 0 });
  assert.deepEqual(move?.rect, { x: 330, y: 80, width: 150, height: 120 });
});

test("regions with fractional edges, or reaching past the screenshot, are measured on the pixels they cover", () => {
  const regions = [
    { x: 60.4, y: 79.6, width: 149.8, height: 120.5, dominantChange: "brighter" },
    { x: 330.2, y: 80, width: 150.3, height: 400, dominantChange: "darker" },
  ];
  const [move] = regionMoves(cardFrame(), cardFrame({ x: 330 }), regions, [undefined, undefined]);
  assert.deepEqual(move?.shift, { x: 270, y: 0 });
});
