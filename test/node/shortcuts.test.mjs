import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { SHORTCUTS, formatShortcut, matchesShortcut } = await tsImport("../../viewer/src/utils/shortcuts.ts", import.meta.url);

function key(code, modifiers = {}) {
  return { code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers };
}

test("hints print modifiers in Apple's ⌥⇧⌘ order and as Ctrl+Alt+Shift elsewhere", () => {
  assert.equal(formatShortcut({ code: "KeyT", key: "T", mod: true, alt: true }, true), "⌥⌘T");
  assert.equal(formatShortcut(SHORTCUTS.panel.right, true), "I");
  assert.equal(formatShortcut(SHORTCUTS.app.search, true), "⌘K");
  assert.equal(formatShortcut(SHORTCUTS.camera.fit, true), "⇧1");
  assert.equal(formatShortcut({ code: "KeyT", key: "T", mod: true, alt: true }, false), "Ctrl+Alt+T");
  assert.equal(formatShortcut(SHORTCUTS.edit.redo, false), "Ctrl+Shift+Z");
  // The Control key itself prints as ⌃ on a Mac, where ⌘ would be a different key.
  assert.equal(formatShortcut(SHORTCUTS.canvasByNumber.screens, true), "⌃2");
  assert.equal(formatShortcut(SHORTCUTS.canvasByNumber.screens, false), "Ctrl+2");
});

test("Ctrl+1, Ctrl+2 and Ctrl+3 reach Map, Screens and Compare with Control alone, never ⌘ (the browser's tab keys)", () => {
  assert.equal(matchesShortcut(key("Digit1", { ctrlKey: true }), SHORTCUTS.canvasByNumber.map), true);
  assert.equal(matchesShortcut(key("Digit2", { ctrlKey: true }), SHORTCUTS.canvasByNumber.screens), true);
  assert.equal(matchesShortcut(key("Digit3", { ctrlKey: true }), SHORTCUTS.canvasByNumber.compare), true);
  assert.equal(matchesShortcut(key("Digit1", { metaKey: true }), SHORTCUTS.canvasByNumber.map), false);
  assert.equal(matchesShortcut(key("Digit1", { ctrlKey: true, metaKey: true }), SHORTCUTS.canvasByNumber.map), false);
  assert.equal(matchesShortcut(key("Digit1", { ctrlKey: true, shiftKey: true }), SHORTCUTS.canvasByNumber.map), false);
  // Compare's 1, 2, 3 (Split, Swipe, Flip) stay plain digits.
  assert.equal(matchesShortcut(key("Digit1", { ctrlKey: true }), SHORTCUTS.compare.split), false);
  assert.equal(matchesShortcut(key("Digit1"), SHORTCUTS.canvasByNumber.map), false);
});

test("a chord matches only its own modifiers, on either ⌘ or Ctrl", () => {
  const chord = { code: "KeyT", key: "T", mod: true, alt: true };
  assert.equal(matchesShortcut(key("KeyT", { metaKey: true, altKey: true }), chord), true);
  assert.equal(matchesShortcut(key("KeyT", { ctrlKey: true, altKey: true }), chord), true);
  assert.equal(matchesShortcut(key("KeyT", { metaKey: true, shiftKey: true }), chord), false);
  assert.equal(matchesShortcut(key("KeyI"), SHORTCUTS.panel.right), true);
  assert.equal(matchesShortcut(key("KeyI", { metaKey: true }), SHORTCUTS.panel.right), false);
  assert.equal(matchesShortcut(key("KeyB", { metaKey: true, altKey: true }), SHORTCUTS.app.changes), false);
  assert.equal(matchesShortcut(key("KeyB", { metaKey: true }), SHORTCUTS.app.changes), true);
  assert.equal(matchesShortcut(key("KeyM"), SHORTCUTS.canvas.map), true);
  assert.equal(matchesShortcut(key("KeyM", { shiftKey: true }), SHORTCUTS.canvas.map), false);
  assert.equal(matchesShortcut(key("Digit1", { shiftKey: true }), SHORTCUTS.camera.fit), true);
});

test("no two shortcuts share a chord", () => {
  const seen = new Map();
  for (const [group, entries] of Object.entries(SHORTCUTS)) {
    for (const [name, shortcut] of Object.entries(entries)) {
      // Off Apple keyboards ⌘ is Ctrl, so a Control chord clashes with the same ⌘ chord.
      const chord = `${shortcut.code}:${Boolean(shortcut.mod || shortcut.ctrl)}:${Boolean(shortcut.alt)}:${Boolean(shortcut.shift)}`;
      const clash = seen.get(chord);
      assert.ok(!clash, `${group}.${name} repeats ${clash}`);
      seen.set(chord, `${group}.${name}`);
    }
  }
});
