import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { snapshotFromTree } = await tsImport("../../src/capture/argent-driver.ts", import.meta.url);
const { focusedTextInput, keyboardBounds, keyboardNodes } = await tsImport("../../src/capture/keyboard.ts", import.meta.url);
const { parseControllerOutput } = await tsImport("../../src/capture/controller-output.ts", import.meta.url);

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/argent-0.29/${name}`, import.meta.url), "utf8"));
// euxy's rename sheet on iOS 26 under Argent 0.29, its field focused and the keyboard up: the head of brentvatne/euxy#172
// (review run 39362642343). The root holds three windows: the app's, the input view placeholder's, and the keyboard's.
const RENAME_KEYBOARD_UP = fixture("fixture-ios-ui-tree-rename.json");
// The same sheet a moment earlier, as the base was captured: the field focused and its cursor showing, no keyboard yet.
const RENAME_KEYBOARD_DOWN = { ...RENAME_KEYBOARD_UP, keyboardVisible: false,
  roots: [{ ...RENAME_KEYBOARD_UP.roots[0], children: RENAME_KEYBOARD_UP.roots[0].children.slice(0, 1) }] };
const ANDROID_RENAME = fixture("fixture-android-ui-tree-rename.json");

const nodesOf = tree => snapshotFromTree(tree, "ios", 1).nodes;
const labelsOf = nodes => parseControllerOutput("agent-device", JSON.stringify({ success: true, data: { nodes } })).elements.map(element => element.label);

test("the iOS keyboard Argent reports is recognised by its structure: its parts, their containers and the controls beside them", () => {
  const nodes = nodesOf(RENAME_KEYBOARD_UP);
  assert.deepEqual(keyboardBounds(nodes), { x: 0, y: 539, width: 402, height: 335 }, "the input view and prediction bar down to the bottom edge");
  const owned = [...keyboardNodes(nodes)].map(node => node.label ?? node.identifier).filter(Boolean);
  for (const name of ["inputView", "SystemInputAssistantView", "Typing Predictions", "Q", "shift", "Emoji", "Dictate"]) assert.ok(owned.includes(name), name);
  // The app's own elements behind the keyboard's band are not the keyboard's.
  for (const name of ["AdditionalDimmingOverlay", "Tab Bar", "Sequencer", "Hear the lanes from this phone when no device is connected.", "Name", "Clear name"]) {
    assert.equal(owned.includes(name), false, name);
  }
});

test("the text field with the focus is passed on from Argent, and a focused field without a keyboard is told apart", () => {
  const up = nodesOf(RENAME_KEYBOARD_UP), down = nodesOf(RENAME_KEYBOARD_DOWN);
  assert.equal(up.filter(node => node.focused === true).map(node => node.type).join(), "TextField");
  assert.equal(focusedTextInput(up), true);
  assert.equal(focusedTextInput(down), true);
  assert.equal(keyboardBounds(down), undefined);
  assert.equal(keyboardNodes(down).size, 0);
  assert.equal(focusedTextInput(nodesOf(fixture("fixture-ios-ui-tree-home.json"))), false);
});

test("a keyboard up on one side only leaves the elements the review compares unchanged", () => {
  // In euxy#172 the review led with "Added button “Dictate”", “Emoji” and “inputView” over the label change.
  const up = labelsOf(nodesOf(RENAME_KEYBOARD_UP)), down = labelsOf(nodesOf(RENAME_KEYBOARD_DOWN));
  assert.deepEqual(up, down);
  for (const name of ["Dictate", "Emoji", "inputView", "Q"]) assert.equal(up.includes(name), false, name);
  assert.ok(up.includes("Rename Pattern") && up.includes("Clear name"));
});

test("agent-device's keyboard is recognised by its element types and its host bridge's view classes, never by labels", () => {
  const xctest = [
    { index: 0, type: "Application", rect: { x: 0, y: 0, width: 402, height: 874 } },
    { index: 1, parentIndex: 0, type: "TextField", label: "Pattern name", focused: true, rect: { x: 23, y: 386, width: 355, height: 50 } },
    { index: 2, parentIndex: 0, type: "Keyboard", rect: { x: 0, y: 583, width: 402, height: 233 } },
    { index: 3, parentIndex: 2, type: "Key", label: "Q", rect: { x: 5, y: 590, width: 39, height: 54 } },
    { index: 4, parentIndex: 0, type: "Button", label: "Emoji", rect: { x: 8, y: 300, width: 68, height: 40 } },
  ];
  assert.deepEqual(keyboardBounds(xctest), { x: 0, y: 583, width: 402, height: 233 });
  assert.deepEqual(labelsOf(xctest), ["Pattern name", "Emoji"], "an app button named Emoji outside the keyboard is the app's");
  const hostBridge = [
    { type: "TextField", role: "RCTUITextField", label: "Pattern name", focused: true, rect: { x: 23, y: 386, width: 355, height: 50 } },
    { type: "Button", role: "UIKeyboardDockItemButton", label: "Dictate", rect: { x: 325, y: 806, width: 68, height: 68 } },
    { type: "Other", role: "UIAccessibilityElementKBKey", label: "Q", rect: { x: 5, y: 590, width: 39, height: 54 } },
  ];
  assert.ok(keyboardBounds(hostBridge));
  assert.deepEqual(labelsOf(hostBridge), ["Pattern name"]);
  // A hardware keyboard: the field has the focus, and no keyboard is drawn.
  assert.equal(keyboardBounds(xctest.filter(node => !["Keyboard", "Key"].includes(node.type))), undefined);
});

test("an Android input method's window is the keyboard under Argent, as it is under agent-device", () => {
  const ime = { role: "FrameLayout", type: "android.widget.FrameLayout", bundleId: "com.google.android.inputmethod.latin", frame: { x: 0, y: 0.6, width: 1, height: 0.4 },
    children: [{ role: "Button", type: "android.widget.Button", contentDescription: "q", frame: { x: 0.01, y: 0.65, width: 0.09, height: 0.06 }, children: [] }] };
  const before = snapshotFromTree(ANDROID_RENAME, "android", 1, "dev.brent.euxy").nodes;
  const after = snapshotFromTree({ ...ANDROID_RENAME, keyboardVisible: true, roots: [...ANDROID_RENAME.roots, ime] }, "android", 1, "dev.brent.euxy").nodes;
  assert.equal(focusedTextInput(before), true, "Argent marks the focused EditText");
  assert.equal(keyboardBounds(before), undefined);
  assert.deepEqual(keyboardBounds(after), { x: 0, y: 960, width: 720, height: 640 });
  assert.deepEqual(labelsOf(after), labelsOf(before));
});
