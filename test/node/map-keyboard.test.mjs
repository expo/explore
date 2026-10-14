import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { mapKeyDirection, mapKeyTarget } = await tsImport("../../viewer/src/utils/map-keyboard.ts", import.meta.url);

// A top-to-bottom map: root fans out to a, b, c on one rank; b leads on to d; e is a stray rank with no edges.
//        root
//      /  |  \
//     a   b   c
//         |
//         d        e (same rank as d, far right, unlinked)
const positions = new Map([
  ["root", { x: 100, y: 0 }],
  ["a", { x: 0, y: 100 }],
  ["b", { x: 100, y: 100 }],
  ["c", { x: 200, y: 100 }],
  ["d", { x: 100, y: 200 }],
  ["e", { x: 300, y: 200 }],
]);
const group = (from, to) => ({ key: `${from}>${to}`, from, to, transitionIds: [], labels: [] });
const structure = {
  positions,
  groups: [group("root", "a"), group("root", "b"), group("root", "c"), group("b", "d"), group("d", "root")],
  horizontal: false,
};

test("arrow keys and hjkl map to the four directions; modifiers and other keys do not", () => {
  const plain = (key) => ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false });
  assert.equal(mapKeyDirection(plain("ArrowUp")), "up");
  assert.equal(mapKeyDirection(plain("k")), "up");
  assert.equal(mapKeyDirection(plain("ArrowDown")), "down");
  assert.equal(mapKeyDirection(plain("j")), "down");
  assert.equal(mapKeyDirection(plain("ArrowLeft")), "left");
  assert.equal(mapKeyDirection(plain("h")), "left");
  assert.equal(mapKeyDirection(plain("ArrowRight")), "right");
  assert.equal(mapKeyDirection(plain("l")), "right");
  assert.equal(mapKeyDirection(plain("Enter")), undefined);
  assert.equal(mapKeyDirection({ ...plain("ArrowDown"), metaKey: true }), undefined);
  assert.equal(mapKeyDirection({ ...plain("j"), ctrlKey: true }), undefined);
});

test("down and up move to the linked screen that lies in that direction on the map", () => {
  assert.equal(mapKeyTarget(structure, "root", "down"), "b");
  assert.equal(mapKeyTarget(structure, "b", "down"), "d");
  assert.equal(mapKeyTarget(structure, "d", "up"), "b");
  assert.equal(mapKeyTarget(structure, "a", "up"), "root");
  assert.equal(mapKeyTarget(structure, "c", "up"), "root");
});

test("left and right step along the rank, linked or not", () => {
  assert.equal(mapKeyTarget(structure, "a", "right"), "b");
  assert.equal(mapKeyTarget(structure, "b", "right"), "c");
  assert.equal(mapKeyTarget(structure, "c", "left"), "b");
  assert.equal(mapKeyTarget(structure, "d", "right"), "e");
  assert.equal(mapKeyTarget(structure, "e", "left"), "d");
});

test("a move with nowhere to go stays put", () => {
  assert.equal(mapKeyTarget(structure, "root", "up"), undefined);
  assert.equal(mapKeyTarget(structure, "a", "left"), undefined);
  assert.equal(mapKeyTarget(structure, "c", "right"), undefined);
  assert.equal(mapKeyTarget(structure, "d", "down"), undefined);
  assert.equal(mapKeyTarget(structure, "e", "up"), undefined);
  assert.equal(mapKeyTarget(structure, "missing", "down"), undefined);
});

test("the key reads the drawing, not the edge's direction: a destination drawn above is reached with up", () => {
  // d → root is drawn upward (a back-edge). From d, "down" has nothing below; "up" goes to b, the
  // nearest linked screen above, and from root "up" has nothing even though d links back to it.
  assert.equal(mapKeyTarget(structure, "d", "down"), undefined);
  assert.equal(mapKeyTarget(structure, "d", "up"), "b");
  assert.equal(mapKeyTarget(structure, "root", "up"), undefined);
});

test("a linked screen wins over a nearer unlinked one; an unlinked screen is reached only squarely in the key's direction", () => {
  // d is down-right of a and unlinked: a diagonal jump to an unrelated screen is not a "down".
  assert.equal(mapKeyTarget(structure, "a", "down"), undefined);
  // e is unlinked but level with d, straight to its right.
  assert.equal(mapKeyTarget(structure, "d", "right"), "e");
  const crowded = {
    positions: new Map([...positions, ["f", { x: 100, y: 150 }]]),
    groups: structure.groups,
  };
  // f sits squarely between b and d, unlinked and half as far: it is a stop on the way down, and
  // the linked d is the next one.
  assert.equal(mapKeyTarget(crowded, "b", "down"), "f");
  assert.equal(mapKeyTarget(crowded, "f", "down"), "d");
  // A linked screen a little further away than an unlinked one still wins.
  assert.equal(mapKeyTarget({ ...crowded, positions: new Map([...positions, ["f", { x: 100, y: 175 }]]) }, "b", "down"), "d");
});

test("a left-to-right map needs no special case: the keys read positions", () => {
  const rotated = {
    positions: new Map([...positions].map(([id, point]) => [id, { x: point.y, y: point.x }])),
    groups: structure.groups,
  };
  assert.equal(mapKeyTarget(rotated, "root", "right"), "b");
  assert.equal(mapKeyTarget(rotated, "b", "left"), "root");
  assert.equal(mapKeyTarget(rotated, "a", "down"), "b");
  assert.equal(mapKeyTarget(rotated, "c", "up"), "b");
});
