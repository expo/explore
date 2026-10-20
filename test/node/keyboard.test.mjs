import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { snapshotFromTree } = await tsImport("../../src/capture/argent-driver.ts", import.meta.url);
const { focusedTextInput, keyboardBounds, keyboardNodes, keyboardSettle } = await tsImport("../../src/capture/keyboard.ts", import.meta.url);
const { parseControllerOutput } = await tsImport("../../src/capture/controller-output.ts", import.meta.url);
const { normalizeSnapshot } = await tsImport("../../src/map/store.ts", import.meta.url);

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/argent-0.29/${name}`, import.meta.url), "utf8"));
// euxy's rename sheet on iOS 26 under Argent 0.29, its field focused and the keyboard up: the head of brentvatne/euxy#172
// (review run 39362642343). Its root holds three windows: the app's, the input view placeholder's, and the keyboard's.
const RENAME_KEYBOARD_UP = fixture("fixture-ios-ui-tree-rename.json");
// The same sheet a moment earlier, as the base was captured: the field focused and its cursor showing, no keyboard yet.
const RENAME_KEYBOARD_DOWN = { ...RENAME_KEYBOARD_UP, keyboardVisible: false,
  roots: [{ ...RENAME_KEYBOARD_UP.roots[0], children: RENAME_KEYBOARD_UP.roots[0].children.slice(0, 1) }] };
const ANDROID_RENAME = fixture("fixture-android-ui-tree-rename.json");

const nodesOf = tree => snapshotFromTree(tree, "ios", 1).nodes;
const labelsOf = nodes => parseControllerOutput("agent-device", JSON.stringify({ success: true, data: { nodes } })).elements.map(element => element.label);
const nameOf = node => node.label ?? node.identifier;
const rect = (x, y, width, height) => ({ x, y, width, height });

test("the iOS keyboard Argent reports is its own windows: the input view placeholder's and the keyboard's, Emoji and Dictate included", () => {
  const nodes = nodesOf(RENAME_KEYBOARD_UP);
  assert.deepEqual(keyboardBounds(nodes), rect(0, 539, 402, 335), "the input view and prediction bar down to the bottom edge");
  const owned = [...keyboardNodes(nodes)];
  const names = owned.map(nameOf).filter(Boolean);
  for (const name of ["inputView", "SystemInputAssistantView", "Typing Predictions", "Q", "shift", "Emoji", "Dictate"]) assert.ok(names.includes(name), name);
  assert.ok(owned.every(node => node.systemKeyboard === true), "only nodes of the keyboard's windows");
  // Every element of the app's window stays, those behind the keyboard's band among them.
  const app = nodesOf(RENAME_KEYBOARD_DOWN).map(nameOf).filter(Boolean);
  for (const name of app) assert.ok(nodes.some(node => nameOf(node) === name && !keyboardNodes(nodes).has(node)), name);
  assert.ok(app.includes("AdditionalDimmingOverlay") && app.includes("Tab Bar") && app.includes("Clear name"));
});

test("a keyboard up on one side only leaves the elements and the accessibility fingerprint unchanged", () => {
  // In euxy#172 the review led with "Added button “Dictate”", “Emoji” and “inputView” over the label change.
  const up = nodesOf(RENAME_KEYBOARD_UP), down = nodesOf(RENAME_KEYBOARD_DOWN);
  assert.deepEqual(labelsOf(up), labelsOf(down));
  for (const name of ["Dictate", "Emoji", "inputView", "Q"]) assert.equal(labelsOf(up).includes(name), false, name);
  // The bridge numbers nodes in order, so the app's own nodes keep their indices when the keyboard's windows follow them.
  const snapshot = nodes => JSON.stringify({ success: true, data: { nodes: nodes.map(({ ref: _ref, ...node }) => node) } });
  assert.equal(normalizeSnapshot(snapshot(up)), normalizeSnapshot(snapshot(down)));
});

test("the text field with the focus is passed on from Argent", () => {
  const up = nodesOf(RENAME_KEYBOARD_UP), down = nodesOf(RENAME_KEYBOARD_DOWN);
  assert.equal(up.filter(node => node.focused === true).map(node => node.type).join(), "TextField");
  assert.equal(focusedTextInput(up), true);
  assert.equal(focusedTextInput(down), true);
  assert.equal(keyboardBounds(down), undefined);
  assert.equal(focusedTextInput(nodesOf(fixture("fixture-ios-ui-tree-home.json"))), false);
});

test("an element the app identifies as inputView in its own window is the app's", () => {
  // A chat composer with testID="inputView", no keyboard up.
  const app = RENAME_KEYBOARD_DOWN.roots[0].children[0];
  const composer = { role: "AXGroup", type: "Other", identifier: "inputView", frame: rect(0, 0.8, 1, 0.1),
    children: [{ role: "AXButton", type: "Button", label: "Send", frame: rect(0.8, 0.82, 0.15, 0.05), children: [] }] };
  const tree = { ...RENAME_KEYBOARD_DOWN, roots: [{ ...RENAME_KEYBOARD_DOWN.roots[0], children: [{ ...app, children: [...app.children, composer] }] }] };
  const nodes = nodesOf(tree);
  assert.equal(keyboardNodes(nodes).size, 0);
  assert.equal(keyboardBounds(nodes), undefined);
  assert.ok(labelsOf(nodes).includes("inputView") && labelsOf(nodes).includes("Send"));
});

test("agent-device's keyboard is its Keyboard element and what is under it, and its host bridge's keyboard view classes", () => {
  // XCTest: the Keyboard directly under the Application, beside the app's own controls in the same band.
  const xctest = [
    { index: 0, type: "Application", label: "Example", rect: rect(0, 0, 402, 874) },
    { index: 1, parentIndex: 0, type: "TextField", label: "Pattern name", focused: true, rect: rect(23, 386, 355, 50) },
    { index: 2, parentIndex: 0, type: "Keyboard", rect: rect(0, 583, 402, 233) },
    { index: 3, parentIndex: 2, type: "Key", label: "Q", rect: rect(5, 590, 39, 54) },
    { index: 4, parentIndex: 0, type: "Button", label: "Home tab", rect: rect(0, 800, 134, 74) },
    { index: 5, parentIndex: 0, type: "Other", label: "Formatting toolbar", rect: rect(0, 540, 402, 43) },
    { index: 6, parentIndex: 0, type: "Button", label: "Emoji", rect: rect(8, 300, 68, 40) },
  ];
  assert.deepEqual(keyboardBounds(xctest), rect(0, 583, 402, 233));
  assert.deepEqual(labelsOf(xctest), ["Example", "Pattern name", "Home tab", "Formatting toolbar", "Emoji"]);
  // The host bridge names the dock's buttons by class, wherever they sit.
  const hostBridge = [
    { type: "TextField", role: "RCTUITextField", label: "Pattern name", focused: true, rect: rect(23, 386, 355, 50) },
    { type: "Button", role: "UIKeyboardDockItemButton", label: "Dictate", rect: rect(325, 806, 68, 68) },
    { type: "Other", role: "UIAccessibilityElementKBKey", label: "Q", rect: rect(5, 590, 39, 54) },
    { type: "Button", role: "RCTViewComponentView", label: "Profile tab", rect: rect(268, 800, 134, 74) },
  ];
  assert.ok(keyboardBounds(hostBridge));
  assert.deepEqual(labelsOf(hostBridge), ["Pattern name", "Profile tab"]);
});

test("nothing without a parent link is taken for the keyboard's, and keys alone are no keyboard", () => {
  // agent-device's flat shape: no parentIndex. The Keyboard element goes; nothing can be proven to be under it.
  const flat = [
    { type: "Keyboard", rect: rect(0, 583, 402, 233) },
    { type: "Key", label: "Q", rect: rect(5, 590, 39, 54) },
    { type: "Button", label: "Profile tab", rect: rect(268, 800, 134, 74) },
  ];
  assert.deepEqual(labelsOf(flat), ["Q", "Profile tab"]);
  // An app's own PIN pad (accessibilityRole="keyboardkey") and its footer action, with no system keyboard up.
  const pinPad = [
    { index: 0, type: "Application", label: "Example", rect: rect(0, 0, 402, 874) },
    { index: 1, parentIndex: 0, type: "SecureTextField", label: "PIN", focused: true, rect: rect(23, 200, 355, 50) },
    ...["1", "2", "3"].map((digit, offset) => ({ index: 2 + offset, parentIndex: 0, type: "Key", label: digit, rect: rect(offset * 134, 600, 134, 70) })),
    { index: 5, parentIndex: 0, type: "Button", label: "App footer action", rect: rect(0, 800, 402, 74) },
  ];
  assert.equal(keyboardNodes(pinPad).size, 0);
  assert.equal(keyboardBounds(pinPad), undefined);
  assert.deepEqual(labelsOf(pinPad), ["Example", "PIN", "1", "2", "3", "App footer action"]);
});

test("in landscape the keyboard is told apart the same way, the app's bottom bar kept", () => {
  const landscape = [
    { index: 0, type: "Application", label: "Example", rect: rect(0, 0, 874, 402) },
    { index: 1, parentIndex: 0, type: "TextField", label: "Search", focused: true, rect: rect(100, 60, 674, 40) },
    { index: 2, parentIndex: 0, type: "Keyboard", rect: rect(0, 230, 874, 172) },
    { index: 3, parentIndex: 2, type: "Key", label: "Q", rect: rect(60, 236, 70, 38) },
    { index: 4, parentIndex: 0, type: "TabBar", label: "Tab Bar", rect: rect(0, 352, 874, 50) },
  ];
  assert.deepEqual(keyboardBounds(landscape), rect(0, 230, 874, 172));
  assert.deepEqual(labelsOf(landscape), ["Example", "Search", "Tab Bar"]);
});

test("an Android input method's window is the keyboard under Argent, AOSP's included, and Argent says when one shows", () => {
  const ime = pkg => ({ role: "FrameLayout", type: "android.widget.FrameLayout", bundleId: pkg, frame: rect(0, 0.6, 1, 0.4),
    children: [{ role: "Button", type: "android.widget.Button", contentDescription: "q", frame: rect(0.01, 0.65, 0.09, 0.06), children: [] }] });
  const before = snapshotFromTree(ANDROID_RENAME, "android", 1, "dev.brent.euxy").nodes;
  assert.equal(focusedTextInput(before), true, "Argent marks the focused EditText");
  assert.equal(keyboardBounds(before), undefined);
  for (const pkg of ["com.google.android.inputmethod.latin", "com.android.inputmethod.latin"]) {
    const after = snapshotFromTree({ ...ANDROID_RENAME, keyboardVisible: true, roots: [...ANDROID_RENAME.roots, ime(pkg)] }, "android", 1, "dev.brent.euxy").nodes;
    assert.deepEqual(keyboardBounds(after), rect(0, 960, 720, 640), pkg);
    assert.deepEqual(labelsOf(after), labelsOf(before), pkg);
  }
});

test("the wait reads until the keyboard is in one place twice, at least twice, at most six times", () => {
  const field = { type: "TextField", label: "Pattern name", focused: true, rect: rect(23, 386, 355, 50) };
  const keyboardAt = y => [field, { index: 9, type: "Keyboard", rect: rect(0, y, 402, 874 - y) }];
  // Already up when the screen was read: one more read must find it in the same place.
  const up = keyboardSettle({ nodes: keyboardAt(583) });
  assert.equal(up.more(0), true, "a keyboard already up may still be rising");
  up.read({ nodes: keyboardAt(583) });
  assert.deepEqual([up.outcome, up.reads, up.more(250)], ["shown", 1, false]);
  // Caught rising: it moves between reads, then holds.
  const rising = keyboardSettle({ nodes: [field] });
  for (const y of [700, 583, 583]) rising.read({ nodes: keyboardAt(y) });
  assert.deepEqual([rising.outcome, rising.reads], ["shown", 3]);
  // A slow controller: the second read is owed even after a second has passed.
  const slow = keyboardSettle({ nodes: [field] });
  slow.read({ nodes: [field] });
  assert.equal(slow.more(2_500), true);
  slow.read({ nodes: [field] });
  assert.deepEqual([slow.outcome, slow.more(5_000)], ["absent", false], "no keyboard came: captured without one");
  // Six reads at most, however fast they come.
  const busy = keyboardSettle({ nodes: [field] });
  for (let read = 0; busy.more(0); read++) busy.read({ nodes: keyboardAt(read % 2 ? 583 : 700) });
  assert.deepEqual([busy.outcome, busy.reads], ["moving", 6]);
  // The field let go and no keyboard shows: nothing more to wait for.
  const released = keyboardSettle({ nodes: [field] });
  released.read({ nodes: [{ ...field, focused: false }] });
  assert.deepEqual([released.outcome, released.more(0)], ["unfocused", false]);
  // Argent on Android says a keyboard shows without placing it: it shows twice running.
  const android = keyboardSettle({ nodes: [field] });
  android.read({ nodes: [field], keyboardVisible: true });
  android.read({ nodes: [field], keyboardVisible: true });
  assert.equal(android.outcome, "shown");
  assert.equal(keyboardSettle({ nodes: [{ ...field, focused: false }] }), undefined, "a screen without a focused field is not waited on");
});
