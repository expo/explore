import { assertAllowedKeys, isRecord, safeRepoPath, stableIdentifier } from "./source-validation.js";

export const NAVIGATION_GRAPH_CONTRACT = "explore.navigation" as const;

export type NavigationEdge = {
  from: string;
  to: string;
  kind: "push" | "replace" | "navigate" | "redirect" | "tab" | "dismissTo";
  sourceFile: string;
  provenance: "source";
};

export type NavigationGraph = {
  contract: typeof NAVIGATION_GRAPH_CONTRACT;
  edges: NavigationEdge[];
  modalSurfaceIds: string[];
  unresolved: string[];
};

const MAX_NODES = 5_000;
const MAX_EDGES = 50_000;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_MESSAGE_LENGTH = 1_024;
const edgeKinds = new Set<NavigationEdge["kind"]>([
  "push", "replace", "navigate", "redirect", "tab", "dismissTo",
]);

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must be an identifier of at most ${MAX_ID_LENGTH} characters`);
  }
  return stableIdentifier(value, label);
}

function identifierSet(values: Iterable<string>, label: string): Set<string> {
  const result = new Set<string>();
  let count = 0;
  for (const value of values) {
    count += 1;
    if (count > MAX_NODES) throw new Error(`${label} must contain at most ${MAX_NODES} identifiers`);
    result.add(identifier(value, `${label}[${count - 1}]`));
  }
  return result;
}

function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array of at most ${maximum} entries`);
  }
  return Array.from(value);
}

function exactFields(value: Record<string, unknown>, fields: string[], label: string): void {
  assertAllowedKeys(value, fields, label);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new Error(`${label} is missing ${field}`);
  }
}

function sourcePath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_LENGTH
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new Error(`${label} must be a safe repository-relative POSIX path of at most ${MAX_PATH_LENGTH} characters`);
  }
  return safeRepoPath(value, label);
}

/** Validate source-derived navigation independently for the base or head inventory. */
export function validateNavigationGraph(value: unknown, existingIds?: Iterable<string>): NavigationGraph {
  if (!isRecord(value)) throw new Error("navigation graph must be an object");
  exactFields(value, ["contract", "edges", "modalSurfaceIds", "unresolved"], "navigation graph");
  if (value.contract !== NAVIGATION_GRAPH_CONTRACT) throw new Error("navigation graph contract is invalid");

  const existing = existingIds === undefined ? undefined : identifierSet(existingIds, "navigation inventory");
  const nodes = new Set<string>();
  const node = (candidate: unknown, label: string): string => {
    const id = identifier(candidate, label);
    if (existing && !existing.has(id)) throw new Error(`${label} references unknown surface ${id}`);
    nodes.add(id);
    if (nodes.size > MAX_NODES) throw new Error(`navigation graph must contain at most ${MAX_NODES} nodes`);
    return id;
  };

  const edgeKeys = new Set<string>();
  const edges = boundedArray(value.edges, MAX_EDGES, "navigation graph edges").map((candidate, index): NavigationEdge => {
    const label = `navigation graph edges[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${label} must be an object`);
    exactFields(candidate, ["from", "to", "kind", "sourceFile", "provenance"], label);
    if (!edgeKinds.has(candidate.kind as NavigationEdge["kind"])) throw new Error(`${label}.kind is invalid`);
    if (candidate.provenance !== "source") throw new Error(`${label}.provenance must be source`);
    const edge: NavigationEdge = {
      from: node(candidate.from, `${label}.from`),
      to: node(candidate.to, `${label}.to`),
      kind: candidate.kind as NavigationEdge["kind"],
      sourceFile: sourcePath(candidate.sourceFile, `${label}.sourceFile`),
      provenance: "source",
    };
    const key = JSON.stringify([edge.from, edge.to, edge.kind, edge.sourceFile]);
    if (edgeKeys.has(key)) throw new Error(`${label} repeats a navigation edge`);
    edgeKeys.add(key);
    return edge;
  });

  const modalIds = new Set<string>();
  const modalSurfaceIds = boundedArray(value.modalSurfaceIds, MAX_NODES, "navigation graph modalSurfaceIds")
    .map((candidate, index) => {
      const id = node(candidate, `navigation graph modalSurfaceIds[${index}]`);
      if (modalIds.has(id)) throw new Error(`navigation graph modalSurfaceIds repeats surface ${id}`);
      modalIds.add(id);
      return id;
    });
  const unresolved = boundedArray(value.unresolved, MAX_NODES, "navigation graph unresolved")
    .map((message, index) => {
      if (
        typeof message !== "string"
        || !message.trim()
        || message.length > MAX_MESSAGE_LENGTH
        || /[\u0000-\u001f\u007f]/.test(message)
      ) {
        throw new Error(`navigation graph unresolved[${index}] must be a non-empty message of at most ${MAX_MESSAGE_LENGTH} characters without control characters`);
      }
      return message;
    });

  return { contract: NAVIGATION_GRAPH_CONTRACT, edges, modalSurfaceIds, unresolved };
}

