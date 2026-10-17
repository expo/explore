/**
 * Translates the agent-device commands Explore sends into Argent tool calls, and Argent's answers into
 * agent-device's JSON envelopes, so capture, setup, the agent tool host and black-box exploration drive
 * either controller without knowing which one runs. Pure: the Argent call, the clock and file moves are
 * injected, so the translation is tested against recorded Argent output.
 */
import { CONTROLLER_SESSION } from "./common.js";
import type { DecodedFrame } from "../shared/png-evidence.js";

export type ArgentPlatform = "ios" | "android";

/** One `argent run <tool>` call. `sent: false` means the request provably never reached the tool-server. */
export class ArgentCallError extends Error {
  constructor(message: string, readonly sent: boolean) { super(message); }
}

export type ArgentCall = (tool: string, args: Record<string, unknown>, options?: { out?: string }) => Promise<unknown>;

type Rect = { x: number; y: number; width: number; height: number };

/** What the bridge keeps between commands, in the per-run state file. */
export type ArgentBridgeState = {
  udid?: string;
  model?: string;
  osVersion?: string;
  /** The coordinate space of the last tree: points on iOS, pixels on Android, as agent-device reports them. */
  screen?: { width: number; height: number };
  generation: number;
  refs?: Record<string, { rect: Rect; type?: string; value?: string; secure?: boolean }>;
  /** iOS asks "Open in “<app>”?" for the first custom-scheme link of a session; later links open directly. */
  deepLinkPromptAccepted?: boolean;
  recording?: string;
};

export type ArgentBridgeContext = {
  call: ArgentCall;
  state: ArgentBridgeState;
  platform: ArgentPlatform;
  /** The app under test when the caller names it outside the command (explore:binary's `install`). */
  bundleId?: string;
  version: string;
  sleep: (milliseconds: number) => Promise<void>;
  /** Moves a file the Argent client downloaded (a screen recording) to where Explore asked for it. */
  moveFile: (from: string, to: string) => Promise<void>;
  /** Whether the tool-server answers, checked before a UI action is sent (see `remoteUnavailable`). */
  reachable: () => Promise<boolean>;
  /** A file the bridge may overwrite with a screenshot, and a reader for it (the link-prompt fallback). */
  scratchImage?: { path: string; read: (path: string) => Promise<DecodedFrame> };
};

export type BridgeResult = { exitCode: number; stdout: string };

const success = (data: Record<string, unknown>): BridgeResult => ({ exitCode: 0, stdout: JSON.stringify({ success: true, data }) });
const failure = (code: string, message: string, details?: Record<string, unknown>): BridgeResult =>
  ({ exitCode: 1, stdout: JSON.stringify({ success: false, error: { code, message, ...(details ? { details } : {}) } }) });

/**
 * agent-device's answer when its pre-flight health check fails, which Explore resends because the command was
 * provably never sent (controller.ts remoteDaemonUnavailable). The bridge gives it only on the same proof.
 */
const remoteUnavailable = () => failure("COMMAND_FAILED", "Remote daemon is unavailable");

/** Flags agent-device takes after a command; the bridge needs the platform only from its own context. */
const VALUE_FLAGS = new Set(["--session", "--device", "--platform", "--level", "--udid", "--scope", "--bundle-id", "--serial", "--timeout"]);
const BOOLEAN_FLAGS = new Set(["--json", "--relaunch", "--normalize-status-bar", "--force-full", "--in-app", "--system"]);

export function parseCommand(argv: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--") { positional.push(...argv.slice(index + 1)); break; }
    if (VALUE_FLAGS.has(value)) { flags[value.slice(2)] = argv[index + 1] ?? ""; index++; continue; }
    if (BOOLEAN_FLAGS.has(value)) { flags[value.slice(2)] = true; continue; }
    positional.push(value);
  }
  return { positional, flags };
}

type ArgentNode = { role?: string; type?: string; label?: string; identifier?: string; value?: string; contentDescription?: string; disabled?: boolean;
  frame?: Rect; traits?: string[]; hidden?: boolean; selected?: boolean; password?: boolean; bundleId?: string; children?: ArgentNode[] };
export type ArgentTree = { schemaVersion?: number; source?: string; screen?: { width: number; height: number }; roots?: ArgentNode[];
  truncated?: boolean; alertVisible?: boolean; keyboardVisible?: boolean; foregroundApp?: string };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Android widget classes as agent-device names their element types. */
function agentDeviceType(node: ArgentNode, platform: ArgentPlatform): string {
  const type = node.type ?? node.role ?? "Other";
  if (node.password) return "SecureTextField";
  if (platform === "ios") return type;
  const simple = type.split(".").pop() ?? type;
  if (/EditText|TextInput/.test(simple)) return "TextField";
  if (/Button$|ImageButton|CheckBox|Switch|RadioButton/.test(simple)) return simple.endsWith("Button") ? "Button" : simple;
  if (/TextView/.test(simple)) return "StaticText";
  if (/ImageView/.test(simple)) return "Image";
  if (/ScrollView|RecyclerView|ListView/.test(simple)) return "ScrollView";
  return simple || "Other";
}

