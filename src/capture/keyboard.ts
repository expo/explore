/**
 * The system software keyboard in a controller snapshot (agent-device's flat `nodes`, which the Argent bridge also
 * returns), and how long capture waits for it. Recognition is deliberately narrow: dropping one of the app's own elements
 * hides a real change, which is worse than the keyboard noise this removes. A node is the keyboard's only when it, or a
 * node above it, provably belongs to the system keyboard; nothing is inferred from where an element sits on the screen,
 * and a `Key` alone proves nothing (React Native's `accessibilityRole="keyboardkey"` gives an app's PIN pad that type).
 */

type Rect = { x: number; y: number; width: number; height: number };
type SnapshotNode = Record<string, unknown>;

/** Android input methods: their windows name the IME's package, not the app's. */
export const INPUT_METHOD_PACKAGES: ReadonlySet<string> = new Set([
  "com.google.android.inputmethod.latin",
  "com.android.inputmethod.latin",
  "com.samsung.android.honeyboard",
  "com.touchtype.swiftkey",
  "com.microsoft.swiftkey",
]);

/**
 * UIKit's identifiers for the input view placeholder and the prediction bar. They mark a window as the keyboard's (see
 * the Argent bridge's `keyboardWindows`); inside the app's own window an element with one of them is the app's.
 */
export const KEYBOARD_WINDOW_IDENTIFIERS: ReadonlySet<string> = new Set(["inputView", "SystemInputAssistantView"]);

/**
 * The keyboard's native view classes, which agent-device's host accessibility bridge reports as `role`. The dock's Emoji
 * and Dictate buttons (UIKeyboardDockItemButton) can sit outside the key plane's bounds, so they are named here.
 */
const KEYBOARD_VIEW_CLASSES = new Set(["UIKeyboardDockItemButton", "UIAccessibilityElementKBKey", "UIKeyboardLayoutStar",
  "TUIPredictionView", "TUIPredictionViewCell", "_UIRemoteKeyboardPlaceholderView", "TUISystemInputAssistantView",
  "TUISystemInputAssistantPageView"]);

const EDITABLE_TYPES = new Set(["textfield", "securetextfield", "searchfield", "textview"]);

const text = (value: unknown) => typeof value === "string" ? value : "";

function rectOf(node: SnapshotNode): Rect | undefined {
  const rect = node.rect as Partial<Rect> | undefined;
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width! > 0 && rect.height! > 0 ? rect as Rect : undefined;
}

/**
 * A node that belongs to the system keyboard by what it is, not where it is: XCTest's `Keyboard` element (both
 * controllers), a node of a window the Argent bridge found to be the keyboard's (`systemKeyboard`), one of the keyboard's
 * native view classes, or a node of an Android input method's window.
 */
function keyboardRoot(node: SnapshotNode): boolean {
  return node.systemKeyboard === true || text(node.type).toLowerCase() === "keyboard" || KEYBOARD_VIEW_CLASSES.has(text(node.role))
    || INPUT_METHOD_PACKAGES.has(text(node.bundleId ?? node.packageName ?? node.package));
}

/** Every node that belongs to the system keyboard: those `keyboardRoot` names and the nodes beneath them. */
export function keyboardNodes(nodes: readonly SnapshotNode[]): Set<SnapshotNode> {
  const owned = new Set<SnapshotNode>();
  if (!nodes.some(keyboardRoot)) return owned;
  // Only an explicit parent links a node to a keyboard above it: a node without one is no node's descendant.
  const byIndex = new Map(nodes.filter(node => typeof node.index === "number").map(node => [node.index as number, node]));
  for (const node of nodes) {
    const seen = new Set<SnapshotNode>();
    for (let current: SnapshotNode | undefined = node; current && !seen.has(current);
      current = typeof current.parentIndex === "number" ? byIndex.get(current.parentIndex) : undefined) {
      seen.add(current);
      if (keyboardRoot(current)) { owned.add(node); break; }
    }
  }
  return owned;
}

