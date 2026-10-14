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
      const chord = `${shortcut.code}:${Boolean(shortcut.mod)}:${Boolean(shortcut.alt)}:${Boolean(shortcut.shift)}`;
      const clash = seen.get(chord);
      assert.ok(!clash, `${group}.${name} repeats ${clash}`);
      seen.set(chord, `${group}.${name}`);
    }
  }
});
