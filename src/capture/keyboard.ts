/**
 * The software keyboard in a controller snapshot (agent-device's flat `nodes`, which the Argent bridge also returns),
 * recognised by structure rather than by what its keys say, which changes with the keyboard's language.
 */

type Rect = { x: number; y: number; width: number; height: number };
type SnapshotNode = Record<string, unknown>;

/** Android input methods: their windows name the IME's package, not the app's. */
export const INPUT_METHOD_PACKAGES: ReadonlySet<string> = new Set([
  "com.google.android.inputmethod.latin",
  "com.samsung.android.honeyboard",
  "com.touchtype.swiftkey",
  "com.microsoft.swiftkey",
]);

/**
 * UIKit's own identifiers for the keyboard's parts, as Argent's iOS tree reports them: the placeholder iOS leaves in the
 * app's window where the keyboard sits (`inputView`), the prediction bar, and the key plane.
 */
const KEYBOARD_IDENTIFIERS = new Set(["inputView", "SystemInputAssistantView", "UIKeyboardLayoutStar Preview"]);

/** The keyboard's native view classes, which agent-device's host accessibility bridge reports as `role`. */
const KEYBOARD_VIEW_CLASSES = new Set(["UIKeyboardDockItemButton", "UIAccessibilityElementKBKey", "UIKeyboardLayoutStar",
  "TUIPredictionView", "TUIPredictionViewCell", "_UIRemoteKeyboardPlaceholderView", "TUISystemInputAssistantView",
  "TUISystemInputAssistantPageView"]);

/** XCTest's element types for the keyboard and its keys, which both controllers report as `type`. */
const KEYBOARD_TYPES = new Set(["keyboard", "key"]);

const EDITABLE_TYPES = new Set(["textfield", "securetextfield", "searchfield", "textview"]);

const text = (value: unknown) => typeof value === "string" ? value : "";

function rectOf(node: SnapshotNode): Rect | undefined {
  const rect = node.rect as Partial<Rect> | undefined;
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width! > 0 && rect.height! > 0 ? rect as Rect : undefined;
}

/** A node that is itself part of the keyboard, before its containers and the controls beside it are added. */
function keyboardPart(node: SnapshotNode): boolean {
  return KEYBOARD_TYPES.has(text(node.type).toLowerCase()) || KEYBOARD_IDENTIFIERS.has(text(node.identifier))
    || KEYBOARD_VIEW_CLASSES.has(text(node.role)) || INPUT_METHOD_PACKAGES.has(text(node.bundleId ?? node.packageName ?? node.package));
}

function union(rects: readonly Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

const within = (inner: Rect, outer: Rect) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;

/**
 * Every node that belongs to the software keyboard. Beyond the parts `keyboardPart` names, iOS draws the keyboard in its
 * own window: the containers around those parts, and the controls beside them, lie wholly inside the keyboard's bounds.
 * So each part's outermost container still inside those bounds belongs to it, and so does every sibling of such a
 * container that is also inside them, with everything beneath. That is how the Emoji and Dictate buttons are found: on
 * iOS 26 under Argent they sit in an unnamed container beside the key plane (brentvatne/euxy#172, review run 39362642343).
 */
export function keyboardNodes(nodes: readonly SnapshotNode[]): Set<SnapshotNode> {
  const parts = nodes.filter(keyboardPart);
  if (!parts.length) return new Set();
  const byIndex = new Map(nodes.map((node, position) => [typeof node.index === "number" ? node.index : position, node]));
  const parentOf = (node: SnapshotNode) => typeof node.parentIndex === "number" ? byIndex.get(node.parentIndex) : undefined;
  const bounds = union(parts.flatMap(node => rectOf(node) ?? []));
  const inside = (node: SnapshotNode) => { const rect = rectOf(node); return !!rect && !!bounds && within(rect, bounds); };
  const containers = new Set<SnapshotNode>(parts);
  for (const part of parts) {
    let container = part;
    for (let parent = parentOf(container); parent && inside(parent); parent = parentOf(parent)) container = parent;
    containers.add(container);
    const parent = parentOf(container);
    for (const sibling of nodes) if (sibling !== container && parentOf(sibling) === parent && inside(sibling)) containers.add(sibling);
  }
  const owned = new Set<SnapshotNode>();
  for (const node of nodes) {
    const seen = new Set<SnapshotNode>();
    for (let current: SnapshotNode | undefined = node; current && !seen.has(current); current = parentOf(current)) {
      seen.add(current);
      if (containers.has(current)) { owned.add(node); break; }
    }
  }
  return owned;
}

/**
 * Where the visible software keyboard is, from its named parts (a container inside it can report a scroll extent past
 * the screen), or undefined when none shows.
 */
export function keyboardBounds(nodes: readonly SnapshotNode[]): Rect | undefined {
  return union(nodes.filter(node => node.visible !== false && keyboardPart(node)).flatMap(node => rectOf(node) ?? []));
}

/**
 * A text input that has the keyboard focus: agent-device reports `focused` from XCTest's keyboard focus and Android's
 * focused flag; the Argent bridge passes on Argent's own.
 */
export function focusedTextInput(nodes: readonly SnapshotNode[]): boolean {
  return nodes.some(node => node.focused === true && node.visible !== false
    && (EDITABLE_TYPES.has(text(node.type).toLowerCase()) || /EditText$/.test(text(node.type)) || node.editable === true));
}