/**
 * The tree as agent-device's snapshot: the app's root (an `Application` node sized to the screen) and every
 * element on or near the screen, in the units agent-device uses (points on iOS, pixels on Android), with
 * refs pinned to this snapshot's generation. Elements Argent lists twice (iOS AX does) appear once.
 */
export function snapshotFromTree(tree: ArgentTree, platform: ArgentPlatform, generation: number, bundleId?: string) {
  const screen = tree.screen;
  if (!screen || !finite(screen.width) || !finite(screen.height) || screen.width <= 0 || screen.height <= 0) {
    throw new Error("ui-tree did not report the screen size");
  }
  const app = bundleId ?? tree.foregroundApp;
  // Android's status bar and navigation (com.android.systemui) are not part of the app; a dialog another package draws
  // over it (a runtime permission prompt) is, because it covers the app and setup has to answer it.
  const roots = (tree.roots ?? []).filter(root => platform === "ios" || root.bundleId !== ANDROID_SYSTEM_UI);
  const nodes: Record<string, unknown>[] = [];
  const refs: NonNullable<ArgentBridgeState["refs"]> = {};
  const seen = new Set<string>();
  const toPoints = (frame: Rect): Rect => ({ x: frame.x * screen.width, y: frame.y * screen.height, width: frame.width * screen.width, height: frame.height * screen.height });
  /**
   * iOS visibility, as Argent computes it (a node is hidden when its frame misses every ancestor's frame), except that a
   * root clips to the whole screen. On iPhone Duo's inner display Argent 0.29 reports the app root as the top-left third
   * of the screen ([0, 0, 0.333, 0.333], its 3x scale applied twice), which hid everything outside that third: a sheet's
   * title and its Cancel button among them. Android's `hidden` is the system's own visible-to-user flag and is kept.
   */
  const clipOf = (node: ArgentNode, clip: Rect | undefined, root: boolean): Rect | undefined => {
    if (root || !node.frame || ![node.frame.x, node.frame.y, node.frame.width, node.frame.height].every(finite)) return clip;
    return clip && intersect(node.frame, clip);
  };
  const visit = (node: ArgentNode, depth: number, parentIndex: number | undefined, appRoot: boolean, clip: Rect | undefined, root: boolean) => {
    const frame = node.frame;
    const inner = clipOf(node, clip, root);
    const rect = frame && [frame.x, frame.y, frame.width, frame.height].every(finite) ? toPoints(frame) : undefined;
    const onScreen = !!rect && rect.x < screen.width && rect.y < screen.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
    const type = appRoot ? "Application" : agentDeviceType(node, platform);
    const label = node.label ?? node.contentDescription;
    const key = JSON.stringify([type, label, node.identifier, node.value, rect && [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]]);
    let index = parentIndex;
    // Off-screen content stays out, as agent-device leaves it out; its parents still come through for depth.
    if (rect && (onScreen || appRoot) && !seen.has(key)) {
      seen.add(key);
      index = nodes.length;
      const ref = `e${index + 1}`;
      const traits = node.traits ?? [];
      // iOS marks a disabled element with the notEnabled trait, Android with disabled.
      const enabled = !traits.includes("notEnabled") && node.disabled !== true;
      const visible = platform === "ios" ? !!inner : node.hidden !== true;
      nodes.push({ depth, index, ...(parentIndex === undefined ? {} : { parentIndex }), type, ref,
        rect: appRoot ? { x: 0, y: 0, width: screen.width, height: screen.height } : rect,
        ...(label ? { label } : {}), ...(node.identifier ? { identifier: node.identifier } : {}),
        ...(node.value !== undefined ? { value: node.value } : {}), enabled, hittable: enabled && visible && !appRoot,
        ...(visible ? {} : { visible: false }), ...(node.selected || traits.includes("selected") ? { selected: true } : {}) });
      refs[ref] = { rect: appRoot ? { x: 0, y: 0, width: screen.width, height: screen.height } : rect, type,
        ...(node.value !== undefined ? { value: node.value } : {}), ...(type === "SecureTextField" ? { secure: true } : {}) };
    }
    for (const child of node.children ?? []) visit(child, depth + 1, index, false, inner, false);
  };
  for (const root of roots) {
    const isAppRoot = platform === "ios" ? root.type === "Application" || nodes.length === 0 : root.bundleId === app;
    visit(root, 0, undefined, isAppRoot, { x: 0, y: 0, width: 1, height: 1 }, true);
  }
  return { nodes, refs, screen: { width: screen.width, height: screen.height } };
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

const centre = (rect: Rect, screen: { width: number; height: number }) =>
  ({ x: (rect.x + rect.width / 2) / screen.width, y: (rect.y + rect.height / 2) / screen.height });

/**
 * Argent read nothing: exactly one bare root and no foreground app, which is what iOS 27.1 gives while the link prompt
 * is up. A read that returned no roots at all is a failed read, not this state.
 */
function blindTree(tree: ArgentTree): boolean {
  const roots = tree.roots ?? [];
  return !tree.foregroundApp && roots.length === 1 && (roots[0]!.children ?? []).length === 0 && !roots[0]!.label && !roots[0]!.type;
}

/** A tree with the app's root and something in it: what a relaunch must reach before the app is usable. */
function appReady(tree: ArgentTree, bundleId: string): boolean {
  if (tree.foregroundApp !== bundleId) return false;
  const count = (node: ArgentNode): number => 1 + (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
  return (tree.roots ?? []).some(root => count(root) > 1);
}

function flatten(tree: ArgentTree): ArgentNode[] {
  const nodes: ArgentNode[] = [];
  const walk = (node: ArgentNode) => { nodes.push(node); (node.children ?? []).forEach(walk); };
  (tree.roots ?? []).forEach(walk);
  return nodes;
}

/** iOS: `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `26.5`. */
export function iosRuntimeVersion(runtime: unknown): string | undefined {
  const match = typeof runtime === "string" ? /iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtime) : null;
  return match ? [match[1], match[2], match[3]].filter(Boolean).join(".") : undefined;
}

const DEEP_LINK_PROMPT_CONFIRM = { dxPoints: 74, dyPoints: 37 };
const KEYBOARD_DISMISS_LABELS = ["Hide keyboard", "Dismiss keyboard", "Done"];
// A keyboard covers the lower part of the screen; its keys start below this share of the height.
const KEYBOARD_TOP = 0.4;
const ALERT_PREFERRED_BUTTONS = ["Open", "OK", "Allow", "Allow While Using App", "Continue"];
const READ_TOOLS = new Set(["ui-tree", "list-devices", "screenshot", "foreground-app", "await-screen-idle", "describe"]);
const SPRINGBOARD = "com.apple.springboard";
const ANDROID_SYSTEM_UI = "com.android.systemui";
const OPEN_IN_APP_PROMPT = /^Open in “.+”\?$/;

/**
 * iOS's "Open in “<app>”?" link prompt, recognized by its own text. Argent 0.29 does not always flag it as an alert
 * (on iOS 27.1, iPhone Duo, `alertVisible` stays false while SpringBoard shows it), and another alert must never be
 * taken for it: the bridge presses this prompt's Open on its own.
 */
export function openInAppPromptShowing(tree: ArgentTree): boolean {
  return flatten(tree).some(node => OPEN_IN_APP_PROMPT.test(node.label ?? ""));
}

/** Any system alert in front of the app: one Argent flags, or the link prompt it does not. */
function alertShowing(tree: ArgentTree): boolean {
  return tree.alertVisible === true || (tree.foregroundApp === SPRINGBOARD && openInAppPromptShowing(tree));
}

/**
 * The link prompt's Open button found in a screenshot: the largest wide, filled system-blue shape in the middle of the
 * screen, as iOS 26 and 27 draw it. Used only when Argent cannot read the screen at all while the prompt is up.
 */
export function findOpenButton(frame: DecodedFrame): { x: number; y: number } | undefined {
  const step = Math.max(1, Math.round(frame.width / 200));
  const columns = Math.floor(frame.width / step), rows = Math.floor(frame.height / step);
  const top = Math.floor(rows * 0.2), bottom = Math.ceil(rows * 0.8);
  const blue = new Uint8Array(columns * rows);
  for (let row = top; row < bottom; row++) for (let column = 0; column < columns; column++) {
    const offset = (row * step * frame.width + column * step) * 4;
    const [red, green, blueValue] = [frame.data[offset]!, frame.data[offset + 1]!, frame.data[offset + 2]!];
    if (red < 70 && green > 90 && green < 170 && blueValue > 200) blue[row * columns + column] = 1;
  }
  let best: { cells: number; left: number; right: number; top: number; bottom: number } | undefined;
  const seen = new Uint8Array(columns * rows);
  for (let start = 0; start < blue.length; start++) {
    if (!blue[start] || seen[start]) continue;
    const shape = { cells: 0, left: columns, right: 0, top: rows, bottom: 0 };
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const cell = queue.pop()!;
      const row = Math.floor(cell / columns), column = cell % columns;
      shape.cells++;
      shape.left = Math.min(shape.left, column); shape.right = Math.max(shape.right, column);
      shape.top = Math.min(shape.top, row); shape.bottom = Math.max(shape.bottom, row);
      for (const next of [cell - 1, cell + 1, cell - columns, cell + columns]) {
        if (next < 0 || next >= blue.length || seen[next] || !blue[next]) continue;
        if (Math.abs((next % columns) - column) > 1) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    const width = shape.right - shape.left + 1, height = shape.bottom - shape.top + 1;
    // A dialog button: wide, a few percent of the screen tall, and well under its full width.
    if (width < columns * 0.15 || width > columns * 0.6 || width < height * 1.5 || height < rows * 0.03 || height > rows * 0.12) continue;
    if (!best || shape.cells > best.cells) best = shape;
  }
  if (!best) return undefined;
  return { x: ((best.left + best.right + 1) / 2) / columns, y: ((best.top + best.bottom + 1) / 2) / rows };
}

/**
 * The prompt's Open button from `describe`. On iOS 27.1 (iPhone Duo) `ui-tree` reports SpringBoard's frames with
 * x and y swapped, while `describe` reads them correctly, so the button is located there.
 */
export function describedButton(description: unknown, label: string): Rect | undefined {
  if (typeof description !== "string") return undefined;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only a whole line Argent printed counts, so an app label that spells out a button line cannot be picked.
  const match = new RegExp(`^\\s*AXButton "${escaped}"\\s+\\(([\\d.]+), ([\\d.]+), ([\\d.]+), ([\\d.]+)\\)\\s*$`, "m").exec(description);
  if (!match) return undefined;
  const [x, y, width, height] = match.slice(1).map(Number) as [number, number, number, number];
  return [x, y, width, height].every(finite) && width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

/** Runs one agent-device command against Argent and answers as agent-device would. */
export async function runBridgeCommand(argv: readonly string[], context: ArgentBridgeContext): Promise<BridgeResult> {
  const { state, platform } = context;
  if (argv[0] === "--version") return { exitCode: 0, stdout: `${context.version}\n` };
  const [command, ...rest] = argv;
  const { positional, flags } = parseCommand(rest);
  const bundleFlag = typeof flags["bundle-id"] === "string" ? flags["bundle-id"] : context.bundleId;

  /** Reads are resent after a transport failure (they change nothing); a UI action is sent once, after a health check. */
  const call = async (tool: string, args: Record<string, unknown> = {}, options?: { out?: string }): Promise<Record<string, unknown>> => {
    const withDevice = tool === "list-devices" ? args : { udid: state.udid, ...args };
    for (let attempt = 0; ; attempt++) {
      try { return record(await context.call(tool, withDevice, options)); }
      catch (error) {
        if (READ_TOOLS.has(tool) && attempt < 2) { await context.sleep(1_000 * (attempt + 1)); continue; }
        throw error;
      }
    }
  };
  const tree = async (): Promise<ArgentTree> => (await call("ui-tree")) as ArgentTree;
  const ensureDevice = async () => {
    if (state.udid) return;
    let devices: Record<string, unknown>[] = [];
    // A tool-server that has just started can list no devices at all for its first call; that is not an answer.
    for (let attempt = 0; attempt < 3; attempt++) {
      const listed = await call("list-devices");
      const all = Array.isArray(listed.devices) ? listed.devices : [];
      devices = all.map(record).filter(device => device.platform === platform
        && (platform === "ios" ? device.state === "Booted" && device.runtimeKind !== "tv" : device.state === "device" && device.runtimeKind !== "tv"));
      if (all.length) break;
      await context.sleep(2_000);
    }
    if (devices.length !== 1) throw new BridgeFailure("DEVICE_UNAVAILABLE", `Argent lists ${devices.length} booted ${platform} devices on this session; Explore drives exactly one.`);
    const device = devices[0]!;
    const udid = platform === "ios" ? device.udid : device.serial;
    if (typeof udid !== "string" || !udid) throw new BridgeFailure("DEVICE_UNAVAILABLE", "Argent did not name the booted device.");
    state.udid = udid;
    state.model = String(platform === "ios" ? device.name : device.model ?? device.avdName ?? udid);
    const version = platform === "ios" ? iosRuntimeVersion(device.runtime) : undefined;
    if (version) state.osVersion = version;
  };
  /** Relaunches until the app's tree is readable: an EAS simulator Argent did not boot needs a relaunch first. */
  const relaunch = async (bundleId: string) => {
    for (let restart = 0; restart < 2; restart++) {
      await call("restart-app", { bundleId });
      for (let poll = 0; poll < 12; poll++) {
        await context.sleep(1_000);
        if (appReady(await tree(), bundleId)) return;
      }
    }
    throw new BridgeFailure("APP_NOT_READY", `${bundleId} did not come up with a readable accessibility tree after relaunching.`);
  };
  const deviceEnvelope = (bundleId: string) => ({ session: CONTROLLER_SESSION, appBundleId: bundleId, platform, target: "mobile",
    device: { platform, target: "mobile", name: state.model, id: state.udid, ...(state.osVersion ? { osVersion: state.osVersion } : {}) },
    identifiers: { session: CONTROLLER_SESSION, appBundleId: bundleId, deviceName: state.model, deviceId: state.udid } });
  const screen = async () => {
    if (!state.screen) { const current = await tree(); if (current.screen) state.screen = { ...current.screen }; }
    if (!state.screen) throw new BridgeFailure("COMMAND_FAILED", "The screen size is not known yet.");
    return state.screen;
  };
  const tap = async (x: number, y: number) => { await call("gesture-tap", { x, y }); };
  const resolveRef = (value: string) => {
    const match = /^@?(e\d+)(?:~s(\d+))?$/.exec(value);
    if (!match) throw new BridgeFailure("INVALID_ARGS", `Not an element reference: ${value}`);
    if (match[2] && Number(match[2]) !== state.generation) throw new BridgeFailure("COMMAND_FAILED", `Element reference ${value} is stale; take a new snapshot.`);
    const target = state.refs?.[match[1]!];
    if (!target) throw new BridgeFailure("COMMAND_FAILED", `Element reference ${value} is not in the last snapshot.`);
    return target;
  };
  /**
   * A UI action is only sent when the tool-server answers first, so a failure after this point is never resent. A
   * session's tool-server can still be starting when EAS reports the session ready, so it is given about 25 s to answer.
   */
  const beforeAction = async () => {
    for (const delay of [1_000, 2_000, 3_000, 4_000, 5_000, 5_000, 5_000]) {
      if (await context.reachable()) return;
      await context.sleep(delay);
    }
    if (!await context.reachable()) throw new UnsentFailure();
  };

  try {
    switch (command) {
      case "open": {
        await ensureDevice();
        const target = positional.length === 2 ? { bundleId: positional[0]!, url: positional[1]! }
          : positional.length === 1 && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(positional[0]!) ? { url: positional[0]! } : { bundleId: positional[0] };
        if (target.url) {
          await beforeAction();
          await call("open-url", { url: target.url });
          if (platform === "ios" && !state.deepLinkPromptAccepted) await acceptDeepLinkPrompt(target.bundleId ?? bundleFlag);
          return success({ ...(target.bundleId ? deviceEnvelope(target.bundleId) : { session: CONTROLLER_SESSION }), url: target.url });
        }
        const bundleId = target.bundleId ?? bundleFlag;
        if (!bundleId) throw new BridgeFailure("INVALID_ARGS", "open needs a bundle identifier or a URL.");
        // agent-device's plain open brings a running app forward and keeps its state; only --relaunch restarts it.
        if (flags.relaunch !== true && appReady(await tree(), bundleId)) return success({ ...deviceEnvelope(bundleId), appName: bundleId });
        await beforeAction();
        await relaunch(bundleId);
        return success({ ...deviceEnvelope(bundleId), appName: bundleId });
      }
      case "snapshot": {
        await ensureDevice();
        const current = await tree();
        state.generation += 1;
        const converted = snapshotFromTree(current, platform, state.generation, bundleFlag);
        state.refs = converted.refs;
        state.screen = converted.screen;
        const dialog = platform === "android" ? readAlert(current) : undefined;
        if (dialog && !converted.nodes.some(node => node.type === "Alert")) {
          // An Android dialog from another package covers the app: report it as agent-device does, as an Alert.
          converted.nodes.push({ depth: 1, index: converted.nodes.length, parentIndex: 0, type: "Alert", ref: `e${converted.nodes.length + 1}`,
            rect: { x: 0, y: 0, width: converted.screen.width, height: converted.screen.height }, label: dialog.message || "System dialog", enabled: true, hittable: false });
        } else if (platform === "ios" && alertShowing(current) && !converted.nodes.some(node => node.type === "Alert")
          && !(bundleFlag && appReady(current, bundleFlag))) {
          // A system alert (SpringBoard's) hides the app's tree; report it the way agent-device does, as an Alert node.
          converted.nodes.push({ depth: 1, index: converted.nodes.length, parentIndex: 0, type: "Alert", ref: `e${converted.nodes.length + 1}`,
            rect: { x: 0, y: 0, width: converted.screen.width, height: converted.screen.height }, label: "System alert", enabled: true, hittable: false });
        }
        return success({ nodes: converted.nodes, truncated: current.truncated === true, refsGeneration: state.generation,
          ...(current.foregroundApp ? { appBundleId: current.foregroundApp, appName: current.foregroundApp } : {}),
          snapshotQuality: { state: "healthy", backend: "argent" } });
      }
      case "appstate": {
        await ensureDevice();
        const current = await tree();
        const foreground = current.foregroundApp;
        return success({ ...(foreground ? { appBundleId: foreground, ...(platform === "android" ? { package: foreground } : {}) } : {}),
          session: CONTROLLER_SESSION, state: foreground ? "runningForeground" : "unknown", surface: foreground ? "app" : "home",
          device: { id: state.udid, name: state.model } });
      }
      case "alert": {
        await ensureDevice();
        const current = await tree();
        const alert = readAlert(current);
        if (positional[0] === "get") {
          if (!alert) return platform === "android" ? success({ platform: "android", alert: null }) : failure("COMMAND_FAILED", "alert not found");
          return platform === "android" ? success({ platform: "android", alert: { title: alert.message, buttons: alert.items } })
            : success({ message: alert.message, items: alert.items });
        }
        if (positional[0] === "accept" || positional[0] === "dismiss") {
          if (!alert) return failure("COMMAND_FAILED", "alert not found");
          const preferred = positional[0] === "dismiss"
            ? alert.buttons.find(button => /^(Cancel|Not Now|Don.t Allow|Dismiss)$/.test(button.label)) ?? alert.buttons[0]
            : ALERT_PREFERRED_BUTTONS.map(label => alert.buttons.find(button => button.label === label)).find(Boolean) ?? alert.buttons.at(-1);
          if (!preferred) return failure("COMMAND_FAILED", "The alert has no button to press.");
          await beforeAction();
          const size = current.screen ?? await screen();
          // describe places SpringBoard's buttons correctly where ui-tree may not (iOS 27.1); the tree is the fallback.
          const described = describedButton(await call("describe").then(value => value.description, () => undefined), preferred.label);
          await tap(...Object.values(described ? centre(described, { width: 1, height: 1 }) : centre(preferred.rect, size)) as [number, number]);
          await context.sleep(800);
          if (readAlert(await tree())) return failure("COMMAND_FAILED", "The alert is still showing after its button was pressed.");
          return success({ action: positional[0], button: preferred.label });
        }
        return failure("INVALID_ARGS", `Unsupported alert command: ${positional[0] ?? ""}`);
      }
      case "press": {
        await ensureDevice();
        const size = await screen();
        let point: { x: number; y: number };
        if (positional[0]?.startsWith("@") || /^e\d+/.test(positional[0] ?? "")) point = centre(resolveRef(positional[0]!).rect, size);
        else {
          const x = Number(positional[0]), y = Number(positional[1]);
          if (!finite(x) || !finite(y)) throw new BridgeFailure("INVALID_ARGS", "press needs an element reference or x and y.");
          point = { x: x / size.width, y: y / size.height };
        }
        await beforeAction();
        await tap(point.x, point.y);
        return success({ action: "press", x: point.x, y: point.y });
      }
      case "fill": {
        await ensureDevice();
        const target = resolveRef(positional[0] ?? "");
        const text = positional.slice(1).join(" ");
        rejectSecretPlaceholder(text);
        const size = await screen();
        await beforeAction();
        await tap(...Object.values(centre(target.rect, size)) as [number, number]);
        await context.sleep(400);
        if (platform === "android") {
          const filled = await call("fill", { text });
          if (filled.verified !== true) return failure("COMMAND_FAILED", "Argent could not verify the field's new text.");
          return success({ action: "fill" });
        }
        // Argent's iOS `fill` cannot see React Native's focused field, so the old text is erased and the new one typed.
        const erase = target.secure ? 64 : (target.value ?? "").length;
        if (erase > 0) {
          const erased = await call("run-sequence", { steps: Array.from({ length: erase }, () => ({ tool: "keyboard", args: { udid: state.udid, key: "backspace" } })) });
          // run-sequence answers normally when it stops partway; typing over half-erased text would leave a wrong value.
          if (erased.completed !== erased.total) return failure("COMMAND_FAILED", `Erasing the field stopped after ${String(erased.completed)} of ${String(erased.total)} keys; nothing was typed.`);
        }
        if (text) await call("keyboard", { text });
        if (!target.secure) {
          const after = flatten(await tree()).find(node => node.frame && Math.abs(node.frame.x * size.width - target.rect.x) < 2
            && Math.abs(node.frame.y * size.height - target.rect.y) < 2 && /TextField|EditText/.test(node.type ?? ""));
          if (after && (after.value ?? "") !== text) return failure("COMMAND_FAILED", "The field does not hold the requested text after typing it.");
        }
        return success({ action: "fill" });
      }
      case "type": {
        await ensureDevice();
        const text = positional.join(" ");
        rejectSecretPlaceholder(text);
        await beforeAction();
        await call("keyboard", { text });
        return success({ action: "type" });
      }
      case "keyboard": {
        if (positional[0] !== "dismiss") return failure("INVALID_ARGS", `Unsupported keyboard command: ${positional[0] ?? ""}`);
        await ensureDevice();
        const current = await tree();
        if (!current.keyboardVisible) return success({ platform, action: "dismiss", wasVisible: false, dismissed: false, visible: false });
        await beforeAction();
        if (platform === "android") await call("button", { button: "back" });
        else {
          // agent-device taps the keyboard's own dismiss control, and fails with this message when there is none, which
          // callers answer with the return key. Only a key in the keyboard's area counts: an app's "Done" above it is not one.
          const key = flatten(current).find(node => KEYBOARD_DISMISS_LABELS.includes(node.label ?? "") && node.frame && node.frame.y >= KEYBOARD_TOP);
          if (!key) return failure("COMMAND_FAILED", "Unable to dismiss the iOS keyboard: the keyboard exposes no dismiss control.");
          const size = current.screen ?? await screen();
          await tap(...Object.values(centre({ x: key.frame!.x * size.width, y: key.frame!.y * size.height,
            width: key.frame!.width * size.width, height: key.frame!.height * size.height }, size)) as [number, number]);
        }
        await context.sleep(500);
        const visible = (await tree()).keyboardVisible === true;
        if (visible && platform === "ios") return failure("COMMAND_FAILED", "Unable to dismiss the iOS keyboard: it is still showing after its dismiss key was pressed.");
        return success({ platform, action: "dismiss", wasVisible: true, dismissed: !visible, visible });
      }
      case "scroll": {
        await ensureDevice();
        const direction = positional[0] ?? "down";
        const vertical = direction === "down" || direction === "up";
        const [from, to] = direction === "down" || direction === "right" ? [0.7, 0.3] : [0.3, 0.7];
        await beforeAction();
        await call("gesture-swipe", vertical ? { fromX: 0.5, fromY: from, toX: 0.5, toY: to, momentum: false } : { fromX: from, fromY: 0.5, toX: to, toY: 0.5, momentum: false });
        return success({ action: "scroll", direction });
      }
      case "swipe": {
        await ensureDevice();
        const [x1, y1, x2, y2] = positional.slice(0, 4).map(Number);
        if (![x1, y1, x2, y2].every(finite)) throw new BridgeFailure("INVALID_ARGS", "swipe needs x1 y1 x2 y2.");
        const size = await screen();
        await beforeAction();
        await call("gesture-swipe", { fromX: x1! / size.width, fromY: y1! / size.height, toX: x2! / size.width, toY: y2! / size.height, momentum: false });
        return success({ action: "swipe" });
      }
      case "back": {
        await ensureDevice();
        await beforeAction();
        if (flags.system === true) {
          // agent-device's system back: the hardware button on Android, the edge swipe on iOS.
          if (platform === "android") await call("button", { button: "back" });
          else await call("gesture-swipe", { fromX: 0.05, fromY: 0.5, toX: 0.8, toY: 0.5, momentum: false });
          return success({ action: "back", mode: "system" });
        }
        const current = await tree();
        const nodes = flatten(current);
        const button = platform === "android"
          ? nodes.find(node => /^(Navigate up|Back)$/i.test(node.contentDescription ?? node.label ?? "") && node.frame)
          : (() => {
            const bar = nodes.find(node => node.type === "NavigationBar" && node.frame);
            return bar && (bar.children ?? []).flatMap(function all(node: ArgentNode): ArgentNode[] { return [node, ...(node.children ?? []).flatMap(all)]; })
              .find(node => node.type === "Button" && node.frame && node.frame.x < 1 / 3);
          })();
        if (button?.frame) {
          await tap(button.frame.x + button.frame.width / 2, button.frame.y + button.frame.height / 2);
          return success({ action: "back", mode: "in-app" });
        }
        if (flags["in-app"] === true || platform === "ios") return failure("COMMAND_FAILED", "in-app back control is not available");
        await call("button", { button: "back" });
        return success({ action: "back", mode: "system" });
      }
      case "wait": {
        if (positional[0] === "stable") {
          await ensureDevice();
          const minStableMs = Number(positional[1] ?? 500), timeoutMs = Number(positional[2] ?? 8000);
          const idle = await call("await-screen-idle", { minStableMs: finite(minStableMs) ? minStableMs : 500, timeoutMs: finite(timeoutMs) ? timeoutMs : 8000 });
          return success({ stable: idle.settled === true });
        }
        const milliseconds = Number(positional[0]);
        if (!finite(milliseconds) || milliseconds < 0) throw new BridgeFailure("INVALID_ARGS", "wait needs a number of milliseconds or `stable`.");
        await context.sleep(milliseconds);
        return success({ waitedMs: milliseconds });
      }
      case "screenshot": {
        await ensureDevice();
        const path = positional[0];
        if (!path) throw new BridgeFailure("INVALID_ARGS", "screenshot needs a path.");
        await call("screenshot", { scale: 1 }, { out: path });
        return success({ path });
      }
      case "record": {
        await ensureDevice();
        if (positional[0] === "start") {
          if (!positional[1]) throw new BridgeFailure("INVALID_ARGS", "record start needs a path.");
          await call("screen-recording-start", { timeLimitSeconds: 300, trimStatic: false, showTouches: false });
          state.recording = positional[1];
          return success({ recording: true, outPath: positional[1] });
        }
        if (positional[0] === "stop") {
          const stopped = await call("screen-recording-stop");
          const target = state.recording;
          delete state.recording;
          if (typeof stopped.video !== "string") return failure("COMMAND_FAILED", "Argent did not return the recording.");
          if (target) await context.moveFile(stopped.video, target);
          return success({ outPath: target ?? stopped.video, ...(finite(stopped.durationMs) ? { durationMs: stopped.durationMs } : {}) });
        }
        return failure("INVALID_ARGS", `Unsupported record command: ${positional[0] ?? ""}`);
      }
      case "install": {
        await ensureDevice();
        const path = positional[0];
        if (!path || !bundleFlag) throw new BridgeFailure("INVALID_ARGS", "install needs an archive path and the app's bundle identifier.");
        await beforeAction();
        await call("reinstall-app", { bundleId: bundleFlag, appPath: path });
        return success({ installed: true, appBundleId: bundleFlag });
      }
      case "fold": {
        await ensureDevice();
        const posture = positional[0];
        if (posture !== "closed" && posture !== "half-open" && posture !== "open") throw new BridgeFailure("INVALID_ARGS", "fold needs closed, half-open or open.");
        await beforeAction();
        const folded = await call("fold", { posture });
        // The other panel lights at another size: every stored coordinate and element reference is stale.
        delete state.screen;
        delete state.refs;
        state.generation += 1;
        return success({ action: "fold", pose: posture, ...(folded.panel !== undefined ? { panel: folded.panel } : {}) });
      }
      case "apps": return success({ apps: [] });
      case "session": return success({ sessions: [] });
      // TODO(argent#1509): map `settings appearance <scheme>` to Argent's `set-appearance` once a release with it is pinned.
      case "settings": return failure("CONTROLLER_UNSUPPORTED", "Argent cannot change the device's appearance yet.");
      case "logs": return failure("CONTROLLER_UNSUPPORTED", "Argent does not provide device logs to Explore.");
      default: return failure("INVALID_ARGS", `Unsupported command for the Argent controller: ${command ?? ""}`);
    }
  } catch (error) {
    if (error instanceof UnsentFailure) return remoteUnavailable();
    if (error instanceof BridgeFailure) return failure(error.code, error.message);
    if (error instanceof ArgentCallError) {
      // Never "Remote daemon is unavailable" here: the request may have run, so Explore must not resend it.
      return failure(error.sent ? "ARGENT_TOOL_FAILED" : "COMMAND_FAILED", error.sent ? error.message : "Remote daemon is unavailable");
    }
    return failure("ARGENT_BRIDGE_FAILED", error instanceof Error ? error.message : String(error));
  }

  /** Accepts iOS's "Open in “<app>”?" once per session; later links in the same session open without it. */
  async function acceptDeepLinkPrompt(bundleId: string | undefined) {
    for (let poll = 0; poll < 6; poll++) {
      await context.sleep(700);
      const current = await tree();
      // Argent can read nothing while iOS 27.1 shows the prompt; find Open in a screenshot instead.
      if (blindTree(current) && poll >= 1 && context.scratchImage) {
        if (await pressOpenFromScreenshot(context.scratchImage)) { state.deepLinkPromptAccepted = true; return; }
        continue;
      }
      if (!openInAppPromptShowing(current)) {
        if (bundleId && appReady(current, bundleId)) { state.deepLinkPromptAccepted = true; return; }
        // Another alert is the app's or the system's own business; capture answers it, the bridge does not.
        if (current.alertVisible) return;
        continue;
      }
      const size = current.screen;
      if (!size) break;
      const open = describedButton(await call("describe").then(described => described.description, () => undefined), "Open");
      // Without a described button, the prompt's Open button sits at a fixed offset from the centre on iPhone 17.
      await tap(...(open ? Object.values(centre(open, { width: 1, height: 1 })) as [number, number]
        : [0.5 + DEEP_LINK_PROMPT_CONFIRM.dxPoints / size.width, 0.5 + DEEP_LINK_PROMPT_CONFIRM.dyPoints / size.height] as [number, number]));
      if (await promptCleared()) { state.deepLinkPromptAccepted = true; return; }
      throw new BridgeFailure("CONTROLLER_DEEP_LINK_PROMPT", "iOS kept asking to open the link in the app after Open was pressed.");
    }
  }

  /**
   * After Open is pressed, the prompt can stay in the tree for a second or two while the app comes forward (observed on
   * iPhone Duo's inner display), so the bridge reads again for a few seconds before it calls the press a failure.
   */
  async function promptCleared(): Promise<boolean> {
    for (let poll = 0; poll < 6; poll++) {
      await context.sleep(1_000);
      if (!openInAppPromptShowing(await tree())) return true;
    }
    return false;
  }

  /** Taps the Open button found in a screenshot, then confirms it is gone. */
  async function pressOpenFromScreenshot(scratch: NonNullable<ArgentBridgeContext["scratchImage"]>): Promise<boolean> {
    await call("screenshot", { scale: 1 }, { out: scratch.path });
    const open = findOpenButton(await scratch.read(scratch.path));
    if (!open) return false;
    await tap(open.x, open.y);
    await context.sleep(1_000);
    const after = await tree();
    if (!blindTree(after)) return !openInAppPromptShowing(after);
    await call("screenshot", { scale: 1 }, { out: scratch.path });
    return !findOpenButton(await scratch.read(scratch.path));
  }

  function readAlert(current: ArgentTree) {
    const androidDialog = platform === "android"
      ? (current.roots ?? []).find(root => root.bundleId && root.bundleId !== ANDROID_SYSTEM_UI && root.bundleId !== (bundleFlag ?? current.foregroundApp))
      : undefined;
    if (!androidDialog && !alertShowing(current)) return undefined;
    const size = current.screen ?? state.screen ?? { width: 1, height: 1 };
    const nodes = flatten(current);
    const container = nodes.find(node => node.type === "Alert")
      ?? nodes.find(node => (node.children ?? []).length > 0 && OPEN_IN_APP_PROMPT.test(node.label ?? "")) ?? androidDialog;
    if (!container) return undefined;
    const inside = flatten({ roots: [container] });
    const buttons = inside.filter(node => /Button/.test(node.type ?? node.role ?? "") && node.label && node.frame)
      .map(node => ({ label: node.label!, rect: { x: node.frame!.x * size.width, y: node.frame!.y * size.height, width: node.frame!.width * size.width, height: node.frame!.height * size.height } }));
    const text = inside.filter(node => /StaticText|TextView/.test(node.type ?? node.role ?? "") && node.label).map(node => node.label!);
    return buttons.length ? { message: text.join(" ") || container.label || "", items: buttons.map(button => button.label), buttons } : undefined;
  }
}

class BridgeFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
class UnsentFailure extends Error {}

/** Argent's `fill` and `keyboard` would expand `{{secret:NAME}}` from Argent's own secret store; Explore resolves its own. */
function rejectSecretPlaceholder(text: string) {
  if (/\{\{\s*secret\s*:/i.test(text)) throw new BridgeFailure("INVALID_ARGS", "Text for the device must not contain a {{secret:…}} placeholder.");
}
