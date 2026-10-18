import type { Appearance } from "./appearance";
import type { CanvasView, ThemePreference } from "./navigation";
import type { CanvasZoomCommand } from "./canvas-zoom";
import type { SearchItem } from "./search";
import { formatShortcut, SHORTCUTS, TARGET_NUMBER_KEYS } from "./shortcuts";

/** What the reader is looking at decides which commands the palette offers. */
export type CommandContext = {
  canvas: CanvasView;
  phone: boolean;
  /** The changed screens in review order; empty without a baseline. */
  changed: readonly { id: string; route: string }[];
  selectedScreenId?: string | undefined;
  /** The Screens page has a find field (desktop). */
  find: boolean;
  /** The report can be handed off to an agent (a hosted preview). */
  handoff: boolean;
  pullRequest?: { origin?: "local" | "compare" | undefined; number?: number | undefined; url?: string | undefined } | undefined;
  theme: ThemePreference;
  /** The captured appearances, when there is more than one to show. */
  appearances: readonly { id: Appearance; label: string; current: boolean }[];
  /** The Inspector's state where it exists (not on Compare, not on a phone). */
  inspector?: { open: boolean } | undefined;
  /** Full screen's state where the browser supports it. */
  fullscreen?: boolean | undefined;
  /** The run's other targets this page can open, with their place in the targets menu. */
  targets: readonly { id: string; label: string; place: number; noun: "device" | "platform" }[];
  /** A canvas camera is on screen (Map), so fit, center and zoom apply. */
  camera: boolean;
};

export type CommandActions = {
  selectCanvas: (canvas: CanvasView) => void;
  openFind: () => void;
  openHandoff: () => void;
  openShortcuts: () => void;
  toggleChanges: () => void;
  openChangedScreen: (id: string) => void;
  setTheme: (theme: ThemePreference) => void;
  chooseAppearance: (appearance: Appearance) => void;
  toggleInspector: () => void;
  toggleFullscreen: () => void;
  switchTarget: (id: string) => void;
  zoom: (command: CanvasZoomCommand) => void;
};

const THEME_TITLES: Record<ThemePreference, string> = { system: "Theme: Auto (system)", dark: "Theme: Dark", light: "Theme: Light" };

function repositoryOf(url: string | undefined): string | undefined {
  return /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull\/\d+|compare\/.+)$/.exec(url ?? "")?.[1];
}

function openLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * The palette's commands for one context, as search items: each names its group as context and prints the key that
 * also runs it, so the list doubles as the shortcuts a reader can discover by typing.
 */
