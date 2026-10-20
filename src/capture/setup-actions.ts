import { CiError } from "../shared/ci-errors.js";
import { captureObserverMarkers, parseCaptureDestination } from "./observer.js";
import type { CaptureSetupAction, CaptureSetupReady, CaptureSetupSelector } from "../config/explore-config.js";

export type CaptureSetupSnapshot = {
  nodes: readonly Record<string, unknown>[];
  refsGeneration?: number;
  truncated?: boolean;
  /** Whether the controller says a software keyboard shows, when it says (Argent does). */
  keyboardVisible?: boolean;
};

type Awaitable<T> = T | Promise<T>;

export type CaptureSetupOptions = {
  /** Owns controller identity, JSON envelope validation, and the overall action/time budget. */
  command: (args: string[]) => Awaitable<unknown>;
  /** Owns app URL validation, controller identity, and narrowly handled OS Open confirmations. */
  open: (url: string) => Awaitable<unknown>;
  snapshot: () => Awaitable<CaptureSetupSnapshot>;
  /** Runs before each action is dispatched. */
  beforeAction?: (event: { index: number; action: CaptureSetupAction }) => void;
  /** Runs after readiness succeeds, or immediately after an action without ready; deduplicate captures by route. */
  afterAction?: (event: { index: number; action: CaptureSetupAction; snapshot: CaptureSetupSnapshot }) => Awaitable<void>;
  /** Defaults to 20 snapshots, separated by 250 ms; also bounded by command's shared budget. */
  readinessAttempts?: number;
  pollMilliseconds?: number;
  /** Caller observes after dispatch. Explicit readiness and afterAction evidence are still collected. */
  postActionObservation?: "executor" | "caller";
};

const INPUT_TYPES = new Set(["textfield", "securetextfield", "textview", "searchfield"]);
const TAP_TYPES = new Map([ ["button", 0], ["link", 0], ["switch", 0], ["cell", 1], ["other", 2], ["statictext", 3] ]);
/** Android exposes View class names where iOS exposes element types; both resolve to the iOS vocabulary. */
const ANDROID_TYPES = new Map([
  ["android.widget.edittext", "textfield"], ["android.widget.autocompletetextview", "textfield"],
  ["android.widget.multiautocompletetextview", "textfield"], ["android.widget.searchview", "searchfield"],
  ["android.widget.button", "button"], ["android.widget.imagebutton", "button"], ["android.widget.switch", "switch"],
  ["android.widget.checkbox", "switch"], ["android.widget.togglebutton", "switch"], ["android.widget.textview", "statictext"],
]);

function controlType(node: Record<string, unknown>): string {
  const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
  return ANDROID_TYPES.get(type) ?? (type.startsWith("android.") ? "other" : type);
}

export type CaptureInputFocus = { selector: { key: "label" | "identifier"; value: string }; type: string; destination: string };

function focusDestination(snapshot: CaptureSetupSnapshot): string | undefined {
  const markers = captureObserverMarkers(snapshot.nodes);
  const destination = markers.length === 1 ? parseCaptureDestination(markers[0]!.label) : null;
  return destination ? JSON.stringify(destination) : undefined;
}

/** Records an explicit focus attempt, not an assertion about iOS's first responder or field contents. */
export function captureInputFocus(selector: CaptureSetupSelector, snapshot: CaptureSetupSnapshot): CaptureInputFocus | undefined {
  const key = selector.identifier === undefined ? "label" : "identifier";
  const value = selector[key];
  const matches = snapshot.nodes.filter(node => node[key] === value && node.visible !== false
    && node.enabled !== false && INPUT_TYPES.has(controlType(node)));
  const destination = focusDestination(snapshot);
  if (matches.length === 1 && value && destination) return { selector: { key, value }, type: String(matches[0]!.type), destination };
}

function inputFocusMatches(intent: CaptureInputFocus | undefined, snapshot: CaptureSetupSnapshot): boolean {
  if (!intent || focusDestination(snapshot) !== intent.destination) return false;
  const matches = snapshot.nodes.filter(node => node[intent.selector.key] === intent.selector.value && node.visible !== false
    && node.enabled !== false && INPUT_TYPES.has(controlType(node)));
  return matches.length === 1 && matches[0]!.type === intent.type
    && !snapshot.nodes.some(node => node.type === "Alert" && node.visible !== false);
}