/**
 * The changed routes plus the routes one navigation step before or after them: the screens a
 * reviewer needs to see how the change is reached and where it leads. The context is not a
 * closure: in most apps every screen reaches every other one through tabs, guards or Home, so
 * the transitive ancestors and descendants of any change would be the whole app.
 */
export function navigationContext(
  graph: NavigationGraph,
  seeds: Iterable<string>,
  existingIds: Iterable<string>,
  ignore: (edge: NavigationEdge) => boolean = () => false,
): string[] {
  const existing = identifierSet(existingIds, "navigation inventory");
  const validated = validateNavigationGraph(graph, existing);
  const presentSeeds = new Set([...identifierSet(seeds, "navigation seeds")].filter((id) => existing.has(id)));
  const context = new Set(presentSeeds);
  for (const edge of validated.edges) {
    if (ignore(edge)) continue;
    if (presentSeeds.has(edge.to)) context.add(edge.from);
    if (presentSeeds.has(edge.from)) context.add(edge.to);
  }
  return [...context].sort();
}

/** Capture every declared variant of context routes; unresolved destinations require full coverage. */
export function navigationCaptureContext(
  graph: NavigationGraph,
  seeds: Iterable<string>,
  entries: Iterable<{ id: string; routeFile: string; kind?: "screen" | "redirect" }>,
): string[] {
  const routeFiles = new Map<string, string>();
  const redirects = new Set<string>();
  let count = 0;
  for (const entry of entries) {
    count += 1;
    if (count > MAX_NODES) throw new Error(`navigation entries must contain at most ${MAX_NODES} entries`);
    const label = `navigation entries[${count - 1}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    const id = identifier(entry.id, `${label}.id`);
    if (routeFiles.has(id)) throw new Error(`navigation entries repeats surface ${id}`);
    routeFiles.set(id, sourcePath(entry.routeFile, `${label}.routeFile`));
    if (entry.kind === "redirect") redirects.add(id);
  }

  // Guards do not make every guarded screen a neighbor of their destination.
  const context = new Set(navigationContext(graph, seeds, routeFiles.keys(), (edge) => edge.kind === "redirect"));
  if (context.size === 0) return [];
  if (graph.unresolved.some((message) => message.startsWith("Unresolved navigation:"))) {
    return [...routeFiles.keys()].sort();
  }
  // Forwarding routes have no screenshot: follow only their redirects/replaces to the first
  // screen, without restarting ordinary navigation expansion. The context set also breaks cycles.
  const destinations = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!redirects.has(edge.from) || edge.kind !== "redirect" && edge.kind !== "replace") continue;
    const targets = destinations.get(edge.from) ?? [];
    targets.push(edge.to);
    destinations.set(edge.from, targets);
  }
  const queue = [...context].filter(id => redirects.has(id));
  for (let index = 0; index < queue.length; index++) {
    for (const id of destinations.get(queue[index]!) ?? []) {
      if (context.has(id)) continue;
      context.add(id);
      if (redirects.has(id)) queue.push(id);
    }
  }
  const selectedRoutes = new Set([...context].map((id) => routeFiles.get(id)!));
  return [...routeFiles].filter(([, routeFile]) => selectedRoutes.has(routeFile)).map(([id]) => id).sort();
}
