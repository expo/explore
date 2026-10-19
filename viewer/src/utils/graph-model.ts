import type { ExploreMap, MapIndex, Screen } from "./model";
import { isLaunchScreen, transitionLabel } from "./model";
import type { NavigationEdge } from "../../../src/contracts/navigation-graph";
import { navigationEdgeKey } from "./source-navigation";
import { omittedScreenIds } from "./omitted-screens";

export type ConnectionGroup = {
  key: string;
  from: string;
  to: string;
  transitionIds: string[];
  labels: string[];
  synthetic?: boolean;
  sourceEdges?: NavigationEdge[];
  sourceRevision?: "current" | "baseline";
};

export type ObservedGraph = {
  screens: Screen[];
  groups: ConnectionGroup[];
  outgoing: Map<string, ConnectionGroup[]>;
  incoming: Map<string, ConnectionGroup[]>;
  cyclicScreenIds: Set<string>;
  disconnectedScreenIds: string[];
};

export type ProjectionNode = { id: string; kind: "screen"; screen: Screen };

export type GraphProjection = {
  nodes: ProjectionNode[];
  groups: ConnectionGroup[];
  visibleScreenIds: Set<string>;
};

/** A black-box exploration drove the app without source: it has observed screens and taps, no source navigation. */
export function isBlackBoxMap(map: Pick<ExploreMap, "run">): boolean {
  return map.run?.exploration === "black-box";
}

function adjacency(groups: readonly ConnectionGroup[]) {
  const outgoing = new Map<string, ConnectionGroup[]>();
  const incoming = new Map<string, ConnectionGroup[]>();
  for (const group of groups) {
    outgoing.set(group.from, [...(outgoing.get(group.from) ?? []), group]);
    incoming.set(group.to, [...(incoming.get(group.to) ?? []), group]);
  }
  return { outgoing, incoming };
}

