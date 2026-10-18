import { sourceScreenId } from "./build-diff";
import { cleanControlLabel, isFlowScreen, isLaunchScreen, screensInListOrder, transitionLabel, type MapIndex, type Screen, type Transition } from "./model";

/** One row of the Screens tree: a screen, or a folder of route files (source mode only). */
export type ScreenTreeNode =
  | { kind: "screen"; screenId: string; children: ScreenTreeNode[]; tab?: boolean; via?: string }
  | { kind: "folder"; id: string; label: string; children: ScreenTreeNode[] };

/** A group of the Screens page: a route folder, or a tab and what was opened from it. */
export type ScreenSection = {
  id: string;
  title: string;
  /** Source mode titles sections with a folder path, shown in monospace. */
  path: boolean;
  /** A path section's heading: its folder in words, `(settings)` → Settings; the path shows beneath it. */
  name?: string;
  subtitle?: string;
  screenIds: string[];
};

export type ScreenTree = {
  /** `source`: grouped by the route files the review read. `observed`: by what the explorer saw. */
  mode: "source" | "observed";
  sections: ScreenSection[];
  tree: ScreenTreeNode[];
  /** How each observed screen was reached (the control's label), by screen id. */
  via: Map<string, string>;
};

const LAUNCH_SECTION = "launch";
const APP_ROOT = /^(?:.*\/)?app\//;

/** `src/app/(tabs)/(patterns)/p.tsx` → `(tabs)/(patterns)`; a file at the root → "". */
function routeFolder(routeFile: string): string {
  const relative = routeFile.replace(APP_ROOT, "");
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

/** A route folder in words: `(tabs)/(settings)` → Settings, `lane-editor` → Lane editor, `[id]` → Id, the root → Top level. */
export function folderName(folder: string): string {
  const last = folder.slice(folder.lastIndexOf("/") + 1);
  const words = last.replace(/^\((.*)\)$/, "$1").replace(/^\[+(?:\.\.\.)?(.*?)\]+$/, "$1").split(/[-_\s]+/).filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Top level";
}

/** Folder names, with the parent folder's name in front where two folders would read the same. */
function folderNames(folders: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const folder of folders) counts.set(folderName(folder), (counts.get(folderName(folder)) ?? 0) + 1);
  return new Map(folders.map((folder) => {
    const name = folderName(folder);
    const slash = folder.lastIndexOf("/");
    return [folder, (counts.get(name) ?? 0) > 1 && slash > 0 ? `${folderName(folder.slice(0, slash))} · ${name}` : name];
  }));
}

function launchSection(launch: Screen[]): ScreenSection[] {
  return launch.length ? [{ id: LAUNCH_SECTION, title: "Launch", path: false, subtitle: "cold start", screenIds: launch.map(screen => screen.id) }] : [];
}

/** The sidebar rows of the flows: a folder per flow, its frames inside, after the route folders. */
function flowNodes(flows: Screen[]): ScreenTreeNode[] {
  return flowSections(flows).map(section => ({ kind: "folder" as const, id: section.id, label: section.title,
    children: section.screenIds.map(screenId => ({ kind: "screen" as const, screenId, children: [] })) }));
}

/** One section per e2e flow, its frames in step order; the flow's title is the part before the frame label. */
function flowSections(flows: Screen[]): ScreenSection[] {
  const byFlow = new Map<string, Screen[]>();
  for (const screen of flows) byFlow.set(screen.route ?? "", [...(byFlow.get(screen.route ?? "") ?? []), screen]);
  return [...byFlow.entries()].map(([route, screens]) => ({
    id: `flow:${route}`, title: screens[0]!.title.split(" › ")[0]!, path: false, subtitle: "flow", screenIds: screens.map(screen => screen.id),
  }));
}

/** A screen's route file; a removed screen keeps the one its baseline surface was read from. */
function routeFileOf(routeFiles: ReadonlyMap<string, string>, id: string): string | undefined {
  return routeFiles.get(id) ?? routeFiles.get(sourceScreenId(id));
}