function union(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

/**
 * Where the visible keyboard is, from the nodes that span it (the `Keyboard` element, the keyboard window's input view and
 * prediction bar, the native views, an input method's window), or undefined when none shows. Containers inside the
 * keyboard can report a scroll extent past the screen, so not every node it owns counts.
 */
export function keyboardBounds(nodes: readonly SnapshotNode[]): Rect | undefined {
  return union(nodes.filter(node => node.visible !== false && keyboardRoot(node) && (node.systemKeyboard !== true
    || text(node.type).toLowerCase() === "keyboard" || KEYBOARD_WINDOW_IDENTIFIERS.has(text(node.identifier)))).flatMap(node => rectOf(node) ?? []));
}

/**
 * A text input that has the keyboard focus: agent-device reports `focused` from XCTest's keyboard focus and Android's
 * focused flag; the Argent bridge passes on Argent's own.
 */
export function focusedTextInput(nodes: readonly SnapshotNode[]): boolean {
  return nodes.some(node => node.focused === true && node.visible !== false
    && (EDITABLE_TYPES.has(text(node.type).toLowerCase()) || /EditText$/.test(text(node.type)) || node.editable === true));
}

/** A snapshot as the wait reads it: Argent also says whether a keyboard shows, which its Android tree cannot. */
export type KeyboardRead = { nodes: readonly SnapshotNode[]; keyboardVisible?: boolean };

/** Where the keyboard is in one read: its bounds, or only that one shows when the controller cannot place it. */
function keyboardPosition(read: KeyboardRead): string | undefined {
  const bounds = keyboardBounds(read.nodes);
  return bounds ? JSON.stringify(bounds) : read.keyboardVisible === true ? "visible" : undefined;
}

/**
 * How capture waits for a focused field's keyboard. Reads are 250 ms apart at most, and at least two follow the first,
 * so a controller whose snapshot takes a second or more still sees the keyboard rise. Waiting for a keyboard that has not
 * appeared ends after a second; one that has appeared but has not yet held still is read until it does, up to six reads
 * or four seconds, so a slow controller cannot keep the capture waiting.
 */
export const KEYBOARD_POLL_MS = 250;
const KEYBOARD_WAIT_MS = 1_000;
const KEYBOARD_CAP_MS = 4_000;
const KEYBOARD_MIN_READS = 2;
const KEYBOARD_MAX_READS = 6;

export type KeyboardSettle = {
  /** `shown`: in the same place in two reads running. `unfocused`: the field let go and no keyboard shows. */
  readonly outcome: "shown" | "moving" | "absent" | "unfocused";
  readonly reads: number;
  /** Whether to read the screen again, `elapsedMs` after the first read. */
  more(elapsedMs: number): boolean;
  read(next: KeyboardRead): void;
};

/**
 * The wait for a screen whose text field has the focus, or undefined when none has it. A keyboard already up counts only
 * once a later read finds it in the same place: one caught rising or going down is still moving.
 */
export function keyboardSettle(first: KeyboardRead): KeyboardSettle | undefined {
  if (!focusedTextInput(first.nodes)) return undefined;
  let previous = keyboardPosition(first), reads = 0;
  let outcome: KeyboardSettle["outcome"] = previous ? "moving" : "absent";
  return {
    get outcome() { return outcome; },
    get reads() { return reads; },
    more: elapsedMs => (outcome === "moving" || outcome === "absent") && reads < KEYBOARD_MAX_READS
      && (reads < KEYBOARD_MIN_READS || (elapsedMs < KEYBOARD_CAP_MS && (outcome === "moving" || elapsedMs < KEYBOARD_WAIT_MS))),
    read: next => {
      reads += 1;
      const position = keyboardPosition(next);
      outcome = position && position === previous ? "shown" : position ? "moving" : focusedTextInput(next.nodes) ? "absent" : "unfocused";
      previous = position;
    },
  };
}