export function commandItems(context: CommandContext, actions: CommandActions): SearchItem[] {
  const items: SearchItem[] = [];
  const add = (id: string, group: string, title: string, run: () => void, options: { keywords?: string[]; shortcut?: string | undefined } = {}) => {
    items.push({ id: `command:${id}`, kind: "command", title, keywords: options.keywords ?? [], context: group, order: items.length, run,
      ...(options.shortcut ? { shortcut: options.shortcut } : {}) });
  };
  const key = formatShortcut;
  const hasChanges = context.changed.length > 0;
  const selectedChange = context.changed.find((entry) => entry.id === context.selectedScreenId);

  if (context.canvas !== "map") add("go:map", "Go to", "Map", () => actions.selectCanvas("map"), { keywords: ["canvas", "overview"], shortcut: key(SHORTCUTS.canvas.map) });
  if (context.canvas !== "screens") add("go:screens", "Go to", "Screens", () => actions.selectCanvas("screens"), { keywords: ["inventory", "grid", "list"], shortcut: key(SHORTCUTS.canvas.screens) });
  if (hasChanges && context.canvas !== "compare") add("go:compare", "Go to", "Compare", () => actions.selectCanvas("compare"), { keywords: ["review", "changes", "diff", "before", "after"], shortcut: key(SHORTCUTS.canvas.compare) });
  if (context.find) add("go:find", "Go to", "Find a screen", actions.openFind, { keywords: ["filter", "screens", "search"], shortcut: "/" });
  if (context.handoff) add("go:handoff", "Go to", "Hand off to AI", actions.openHandoff, { keywords: ["agent", "prompt", "claude", "codex", "copy"], shortcut: key(SHORTCUTS.app.handoff) });
  add("go:shortcuts", "Go to", "Keyboard shortcuts", actions.openShortcuts, { keywords: ["keys", "help"], shortcut: "?" });
  if (hasChanges && !context.phone) add("go:changes-menu", "Go to", "Changed screens menu", actions.toggleChanges, { keywords: ["changes", "list", "filter"], shortcut: key(SHORTCUTS.app.changes) });

  if (hasChanges) {
    const at = context.changed.findIndex((entry) => entry.id === context.selectedScreenId);
    const count = context.changed.length;
    const step = (delta: number) => context.changed[((at < 0 ? (delta > 0 ? -1 : 0) : at) + delta + count) % count]!;
    const compare = context.canvas === "compare";
    add("changes:next", "Changes", "Next changed screen", () => actions.openChangedScreen(step(1).id),
      { keywords: ["change", "step", "forward"], shortcut: compare ? key(SHORTCUTS.compare.nextScreen) : undefined });
    add("changes:previous", "Changes", "Previous changed screen", () => actions.openChangedScreen(step(-1).id),
      { keywords: ["change", "step", "back"], shortcut: compare ? key(SHORTCUTS.compare.previousScreen) : undefined });
    if (selectedChange && !compare) add("changes:open-selected", "Changes", `Open ${selectedChange.route} in Compare`, () => actions.selectCanvas("compare"), { keywords: ["selected", "review", "diff"] });
  }

  if (context.inspector) {
    add("view:inspector", "View", context.inspector.open ? "Hide the inspector" : "Show the inspector", actions.toggleInspector,
      { keywords: ["panel", "details", "sidebar"], shortcut: key(SHORTCUTS.panel.right) });
  }
  for (const theme of ["system", "dark", "light"] as const) {
    add(`view:theme:${theme}`, context.theme === theme ? "View · current" : "View", THEME_TITLES[theme], () => actions.setTheme(theme),
      { keywords: ["theme", "appearance", "viewer", "color", "mode"] });
  }
  for (const appearance of context.appearances) {
    add(`view:appearance:${appearance.id}`, appearance.current ? "View · current" : "View", `App appearance: ${appearance.label}`, () => actions.chooseAppearance(appearance.id),
      { keywords: ["app", "appearance", "scheme", "light", "dark", "captured"], shortcut: !appearance.current && context.appearances.length === 2 ? key(SHORTCUTS.appearance.app) : undefined });
  }
  if (context.fullscreen !== undefined) {
    add("view:fullscreen", "View", context.fullscreen ? "Exit full screen" : "Enter full screen", actions.toggleFullscreen, { keywords: ["fullscreen", "window", "focus"] });
  }

  for (const target of context.targets) {
    const numbered = TARGET_NUMBER_KEYS ? SHORTCUTS.targetByNumber[target.place] : undefined;
    add(`target:${target.id}`, target.noun === "device" ? "Devices" : "Platforms", `Switch to ${target.label}`, () => actions.switchTarget(target.id),
      { keywords: [target.noun, "report", "switch", "ios", "android"], shortcut: numbered ? key(numbered) : undefined });
  }

  if (context.camera) {
    add("camera:fit", "Canvas", "Fit the canvas", () => actions.zoom("fit"), { keywords: ["zoom", "fit", "all"], shortcut: key(SHORTCUTS.camera.fit) });
    add("camera:center", "Canvas", "Center the canvas", () => actions.zoom("recenter"), { keywords: ["zoom", "center", "recenter"], shortcut: key(SHORTCUTS.camera.center) });
    add("camera:100", "Canvas", "Zoom to 100%", () => actions.zoom("100"), { keywords: ["zoom", "actual", "reset"], shortcut: key(SHORTCUTS.camera.zoom100) });
    add("camera:in", "Canvas", "Zoom in", () => actions.zoom("in"), { keywords: ["zoom", "closer"], shortcut: key(SHORTCUTS.camera.zoomIn) });
    add("camera:out", "Canvas", "Zoom out", () => actions.zoom("out"), { keywords: ["zoom", "away"], shortcut: key(SHORTCUTS.camera.zoomOut) });
  }

  const pr = context.pullRequest;
  if (pr?.url) {
    const url = pr.url;
    const title = pr.origin === "compare" ? "Open the compare on GitHub" : pr.origin === "local" ? "Open the review on GitHub" : `Open pull request #${pr.number} on GitHub`;
    add("link:pull-request", "Links", title, () => openLink(url), { keywords: ["github", "pr", "pull request", "browser"] });
    const repository = repositoryOf(url);
    if (repository) add("link:repository", "Links", `Open ${repository} on GitHub`, () => openLink(`https://github.com/${repository}`), { keywords: ["github", "repo", "repository", "source"] });
  }
  return items;
}

/** The commands the empty palette leads with: what a reader on this canvas is most likely to do next. */
export function suggestedCommands(items: readonly SearchItem[], canvas: CanvasView, limit = 6): SearchItem[] {
  const priority: Record<CanvasView, string[]> = {
    map: ["changes:next", "changes:open-selected", "go:compare", "camera:fit", "go:find", "go:handoff", "go:screens", "view:inspector"],
    screens: ["go:find", "changes:next", "changes:open-selected", "go:compare", "go:map", "go:handoff", "view:inspector"],
    compare: ["changes:next", "changes:previous", "go:map", "go:screens", "go:handoff", "go:shortcuts"],
  };
  return priority[canvas].flatMap((id) => items.filter((item) => item.id === `command:${id}`)).slice(0, limit);
}
