import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { heldKeyHint, shortcutModifiers } = await tsImport("../../viewer/src/utils/held-modifiers.ts", import.meta.url);
const { SHORTCUTS } = await tsImport("../../viewer/src/utils/shortcuts.ts", import.meta.url);

const held = (keys) => ({ shift: false, ctrl: false, meta: false, alt: false, ...keys });

test("holding a chord's modifiers shows the key that completes it; anything else shows nothing", () => {
  assert.equal(heldKeyHint(SHORTCUTS.canvasByNumber.map, held({ ctrl: true }), true), "1");
  assert.equal(heldKeyHint(SHORTCUTS.canvasByNumber.compare, held({ ctrl: true }), true), "3");
  assert.equal(heldKeyHint(SHORTCUTS.camera.fit, held({ shift: true }), true), "1");
  assert.equal(heldKeyHint(SHORTCUTS.appearance.app, held({ shift: true }), true), "T");
  assert.equal(heldKeyHint(SHORTCUTS.canvasByNumber.map, held({ shift: true }), true), undefined, "the wrong modifier");
  assert.equal(heldKeyHint(SHORTCUTS.canvasByNumber.map, held({ ctrl: true, shift: true }), true), undefined, "an extra modifier");
  assert.equal(heldKeyHint(SHORTCUTS.canvas.map, held({ ctrl: true }), true), undefined, "a plain key has no chord");
  assert.equal(heldKeyHint(SHORTCUTS.canvasByNumber.map, held({}), true), undefined, "nothing held");
});

test("mod is ⌘ on Apple keyboards and Ctrl elsewhere", () => {
  assert.equal(heldKeyHint(SHORTCUTS.app.search, held({ meta: true }), true), "K");
  assert.equal(heldKeyHint(SHORTCUTS.app.search, held({ ctrl: true }), true), undefined);
  assert.equal(heldKeyHint(SHORTCUTS.app.search, held({ ctrl: true }), false), "K");
  assert.equal(heldKeyHint(SHORTCUTS.app.search, held({ meta: true }), false), undefined);
  assert.deepEqual(shortcutModifiers(SHORTCUTS.app.search, true), held({ meta: true }));
  assert.deepEqual(shortcutModifiers(SHORTCUTS.app.search, false), held({ ctrl: true }));
});
