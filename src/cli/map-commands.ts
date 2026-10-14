import { resolve } from "node:path";
import { ExploreError, shortestReplay, getCoverage, eligibleFrontier, shortestPath, validateMap } from "../map/store.js";
import type { ExploreMap, FrontierItem } from "../types.js";
import { nonNegativeInteger, positiveInteger, store, has, output, required, flag } from "./args.js";

function page<T>(values: T[]): {
  items: T[];
  total: number;
  count: number;
  hasMore: boolean;
  truncated: boolean;
  nextCursor: string | null;
} {
  const cursor = nonNegativeInteger("cursor", 0);
  const limit = Math.min(positiveInteger("limit", 50), 200);
  const items = values.slice(cursor, cursor + limit);
  const next = cursor + items.length;
  const hasMore = next < values.length;
  return {
    items,
    total: values.length,
    count: items.length,
    hasMore,
    truncated: hasMore,
    nextCursor: hasMore ? String(next) : null,
  };
}

export async function listScreens(): Promise<void> {
  const map = await store.read();
  const pendingScreenIds = new Set(
    map.frontier
      .filter((item) => ["pending", "claimed", "blocked"].includes(item.status))
      .map((item) => item.screenId),
  );
  const values = has("unexplored")
    ? map.screens.filter((screen) => pendingScreenIds.has(screen.id))
    : map.screens;
  output({ ok: true, ...page(values) });
}

function artifactFor(map: ExploreMap, id: string | undefined) {
  return id ? map.artifacts.find((artifact) => artifact.id === id) ?? null : null;
}

export async function getScreen(): Promise<void> {
  const map = await store.read();
  const id = required("id");
  const screen = map.screens.find((entry) => entry.id === id);
  if (!screen) throw new ExploreError(`Unknown screen: ${id}`);
  output({
    ok: true,
    screen,
    variants: map.variants.filter((entry) => entry.screenId === id),
    observations: map.observations.filter((entry) => entry.screenId === id),
    elements: map.elements.filter((entry) => entry.screenId === id),
    incoming: map.transitions.filter((entry) => entry.toScreenId === id),
    outgoing: map.transitions.filter((entry) => entry.fromScreenId === id),
  });
}

export async function listElements(): Promise<void> {
  const map = await store.read();
  const screenId = flag("screen");
  const role = flag("role");
  const query = flag("query")?.toLowerCase();
  const values = map.elements.filter(
    (element) =>
      (!screenId || element.screenId === screenId) &&
      (!role || element.role === role) &&
      (!has("actionable") || element.actionable) &&
      (!query ||
        [element.label, element.identifier, element.value, element.selector]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query))),
  );
  output({ ok: true, ...page(values) });
}

export async function listObservations(): Promise<void> {
  const map = await store.read();
  const screenId = flag("screen");
  const values = screenId
    ? map.observations.filter((observation) => observation.screenId === screenId)
    : map.observations;
  output({ ok: true, ...page(values) });
}

export async function getObservation(): Promise<void> {
  const map = await store.read();
  const id = required("id");
  const observation = map.observations.find((entry) => entry.id === id);
  if (!observation) throw new ExploreError(`Unknown observation: ${id}`);
  output({
    ok: true,
    observation,
    screen: map.screens.find((screen) => screen.id === observation.screenId) ?? null,
    variant: map.variants.find((variant) => variant.id === observation.variantId) ?? null,
    elements: observation.elements,
    screenshot: artifactFor(map, observation.screenshotArtifactId),
    accessibility: artifactFor(map, observation.accessibilityArtifactId),
  });
}

function frontierResponse(map: ExploreMap, item: FrontierItem) {
  const screen = map.screens.find((entry) => entry.id === item.screenId);
  if (!screen) throw new ExploreError(`Frontier item ${item.id} has an unknown screen`);
  return {
    item,
    screen,
    element: item.elementId
      ? map.elements.find((element) => element.id === item.elementId) ?? null
      : null,
    latestObservation:
      map.observations.find((observation) => observation.id === screen.observationIds.at(-1)) ??
      null,
    replay: shortestReplay(map, screen.id),
  };
}

export async function nextFrontier(): Promise<void> {
  const map = await store.read();
  const coverage = getCoverage(map);
  if (coverage.limitReached) {
    output({
      ok: true,
      done: true,
      reason: "limit",
      limitReached: coverage.limitReached,
      coverage,
    });
    return;
  }
  const item = eligibleFrontier(map)[0];
  if (!item) {
    output({
      ok: true,
      done: true,
      reason: coverage.completion.eligible ? "frontier-empty" : "coverage-blocked",
      coverage,
    });
    return;
  }
  output({ ok: true, done: false, ...frontierResponse(map, item), coverage });
}

export async function listAttempts(): Promise<void> {
  const map = await store.read();
  const outcome = flag("outcome");
  const screenId = flag("screen");
  const values = map.actionAttempts.filter(
    (attempt) =>
      (!outcome || attempt.outcome === outcome) &&
      (!screenId ||
        attempt.sourceScreenId === screenId ||
        attempt.targetScreenId === screenId),
  );
  output({ ok: true, ...page(values) });
}