function sourceTree(screens: Screen[], routeFiles: ReadonlyMap<string, string>): ScreenTree {
  const launch = screens.filter(isLaunchScreen);
  const flows = screens.filter(isFlowScreen);
  const byFolder = new Map<string, string[]>();
  const other: string[] = [];
  for (const screen of screens) {
    if (isLaunchScreen(screen) || isFlowScreen(screen)) continue;
    const file = routeFileOf(routeFiles, screen.id);
    if (!file) { other.push(screen.id); continue; }
    const folder = routeFolder(file);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), screen.id]);
  }
  // Route groups (`(tabs)`, how Expo Router lays out tabs and stacks) lead, then the files at the root,
  // then plain folders; each kind keeps the order its first screen comes in the list.
  const rank = (folder: string) => (folder.startsWith("(") ? 0 : folder === "" ? 1 : 2);
  const folders = [...byFolder.entries()].map((entry, position) => ({ entry, position }))
    .sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.position - b.position)
    .map(({ entry }) => entry);
  const names = folderNames(folders.map(([folder]) => folder));
  const sections: ScreenSection[] = [
    ...launchSection(launch),
    ...folders.map(([folder, ids]) => ({
      id: `folder:${folder}`,
      title: folder ? `app/${folder}` : "app",
      path: true,
      name: names.get(folder)!,
      screenIds: ids,
    })),
    ...(other.length ? [{ id: "other", title: "Other screens", path: false, subtitle: "no route file", screenIds: other }] : []),
    ...flowSections(flows),
  ];

  // The sidebar nests folders by segment: (tabs) → (patterns) → its screens.
  const root: ScreenTreeNode[] = launch.map(screen => ({ kind: "screen", screenId: screen.id, children: [] }));
  const folderNodes = new Map<string, Extract<ScreenTreeNode, { kind: "folder" }>>();
  const folderNode = (path: string): ScreenTreeNode[] => {
    if (!path) return root;
    const existing = folderNodes.get(path);
    if (existing) return existing.children;
    const slash = path.lastIndexOf("/");
    const parent = folderNode(slash < 0 ? "" : path.slice(0, slash));
    const node = { kind: "folder" as const, id: `folder:${path}`, label: `${path.slice(slash + 1)}/`, children: [] };
    folderNodes.set(path, node);
    parent.push(node);
    return node.children;
  };
  for (const [folder, ids] of folders) {
    const children = folderNode(folder);
    for (const id of ids) children.push({ kind: "screen", screenId: id, children: [] });
  }
  for (const id of other) root.push({ kind: "screen", screenId: id, children: [] });
  root.push(...flowNodes(flows));
  return { mode: "source", sections, tree: root, via: new Map() };
}

/** The control that opened a screen, by its label; nothing when only the action kind is known. */
function viaLabel(transition: Transition, index: MapIndex): string | undefined {
  const label = transitionLabel(transition, index);
  if (label !== transition.actionKind) return label;
  const element = transition.elementId ? index.elements.get(transition.elementId) : undefined;
  return element?.label ? cleanControlLabel(element.label) || undefined : undefined;
}

function observedTree(screens: Screen[], index: MapIndex): ScreenTree {
  const launch = screens.filter(isLaunchScreen);
  const flows = screens.filter(isFlowScreen);
  const routes = screens.filter(screen => !isLaunchScreen(screen) && !isFlowScreen(screen));
  const order = new Map(routes.map((screen, position) => [screen.id, position]));
  // A tab is a screen the explorer reached by pressing a tab-bar control.
  const tabs = new Set<string>();
  for (const screen of routes) {
    for (const transition of index.incoming.get(screen.id) ?? []) {
      const element = transition.elementId ? index.elements.get(transition.elementId) : undefined;
      if (element?.role === "tab") tabs.add(screen.id);
    }
  }
  const roots = routes.filter(screen => screen.start || screen.depth === 0 || tabs.has(screen.id));
  if (roots.length === 0 && routes[0]) roots.push(routes[0]);
  const rootIds = new Set(roots.map(screen => screen.id));

  // A screen's parent is the screen it was first opened from: its earliest incoming transition out of a
  // screen already in the tree. Passes over the transitions in time order repeat until nothing attaches,
  // so a screen first reached from one found later still lands under it, and no cycle can form.
  const parent = new Map<string, string>();
  const via = new Map<string, string>();
  const reached = new Set(rootIds);
  const transitions = [...index.outgoing.values()].flat()
    .filter(transition => order.has(transition.toScreenId) && !rootIds.has(transition.toScreenId))
    .sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.id.localeCompare(b.id));
  for (let attached = true; attached;) {
    attached = false;
    for (const transition of transitions) {
      const to = transition.toScreenId;
      if (reached.has(to) || !reached.has(transition.fromScreenId)) continue;
      reached.add(to);
      parent.set(to, transition.fromScreenId);
      const label = viaLabel(transition, index);
      if (label) via.set(to, label);
      attached = true;
    }
  }

  const children = new Map<string, string[]>();
  for (const screen of routes) {
    const up = parent.get(screen.id);
    if (up) children.set(up, [...(children.get(up) ?? []), screen.id]);
  }
  const node = (id: string): ScreenTreeNode => ({
    kind: "screen",
    screenId: id,
    children: (children.get(id) ?? []).map(node),
    ...(tabs.has(id) ? { tab: true } : {}),
    ...(via.has(id) ? { via: via.get(id)! } : {}),
  });
  const descendants = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(descendants)];
  const unreached = routes.filter(screen => !rootIds.has(screen.id) && !parent.has(screen.id)).map(screen => screen.id);

  const sections: ScreenSection[] = [
    ...launchSection(launch),
    ...flowSections(flows),
    ...roots.map(screen => ({
      id: `screen:${screen.id}`,
      title: screen.title,
      path: false,
      subtitle: [tabs.has(screen.id) ? "tab" : "first screen", (children.get(screen.id)?.length ?? 0) > 0
        ? `${descendants(screen.id).length - 1} opened from here` : undefined].filter(Boolean).join(" · "),
      screenIds: descendants(screen.id),
    })),
    ...(unreached.length ? [{ id: "unreached", title: "Not reached from a tab", path: false, screenIds: unreached }] : []),
  ];
  const tree: ScreenTreeNode[] = [
    ...launch.map(screen => ({ kind: "screen" as const, screenId: screen.id, children: [] })),
    ...roots.map(screen => node(screen.id)),
    ...unreached.map(id => ({ kind: "screen" as const, screenId: id, children: [] })),
    ...flowNodes(flows),
  ];
  return { mode: "observed", sections, tree, via };
}