export function canTypeAfterFocus(intent: CaptureInputFocus | undefined, snapshot: CaptureSetupSnapshot): boolean {
  return inputFocusMatches(intent, snapshot) && keyboardFrame(snapshot.nodes) !== undefined;
}

/**
 * Older controllers report one Keyboard element; agent-device 0.21.15 reports only its
 * Key elements, which its own occlusion check also treats as the keyboard.
 */
export function isKeyboardNode(node: Record<string, unknown>): boolean {
  const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
  return (type === "keyboard" || type === "key") && node.visible !== false;
}

/** Bounds of the visible software keyboard, from the elements isKeyboardNode accepts. */
export function keyboardFrame(nodes: readonly Record<string, unknown>[]): Rect | undefined {
  const rects = nodes.flatMap(node => {
    const rect = isKeyboardNode(node) ? nodeRect(node) : undefined;
    return rect && rect.width > 0 && rect.height > 0 ? [rect] : [];
  });
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

function failure(code: string, message: string, details?: Record<string, unknown>): CiError {
  return new CiError({ code, stage: "setup", message,
    nextAction: "Check the UI prerequisite and its exact accessibility label or identifier. Use an enabled, unambiguous control and rerun capture.",
    ...(details ? { details } : {}) });
}

export const SETUP_SELECTOR_MAX = 256;

/** A label or identifier the executor can select by; a replay plan's selectors are checked against it before any device starts. */
export function isSetupSelector(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= SETUP_SELECTOR_MAX && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Text the executor can fill or type: one line of at most 4,096 characters. */
export function isSetupInput(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096 && !/[\u0000\r\n]/.test(value);
}

function selectorValue(selector: CaptureSetupSelector): { key: "label" | "identifier"; value: string } {
  const hasLabel = typeof selector.label === "string";
  const hasIdentifier = typeof selector.identifier === "string";
  const key = hasLabel ? "label" : "identifier";
  const value = selector[key];
  if (hasLabel === hasIdentifier || !isSetupSelector(value)) {
    throw failure("SETUP_SELECTOR_INVALID", "A UI selector must contain exactly one nonempty label or identifier.");
  }
  return { key, value };
}

function matchingNodes(snapshot: CaptureSetupSnapshot, selector: CaptureSetupSelector): Record<string, unknown>[] {
  const { key, value } = selectorValue(selector);
  return snapshot.nodes.filter(node => node[key] === value && node.visible !== false);
}

/**
 * iOS offers to save or update a submitted password in its own prompt, depending on the
 * simulator's AutoFill state. Explore never stores credentials, so capture declines it for every
 * app instead of each config scripting an optional tap. Returns the Not Now button to press.
 */
export function credentialSavePromptDecline(nodes: readonly Record<string, unknown>[]): Record<string, unknown> | undefined {
  const visible = nodes.filter(node => node.visible !== false);
  if (!visible.some(node => typeof node.label === "string" && /^(?:Save|Update) Password\?$/.test(node.label))) return undefined;
  const buttons = visible.filter(node => String(node.type).toLowerCase() === "button" && node.label === "Not Now" && node.enabled !== false);
  return buttons.length === 1 && typeof buttons[0]!.ref === "string" ? buttons[0] : undefined;
}

/**
 * agent-device could not read the surface in front of the app. iOS 26 hosts the Save Password
 * prompt in com.apple.SafariViewService, and only agent-device's XCTest snapshot tiers can read it;
 * after a slow accessibility read agent-device defers those tiers for the app for 120 s, and the
 * snapshot then fails with "requires a valid viewport". Waiting out the deferral makes the prompt
 * readable again, so capture can decline it as usual.
 */
export function isUnreadableSystemSurface(error: unknown): boolean {
  if (!(error instanceof CiError) || error.code !== "COMMAND_FAILED") return false;
  const text = `${error.message}\n${error.nextAction ?? ""}`;
  return /requires a valid viewport/i.test(text) || /XCTest-backed snapshot tiers were deferred/i.test(text)
    || /com\.apple\.SafariViewService hosts the surface/i.test(text);
}

/** Whether a snapshot satisfies a setup action's readiness condition. */
export function setupReadinessHolds(snapshot: CaptureSetupSnapshot, ready: CaptureSetupReady): boolean {
  return matchingNodes(snapshot, ready).some(node => ready.enabled === undefined || node.enabled === ready.enabled);
}

function checkedSnapshot(snapshot: CaptureSetupSnapshot): CaptureSetupSnapshot {
  if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 20_000 || snapshot.truncated === true
    || snapshot.nodes.some(node => node === null || typeof node !== "object" || Array.isArray(node))) {
    throw failure("SETUP_SNAPSHOT_INVALID", "UI setup requires a complete accessibility snapshot.");
  }
  return snapshot;
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height && (outer.width > inner.width || outer.height > inner.height);
}

function selectControl(snapshot: CaptureSetupSnapshot, selector: CaptureSetupSelector, action: "tap" | "fill"): Record<string, unknown> | undefined {
  const matches = matchingNodes(snapshot, selector);
  // iOS exposes a child's label on its container; pressing that container taps its center, not the child.
  const wrapper = (node: Record<string, unknown>): boolean => {
    const outer = controlType(node) === "other" ? nodeRect(node) : undefined;
    return !!outer && matches.some(other => {
      const inner = other !== node ? nodeRect(other) : undefined;
      return !!inner && contains(outer, inner);
    });
  };
  const candidates = matches.filter(node => !wrapper(node)).flatMap(node => {
    const type = controlType(node);
    // An explicit tap can focus an input; prefer the field over its label or container.
    const rank = INPUT_TYPES.has(type) ? 0 : action === "tap" ? TAP_TYPES.get(type) : undefined;
    return rank === undefined ? [] : [{ node, rank }];
  });
  if (!candidates.length) return undefined;
  const rank = Math.min(...candidates.map(candidate => candidate.rank));
  // Nested React Native Text is exposed twice with the same type and frame. One press
  // point hits both, so identical copies are one control; keep the innermost (last) one.
  const geometry = (node: Record<string, unknown>) => { const rect = nodeRect(node); return rect ? JSON.stringify([node.type, rect.x, rect.y, rect.width, rect.height]) : undefined; };
  const best = candidates.filter(candidate => candidate.rank === rank).filter((candidate, index, all) => {
    const key = geometry(candidate.node);
    return !key || !all.slice(index + 1).some(other => geometry(other.node) === key);
  });
  if (best.length !== 1) {
    throw failure("SETUP_SELECTOR_AMBIGUOUS", "The UI selector matches more than one control of the same kind.",
      { selector: selectorValue(selector), matches: best.length });
  }
  // Real iOS AX snapshots can mark visible app controls hittable:false. Native execution
  // must decide whether a press works; enabled:false is an explicit prerequisite failure.
  return best[0]!.node.enabled === false ? undefined : best[0]!.node;
}

type Rect = { x: number; y: number; width: number; height: number };

function nodeRect(node: Record<string, unknown>): Rect | undefined {
  const rect = node.rect as Partial<Rect> | undefined;
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ? rect as Rect : undefined;
}

/** Tapping or focusing an input under the software keyboard can hit a key instead of the control. */
function keyboardCovers(snapshot: CaptureSetupSnapshot, control: Record<string, unknown>): boolean {
  const target = nodeRect(control);
  if (!target) return false;
  const keyboard = keyboardFrame(snapshot.nodes);
  if (!keyboard) return false;
  // iOS reports the prediction strip separately, above the keyboard's key area.
  // Use its observed bounds only while a keyboard is present, without padding guesses.
  const parts = [keyboard, ...snapshot.nodes.flatMap(node => {
    const rect = node.identifier === "SystemInputAssistantView" && node.visible !== false ? nodeRect(node) : undefined;
    return rect ? [rect] : [];
  })];
  return parts.some(rect => rect.width > 0 && rect.height > 0
    && target.x < rect.x + rect.width && rect.x < target.x + target.width
    && target.y < rect.y + rect.height && rect.y < target.y + target.height);
}

/** Labels that differ from the selector only in case, spacing, or punctuation. */
function similarValues(snapshot: CaptureSetupSnapshot, selector: { key: "label" | "identifier"; value: string }): string[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const wanted = normalize(selector.value);
  if (!wanted) return [];
  const values = snapshot.nodes.flatMap(node => {
    const value = node[selector.key];
    return typeof value === "string" && value !== selector.value && value.length <= 256 && normalize(value) === wanted ? [value] : [];
  });
  return [...new Set(values)].sort().slice(0, 5);
}

function pinnedRef(snapshot: CaptureSetupSnapshot, node: Record<string, unknown>): string {
  if (!Number.isSafeInteger(snapshot.refsGeneration) || snapshot.refsGeneration! < 1
    || typeof node.ref !== "string" || !/^@?e\d+$/.test(node.ref)) {
    throw failure("SETUP_REFERENCE_UNAVAILABLE", "The controller did not return a fresh, generation-pinned reference for the UI control.");
  }
  return `@${node.ref.replace(/^@/, "")}~s${snapshot.refsGeneration}`;
}

/** Execute explicit UI input without restarting the app or writing its internal state. */
/** A setup action for a log line: its kind and target, never the text it enters. */
export function describeSetupAction(action: CaptureSetupAction): string {
  const target = (selector: CaptureSetupSelector) => selector.identifier !== undefined ? `identifier ${selector.identifier}` : `label "${selector.label}"`;
  const ready = action.ready ? `, until ${action.ready.identifier !== undefined ? `identifier ${action.ready.identifier}` : `label "${action.ready.label}"`}${action.ready.enabled ? " is enabled" : " appears"}` : "";
  switch (action.action) {
    case "open": return `open ${action.url}${ready}`;
    case "tap": return `tap ${target(action)}${ready}`;
    case "fill": return `fill ${target(action)}${ready}`;
    case "type": return `type into the focused input${ready}`;
    case "scroll": return `scroll ${action.direction}${ready}`;
    case "wait": return `wait ${action.milliseconds} ms${ready}`;
  }
}

export async function executeCaptureSetup(actions: readonly CaptureSetupAction[], options: CaptureSetupOptions): Promise<void> {
  const attempts = options.readinessAttempts ?? 20;
  const pollMilliseconds = options.pollMilliseconds ?? 250;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120
    || !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 1 || pollMilliseconds > 1_000
    || !Array.isArray(actions) || actions.length > 100) {
    throw failure("SETUP_LIMIT_INVALID", "UI setup limits must be bounded: at most 100 actions, 1–120 snapshots, and 1–1,000 ms between snapshots.");
  }
  const snapshot = async () => checkedSnapshot(await options.snapshot());
  const poll = async () => { await options.command(["wait", String(pollMilliseconds), "--level", "full", "--json"]); };
  let focusIntent: CaptureInputFocus | undefined;
  for (const [index, action] of actions.entries()) {
    options.beforeAction?.({ index, action });
    const previousFocus = focusIntent;
    focusIntent = undefined;
    switch (action.action) {
      case "open":
        await options.open(action.url);
        break;
      case "tap":
      case "fill": {
        selectorValue(action);
        if (action.action === "fill" && !isSetupInput(action.text)) {
          throw failure("SETUP_INPUT_INVALID", "A UI fill input must be a single line of at most 4,096 characters.");
        }
        let resolved = false;
        let keyboardDismissed = false;
        let last: CaptureSetupSnapshot | undefined;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const current = last = await snapshot();
          const control = selectControl(current, action, action.action);
          if (control && keyboardCovers(current, control)) {
            if (keyboardDismissed) {
              throw new CiError({ code: "SETUP_KEYBOARD_BLOCKING", stage: "setup",
                message: "The software keyboard still covers the UI control after it was dismissed.",
                nextAction: "Make the control reachable while the keyboard is open, or give the input a Done/return control that closes the keyboard, and rerun capture.",
                details: { index, selector: selectorValue(action) } });
            }
            try { await options.command(["keyboard", "dismiss", "--level", "full", "--json"]); }
            catch (error) {
              throw new CiError({ code: "SETUP_KEYBOARD_BLOCKING", stage: "setup",
                message: "The software keyboard covers the UI control and could not be dismissed.",
                nextAction: "Give the input a Done/return control that closes the keyboard, or make the control reachable while the keyboard is open, and rerun capture.",
                details: { index, selector: selectorValue(action) }, cause: error });
            }
            // Re-select from a fresh snapshot: the layout and reference generation change.
            keyboardDismissed = true;
            continue;
          }
          if (control) {
            const ref = pinnedRef(current, control);
            const nextFocus = action.action === "tap" ? captureInputFocus(action, current) : undefined;
            // Do not ask the controller to settle here: that can skip a transient destination.
            await options.command(action.action === "tap"
              ? ["press", ref, "--level", "full", "--json"]
              : ["fill", ref, action.text, "--level", "full", "--json"]);
            focusIntent = nextFocus;
            resolved = true;
            break;
          }
          if (attempt + 1 < attempts) await poll();
        }
        if (!resolved) {
          const selector = selectorValue(action);
          const similar = last ? similarValues(last, selector) : [];
          if (similar.length) {
            throw new CiError({ code: "SETUP_CONTROL_NOT_READY", stage: "setup",
              message: `The requested UI control did not become available. The screen has a similar ${selector.key}: ${similar.map(value => JSON.stringify(value)).join(", ")}.`,
              nextAction: `Use the exact ${selector.key} shown on screen in the setup step and rerun capture.`,
              details: { index, action: action.action, selector, similar } });
          }
          throw failure("SETUP_CONTROL_NOT_READY", "The requested UI control did not become available and enabled within the setup budget.",
            { index, action: action.action, selector });
        }
        break;
      }
      case "type": {
        if (!isSetupInput(action.text) || !action.text) {
          throw failure("SETUP_INPUT_INVALID", "A UI type input must be a nonempty single line of at most 4,096 characters.");
        }
        let ready = false;
        for (let attempt = 0; previousFocus && attempt < attempts; attempt++) {
          const current = await snapshot();
          if (!inputFocusMatches(previousFocus, current)) break;
          if (canTypeAfterFocus(previousFocus, current)) { ready = true; break; }
          if (attempt + 1 < attempts) await poll();
        }
        if (!ready) {
          throw failure("SETUP_TYPE_FOCUS_REQUIRED", "Type requires an immediately preceding input tap, the same observed input and route, and a visible keyboard without an alert.", { index });
        }
        // Append once; a failed command can already have changed the input. Never replay it.
        await options.command(["type", action.text, "--level", "full", "--json"]);
        break;
      }
      case "scroll":
        if (!["up", "down", "left", "right", "top", "bottom"].includes(action.direction)) {
          throw failure("SETUP_SCROLL_INVALID", "The setup scroll direction is invalid.");
        }
        await options.command(["scroll", action.direction, "--level", "full", "--json"]);
        break;
      case "wait":
        if (!Number.isSafeInteger(action.milliseconds) || action.milliseconds < 1 || action.milliseconds > 30_000) {
          throw failure("SETUP_WAIT_INVALID", "A setup wait must be between 1 and 30,000 milliseconds.");
        }
        await options.command(["wait", String(action.milliseconds), "--level", "full", "--json"]);
        break;
      default:
        throw failure("SETUP_ACTION_INVALID", "The UI setup action is unsupported.");
    }
    // Agent actions return fresh accessibility through their tool response. Do not
    // duplicate that read or relabel a completed mutation as a failed dispatch.
    if (options.postActionObservation === "caller" && !action.ready && !options.afterAction) continue;
    let current = await snapshot();
    if (action.ready) {
      let ready = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        ready = setupReadinessHolds(current, action.ready);
        if (ready) break;
        if (attempt + 1 < attempts) {
          await poll();
          current = await snapshot();
        }
      }
      if (!ready) throw failure("SETUP_READINESS_TIMEOUT", "The requested UI readiness condition did not appear within the setup budget.",
        { index, selector: selectorValue(action.ready) });
    }
    if (focusIntent && !inputFocusMatches(focusIntent, current)) focusIntent = undefined;
    await options.afterAction?.({ index, action, snapshot: current });
  }
}