export async function getAttempt(): Promise<void> {
  const map = await store.read();
  const attempt = map.actionAttempts.find((entry) => entry.id === required("id"));
  if (!attempt) throw new ExploreError("Unknown action attempt");
  output({
    ok: true,
    attempt,
    sourceObservation:
      map.observations.find((entry) => entry.id === attempt.sourceObservationId) ?? null,
    targetObservation: attempt.targetObservationId
      ? map.observations.find((entry) => entry.id === attempt.targetObservationId) ?? null
      : null,
  });
}

export async function listTransitions(): Promise<void> {
  const map = await store.read();
  const screenId = flag("screen");
  const values = screenId
    ? map.transitions.filter(
        (transition) =>
          transition.fromScreenId === screenId || transition.toScreenId === screenId,
      )
    : map.transitions;
  output({ ok: true, ...page(values) });
}

export async function getTransition(): Promise<void> {
  const map = await store.read();
  const transition = map.transitions.find((entry) => entry.id === required("id"));
  if (!transition) throw new ExploreError("Unknown transition");
  output({
    ok: true,
    transition,
    attempts: transition.attemptIds
      .map((id) => map.actionAttempts.find((attempt) => attempt.id === id))
      .filter(Boolean),
  });
}

export async function neighbors(): Promise<void> {
  const map = await store.read();
  const screenId = required("screen");
  if (!map.screens.some((screen) => screen.id === screenId)) {
    throw new ExploreError(`Unknown screen: ${screenId}`);
  }
  const describeTransition = (transition: ExploreMap["transitions"][number], direction: "incoming" | "outgoing") => ({
    transition,
    screen:
      map.screens.find((screen) =>
        screen.id === (direction === "outgoing" ? transition.toScreenId : transition.fromScreenId),
      ) ?? null,
    attempts: transition.attemptIds
      .map((id) => map.actionAttempts.find((attempt) => attempt.id === id))
      .filter(Boolean),
  });
  output({
    ok: true,
    screenId,
    incoming: map.transitions
      .filter((transition) => transition.toScreenId === screenId)
      .map((transition) => describeTransition(transition, "incoming")),
    outgoing: map.transitions
      .filter((transition) => transition.fromScreenId === screenId)
      .map((transition) => describeTransition(transition, "outgoing")),
  });
}

export async function pathQuery(): Promise<void> {
  const map = await store.read();
  const from = required("from");
  const to = required("to");
  const attempts = shortestPath(map, [from], to);
  output({ ok: true, found: attempts !== null, from, to, attempts: attempts ?? [] });
}

export async function listJourneys(): Promise<void> {
  const map = await store.read();
  output({ ok: true, ...page(map.journeys) });
}

export async function getJourney(): Promise<void> {
  const map = await store.read();
  const journey = map.journeys.find((entry) => entry.id === required("id"));
  if (!journey) throw new ExploreError("Unknown journey");
  output({
    ok: true,
    journey,
    screens: journey.screenIds
      .map((id) => map.screens.find((screen) => screen.id === id))
      .filter(Boolean),
    attempts: journey.attemptIds
      .map((id) => map.actionAttempts.find((attempt) => attempt.id === id))
      .filter(Boolean),
  });
}

export async function listFrontier(): Promise<void> {
  const map = await store.read();
  const status = flag("status");
  const values = status
    ? map.frontier.filter((item) => item.status === status)
    : map.frontier;
  output({ ok: true, ...page(values) });
}

export async function listGaps(): Promise<void> {
  const map = await store.read();
  const status = flag("status");
  const values = status ? map.gaps.filter((gap) => gap.status === status) : map.gaps;
  output({ ok: true, ...page(values) });
}

export async function summary(): Promise<void> {
  const map = await store.read();
  const coverage = getCoverage(map);
  output({
    ok: true,
    run: map.run,
    revision: map.revision,
    coverage,
    startScreens: map.screens.filter((screen) => screen.start),
    topScreens: [...map.screens]
      .sort((left, right) => right.elementIds.length - left.elementIds.length)
      .slice(0, 10),
  });
}

export async function search(): Promise<void> {
  const map = await store.read();
  const terms = required("query")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matches = (values: Array<string | undefined>) => {
    const haystack = values.filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const result = [
    ...map.screens
      .filter((screen) => matches([screen.id, screen.title, screen.route, screen.state]))
      .map((value) => ({ kind: "screen", id: value.id, value })),
    ...map.elements
      .filter((element) =>
        matches([element.id, element.label, element.identifier, element.value, element.role]),
      )
      .map((value) => ({ kind: "element", id: value.id, value })),
    ...map.journeys
      .filter((journey) => matches([journey.id, journey.title]))
      .map((value) => ({ kind: "journey", id: value.id, value })),
  ];
  output({ ok: true, query: terms.join(" "), ...page(result) });
}

export async function status(): Promise<void> {
  const map = await store.read();
  output({ ok: true, run: map.run, revision: map.revision, coverage: getCoverage(map) });
}

export async function validate(): Promise<void> {
  const map = await store.read({ validateSchema: false });
  const errors = await validateMap(map, store);
  output({ ok: errors.length === 0, mapContract: map.contract, errors });
  if (errors.length > 0) process.exitCode = 1;
}

export async function exportArtifacts(): Promise<void> {
  const map = await store.read();
  const errors = await validateMap(map, store);
  if (errors.length) throw new ExploreError(`Cannot export invalid map: ${errors.join("; ")}`);
  const destination = resolve(process.cwd(), required("output"));
  await store.exportTo(destination, map);
  output({
    ok: true,
    output: destination,
    mapContract: map.contract,
    coverage: getCoverage(map),
  });
}
