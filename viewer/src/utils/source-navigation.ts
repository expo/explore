import type { NavigationEdge, NavigationGraph } from "../../../src/contracts/navigation-graph";

export function navigationEdgeKey(edge: NavigationEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.kind, edge.sourceFile]);
}

/** Remap declared identities without turning a source link into an observed transition. */
export function projectSourceNavigation(
  graph: NavigationGraph,
  screenId: (id: string) => string | undefined,
): NavigationGraph {
  const edges = new Map<string, NavigationEdge>();
  for (const edge of graph.edges) {
    const from = screenId(edge.from);
    const to = screenId(edge.to);
    if (!from || !to) continue;
    const projected = { ...edge, from, to };
    edges.set(navigationEdgeKey(projected), projected);
  }
  return {
    contract: graph.contract,
    edges: [...edges.values()].sort((left, right) => navigationEdgeKey(left).localeCompare(navigationEdgeKey(right))),
    modalSurfaceIds: [...new Set(graph.modalSurfaceIds.flatMap(id => screenId(id) ?? []))].sort(),
    unresolved: [...graph.unresolved],
  };
}