/**
 * The Screens page's groups and sidebar tree. With the route files a review read, screens group the way
 * the app's `app/` directory is laid out; without them (a black-box exploration, a local run), by the tab
 * or first screen they were opened from, following the transitions the explorer observed.
 */
export function screenTree(
  screens: readonly Screen[],
  index: MapIndex,
  routeFiles: ReadonlyMap<string, string> = new Map(),
): ScreenTree {
  const ordered = screensInListOrder(screens);
  const known = ordered.filter(screen => !isLaunchScreen(screen) && routeFileOf(routeFiles, screen.id)).length;
  return known > 0 && !index.plainTitles ? sourceTree(ordered, routeFiles) : observedTree(ordered, index);
}

/** The key a tree row folds under: a folder's id, or `screen:<id>` for a screen with screens under it. */
export function treeNodeKey(node: ScreenTreeNode): string {
  return node.kind === "folder" ? node.id : `screen:${node.screenId}`;
}

export type ScreenTreeIndex = {
  /** Every row that can fold, top to bottom. */
  keys: string[];
  /** The screens inside each foldable row, its own screen excluded. */
  screensUnder: Map<string, string[]>;
  /** The foldable rows above each screen, outermost first. */
  ancestors: Map<string, string[]>;
  /** Each foldable row's nearest foldable row above it. */
  parents: Map<string, string>;
};

/**
 * Every screen in the order the tree lists it: depth first, so a subfolder's screens follow its parent folder's own,
 * where sections list folders in the order they were found. A screen the tree leaves out comes last.
 */
export function treeScreenOrder(tree: ScreenTree): string[] {
  const ids: string[] = [];
  const walk = (nodes: readonly ScreenTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "screen") ids.push(node.screenId);
      walk(node.children);
    }
  };
  walk(tree.tree);
  return [...new Set([...ids, ...tree.sections.flatMap(section => section.screenIds)])];
}

export function treeIndex(tree: readonly ScreenTreeNode[]): ScreenTreeIndex {
  const index: ScreenTreeIndex = { keys: [], screensUnder: new Map(), ancestors: new Map(), parents: new Map() };
  const walk = (nodes: readonly ScreenTreeNode[], above: string[]): string[] => nodes.flatMap((node) => {
    const own = node.kind === "screen" ? [node.screenId] : [];
    if (node.kind === "screen") index.ancestors.set(node.screenId, above);
    if (!node.children.length) return own;
    const key = treeNodeKey(node);
    index.keys.push(key);
    if (above.length) index.parents.set(key, above[above.length - 1]!);
    const under = walk(node.children, [...above, key]);
    index.screensUnder.set(key, under);
    return [...own, ...under];
  });
  walk(tree, []);
  return index;
}