/** Tarjan's algorithm marks every screen participating in a cross-screen cycle. */
function cyclicScreens(screenIds: readonly string[], outgoing: ReadonlyMap<string, ConnectionGroup[]>) {
  const indexById = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  let cursor = 0;

  const visit = (screenId: string) => {
    indexById.set(screenId, cursor);
    lowLink.set(screenId, cursor);
    cursor += 1;
    stack.push(screenId);
    onStack.add(screenId);

    for (const connection of outgoing.get(screenId) ?? []) {
      const target = connection.to;
      if (!indexById.has(target)) {
        visit(target);
        lowLink.set(screenId, Math.min(lowLink.get(screenId)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(screenId, Math.min(lowLink.get(screenId)!, indexById.get(target)!));
      }
    }

    if (lowLink.get(screenId) !== indexById.get(screenId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === screenId) break;
    }
    if (component.length > 1) component.forEach((member) => cyclic.add(member));
  };

  for (const screenId of screenIds) {
    if (!indexById.has(screenId)) visit(screenId);
  }
  return cyclic;
}

/** One immutable observed topology model per map revision. */
export function buildObservedGraph(map: ExploreMap, index: MapIndex): ObservedGraph {
  const grouped = new Map<string, ConnectionGroup>();
  for (const transition of map.transitions) {
    if (transition.fromScreenId === transition.toScreenId) continue;
    const key = `${transition.fromScreenId}\u0000${transition.toScreenId}`;
    const group = grouped.get(key) ?? {
      key,
      from: transition.fromScreenId,
      to: transition.toScreenId,
      transitionIds: [],
      labels: [],
    };
    group.transitionIds.push(transition.id);
    const label = transition.actionKind === "other" ? "" : transitionLabel(transition, index);
    if (label && !group.labels.includes(label)) group.labels.push(label);
    grouped.set(key, group);
  }

  const groups = [...grouped.values()];
  const { outgoing, incoming } = adjacency(groups);
  const screenIds = map.screens.map((screen) => screen.id);
  return {
    screens: map.screens,
    groups,
    outgoing,
    incoming,
    cyclicScreenIds: cyclicScreens(screenIds, outgoing),
    disconnectedScreenIds: screenIds.filter((id) => (
      (incoming.get(id)?.length ?? 0) === 0 && (outgoing.get(id)?.length ?? 0) === 0
    )),
  };
}

/** The Viewer can overlay declarations; the observed graph and event indexes stay intact. */
export function buildViewerGraph(map: ExploreMap, index: MapIndex): ObservedGraph {
  const observed = buildObservedGraph(map, index);
  // A public report preserves its complete source inventory, but the routes it never captured are not its screens
  // (omitted-screens.ts). The launch stays: it is where the app starts, drawn above the start screens with a synthetic
  // edge into each of them.
  const omitted = omittedScreenIds(map);
  const screens = observed.screens.filter(screen => !omitted.has(screen.id));
  const visibleIds = new Set(screens.map(screen => screen.id));
  const launchEdges = launchGroups(screens);
  if (!map.sourceNavigation && !map.baselineSourceNavigation && omitted.size === 0 && launchEdges.length === 0) return observed;
  const grouped = new Map([...observed.groups
    .filter(group => visibleIds.has(group.from) && visibleIds.has(group.to))
    .map(group => [group.key, {
    ...group, transitionIds: [...group.transitionIds], labels: [...group.labels],
  } as ConnectionGroup] as const), ...launchEdges.map(group => [group.key, group] as const)]);
  const currentKeys = new Set(map.sourceNavigation?.edges.map(navigationEdgeKey));
  for (const [revision, navigation] of [["current", map.sourceNavigation], ["baseline", map.baselineSourceNavigation]] as const) {
    for (const edge of navigation?.edges ?? []) {
      if (edge.from === edge.to || !visibleIds.has(edge.from) || !visibleIds.has(edge.to)) continue;
      if (revision === "baseline" && currentKeys.has(navigationEdgeKey(edge))) continue;
      const key = `${revision === "baseline" ? "baseline:" : ""}${edge.from}\u0000${edge.to}`;
      const group = grouped.get(key) ?? { key, from: edge.from, to: edge.to, transitionIds: [], labels: [] };
      group.sourceEdges ??= [];
      group.sourceEdges.push({ ...edge });
      group.sourceRevision = revision;
      if (group.transitionIds.length === 0 && !group.labels.includes(edge.kind)) group.labels.push(edge.kind);
      grouped.set(key, group);
    }
  }
  const groups = [...grouped.values()];
  const { outgoing, incoming } = adjacency(groups);
  const screenIds = screens.map(screen => screen.id);
  return {
    ...observed, screens, groups, outgoing, incoming,
    cyclicScreenIds: cyclicScreens(screenIds, outgoing),
    disconnectedScreenIds: screenIds.filter(id => !(incoming.get(id)?.length || outgoing.get(id)?.length)),
  };
}

/**
 * The launch is observed once per appearance and the app lands on its start screen(s): one synthetic edge from the launch
 * to each start screen (or to the first route when the report knows no start) says so without claiming a tap.
 */
function launchGroups(screens: readonly Screen[]): ConnectionGroup[] {
  const launch = screens.find(isLaunchScreen);
  if (!launch) return [];
  const routes = screens.filter(screen => !isLaunchScreen(screen));
  const targets = routes.filter(screen => screen.start);
  if (targets.length === 0 && routes[0]) targets.push(routes[0]);
  return targets.map(target => ({
    key: `${launch.id}\u0000${target.id}`, from: launch.id, to: target.id, transitionIds: [], labels: ["Launch"], synthetic: true,
  }));
}

/** The whole observed graph: one node per screen, one edge per screen-to-screen connection. */
export function projectFullGraph(graph: ObservedGraph): GraphProjection {
  return {
    nodes: graph.screens.map((screen) => ({ id: screen.id, kind: "screen", screen })),
    groups: graph.groups,
    visibleScreenIds: new Set(graph.screens.map((screen) => screen.id)),
  };
}
