export type ProjectionPoint = { x: number; y: number };
export type ProjectionViewport = ProjectionPoint & { zoom: number };
export type ProjectionSemanticLevel = "overview" | "structure" | "detail";

export type ProjectionMotionMetadata = {
  motionKey: string;
  role: "screen" | "summary";
  representedScreenIds: readonly string[];
  areaId?: string;
  branchId?: string;
  representativeScreenId?: string;
  areaRepresentativeScreenId?: string;
  branchRepresentativeScreenId?: string;
};

export type ProjectionMotionNode = {
  id: string;
  position: ProjectionPoint;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  parentId?: string;
  className?: string;
  data?: unknown;
};

export type ProjectionNodeMotion = "moving" | "enter" | "exit";

export type ProjectionTransitionFrames<T extends ProjectionMotionNode> = {
  source: T[];
  prepared: T[];
  active: T[];
};

export type ProjectionTransitionOptions = {
  fromLevel?: ProjectionSemanticLevel;
  toLevel?: ProjectionSemanticLevel;
};

export type ProjectionAnchorPair<T extends ProjectionMotionNode> = {
  from: T;
  to: T;
};

export type ProjectionCameraPlan = {
  target: ProjectionViewport;
  anchor?: {
    fromWorld: ProjectionPoint;
    toWorld: ProjectionPoint;
    fromScreen: ProjectionPoint;
    toScreen: ProjectionPoint;
  };
};

function dimensions(node: ProjectionMotionNode) {
  return {
    width: node.width ?? node.measured?.width ?? 0,
    height: node.height ?? node.measured?.height ?? 0,
  };
}

export function projectionNodeCenter(node: ProjectionMotionNode): ProjectionPoint {
  const size = dimensions(node);
  return {
    x: node.position.x + size.width / 2,
    y: node.position.y + size.height / 2,
  };
}

function positionedAtCenter<T extends ProjectionMotionNode>(node: T, center: ProjectionPoint): T {
  const size = dimensions(node);
  return {
    ...node,
    position: {
      x: center.x - size.width / 2,
      y: center.y - size.height / 2,
    },
  };
}

export function projectionMotionMetadata(node: ProjectionMotionNode): ProjectionMotionMetadata | undefined {
  const data = node.data as { projectionMotion?: ProjectionMotionMetadata } | undefined;
  return data?.projectionMotion;
}

export function projectionNodePendingExit(node: ProjectionMotionNode): boolean {
  const data = node.data as { projectionPendingExit?: boolean } | undefined;
  return data?.projectionPendingExit === true;
}

export function projectionNodeDelay(node: ProjectionMotionNode): number {
  const data = node.data as { projectionDelayMs?: number } | undefined;
  return data?.projectionDelayMs ?? 0;
}

function withProjectionPendingExit<T extends ProjectionMotionNode>(node: T, pending: boolean): T {
  const data = node.data && typeof node.data === "object"
    ? { ...(node.data as Record<string, unknown>) }
    : {};
  if (pending) data.projectionPendingExit = true;
  else delete data.projectionPendingExit;
  return { ...node, data };
}

function withProjectionDelay<T extends ProjectionMotionNode>(node: T, delayMs: number): T {
  const data = node.data && typeof node.data === "object"
    ? { ...(node.data as Record<string, unknown>) }
    : {};
  if (delayMs > 0) data.projectionDelayMs = delayMs;
  else delete data.projectionDelayMs;
  return { ...node, data };
}

function withProjectionScreenScale<T extends ProjectionMotionNode>(node: T, scale: number): T {
  const data = node.data && typeof node.data === "object"
    ? { ...(node.data as Record<string, unknown>) }
    : {};
  if (Math.abs(scale - 1) > 0.000001) data.projectionScreenScale = scale;
  else delete data.projectionScreenScale;
  return { ...node, data };
}

export function projectionNodeMotions(node: ProjectionMotionNode): ProjectionNodeMotion[] {
  const names = new Set((node.className ?? "").split(/\s+/));
  return (["moving", "enter", "exit"] as const)
    .filter((motion) => names.has(`canvas-node-${motion}`));
}

export function projectionNodeFadeOnly(node: ProjectionMotionNode): boolean {
  return (node.className ?? "").split(/\s+/).includes("projection-fade-only");
}

function withProjectionFadeOnly<T extends ProjectionMotionNode>(node: T, fadeOnly: boolean): T {
  const classes = (node.className ?? "")
    .split(/\s+/)
    .filter((name) => name && name !== "projection-fade-only");
  if (fadeOnly) classes.push("projection-fade-only");
  return { ...node, className: classes.join(" ") };
}

export function withProjectionMotions<T extends ProjectionMotionNode>(
  node: T,
  motions: readonly ProjectionNodeMotion[],
): T {
  const base = (node.className ?? "")
    .split(/\s+/)
    .filter((name) => name && !name.startsWith("canvas-node-"));
  return {
    ...node,
    className: [
      ...base,
      ...new Set(motions.map((motion) => `canvas-node-${motion}`)),
    ].join(" "),
  };
}

export function withProjectionMotion<T extends ProjectionMotionNode>(node: T, motion: ProjectionNodeMotion): T {
  return withProjectionMotions(node, [motion]);
}

function squaredDistance(left: ProjectionPoint, right: ProjectionPoint) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function nearestNode<T extends ProjectionMotionNode>(nodes: readonly T[], origin: ProjectionPoint): T | undefined {
  let nearest: T | undefined;
  let nearestDistance = Infinity;
  for (const node of nodes) {
    const distance = squaredDistance(projectionNodeCenter(node), origin);
    if (distance >= nearestDistance) continue;
    nearest = node;
    nearestDistance = distance;
  }
  return nearest;
}

function representsScreen(node: ProjectionMotionNode, screenId: string) {
  return node.id === screenId
    || projectionMotionMetadata(node)?.representedScreenIds.includes(screenId) === true;
}

function findScreenRepresentation<T extends ProjectionMotionNode>(nodes: readonly T[], screenId: string) {
  return nodes.find((node) => node.id === screenId)
    ?? nodes.find((node) => representsScreen(node, screenId));
}

/**
 * Finds the semantic parent/landmark that an entering node expands from or an exiting node
 * collapses into. Representative screens win, followed by a retained branch, then its area.
 */
function semanticCounterpart<T extends ProjectionMotionNode>(
  node: ProjectionMotionNode,
  candidates: readonly T[],
): T | undefined {
  const metadata = projectionMotionMetadata(node);
  if (!metadata) return undefined;
  // First follow the object itself. A hidden screen may be represented by an area summary even
  // when its branch representative remains visible; collapsing it into that unrelated landmark
  // would disagree with the camera anchor and break object continuity.
  for (const screenId of metadata.representedScreenIds) {
    const represented = findScreenRepresentation(candidates, screenId);
    if (represented) return represented;
  }
  for (const screenId of [
    metadata.branchRepresentativeScreenId,
    metadata.areaRepresentativeScreenId,
  ]) {
    if (!screenId) continue;
    const represented = findScreenRepresentation(candidates, screenId);
    if (represented) return represented;
  }
  const origin = projectionNodeCenter(node);
  if (metadata.branchId) {
    const branch = candidates.filter((candidate) => (
      projectionMotionMetadata(candidate)?.branchId === metadata.branchId
    ));
    const nearest = nearestNode(branch, origin);
    if (nearest) return nearest;
  }
  if (!metadata.areaId) return undefined;
  const area = candidates.filter((candidate) => (
    projectionMotionMetadata(candidate)?.areaId === metadata.areaId
  ));
  return nearestNode(area, origin);
}

function usesSelectiveObjectContinuity(options: ProjectionTransitionOptions) {
  // Unknown hierarchy information must be conservative. A generic viewer cannot assume that
  // two visually unrelated nodes are the same object merely because they share a nearby group.
  // Only the explicit overview/detail drill-down opts into the full spatial expansion.
  if (!options.fromLevel || !options.toLevel) return true;
  return !(
    (options.fromLevel === "overview" && options.toLevel === "detail")
    || (options.fromLevel === "detail" && options.toLevel === "overview")
  );
}

export function isAdjacentSemanticTransition(options: ProjectionTransitionOptions) {
  return (
    (options.fromLevel === "overview" && options.toLevel === "structure")
    || (options.fromLevel === "structure" && options.toLevel === "overview")
    || (options.fromLevel === "structure" && options.toLevel === "detail")
    || (options.fromLevel === "detail" && options.toLevel === "structure")
  );
}

function crossfadesUnmatchedNodes(options: ProjectionTransitionOptions) {
  return isAdjacentSemanticTransition(options)
    || (options.fromLevel === "detail" && options.toLevel === "detail");
}

function representativeScreenId(node: ProjectionMotionNode): string | undefined {
  const metadata = projectionMotionMetadata(node);
  if (!metadata) return undefined;
  if (metadata.role === "summary") return metadata.representativeScreenId;
  return metadata.representedScreenIds[0];
}

/**
 * Adjacent hierarchy levels are not literal parent/child layouts. Likewise, selecting another
 * flow inside Detail replaces one sibling result set with another; its summary card is a control,
 * not the physical source or destination of those screens. In both cases only nodes that retain
 * their concrete ID move and every unmatched object crossfades in place. The direct Overview <->
 * Detail drill-down remains spatial because it is intentionally one large navigation gesture and
 * was validated separately.
 */
function shouldMoveBetweenCounterparts(
  node: ProjectionMotionNode,
  counterpart: ProjectionMotionNode | undefined,
  options: ProjectionTransitionOptions,
) {
  if (!counterpart) return false;
  // Adjacent hierarchy levels retain their shared node IDs as the continuous objects. Anything
  // that exists on only one side crossfades at that side's own slot; manufacturing a summary ↔
  // phone morph would make the forward and reverse projections follow different visual paths.
  if (crossfadesUnmatchedNodes(options)) return false;
  if (!usesSelectiveObjectContinuity(options)) return true;
  const nodeMetadata = projectionMotionMetadata(node);
  const counterpartMetadata = projectionMotionMetadata(counterpart);
  if (!nodeMetadata || !counterpartMetadata) return false;
  if (nodeMetadata.role === counterpartMetadata.role) return false;
  const summary = nodeMetadata.role === "summary" ? node : counterpart;
  const screen = nodeMetadata.role === "screen" ? node : counterpart;
  const summaryRepresentative = representativeScreenId(summary);
  const screenId = representativeScreenId(screen);
  return Boolean(summaryRepresentative && screenId && summaryRepresentative === screenId);
}

function staggeredFadeDelays<T extends ProjectionMotionNode>(nodes: readonly T[]) {
  const bySemanticGroup = new Map<string, T[]>();
  for (const node of nodes) {
    const metadata = projectionMotionMetadata(node);
    const key = metadata?.branchId ?? metadata?.areaId ?? `node:${node.id}`;
    bySemanticGroup.set(key, [...(bySemanticGroup.get(key) ?? []), node]);
  }
  const groups = [...bySemanticGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => [...group].sort((left, right) => left.id.localeCompare(right.id)));
  const ordered: T[] = [];
  const largestGroup = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < largestGroup; index += 1) {
    for (const group of groups) {
      const node = group[index];
      if (node) ordered.push(node);
    }
  }
  const delays = new Map<string, number>();
  // Keep stagger cadence aligned with the 50%-faster 200ms projection timeline.
  const maximumDelay = nodes.length > 1 ? 64 : 0;
  ordered.forEach((node, index) => {
    delays.set(node.id, Math.round(index / Math.max(1, ordered.length - 1) * maximumDelay));
  });
  return delays;
}

/**
 * Prepares one stable frame before moving anything, then an active frame where shared nodes move.
 * One representative may cross a hierarchy boundary spatially; the remaining unmatched objects
 * crossfade in place so the same policy scales from a small prototype to a very large app.
 */
export function projectionTransitionFrames<T extends ProjectionMotionNode>(
  next: readonly T[],
  current: readonly T[],
  options: ProjectionTransitionOptions = {},
): ProjectionTransitionFrames<T> {
  const nextIds = new Set(next.map((node) => node.id));
  const nextMotionKeys = new Set(next.flatMap((node) => {
    const key = projectionMotionMetadata(node)?.motionKey;
    return key ? [key] : [];
  }));
  // A superseded generation may still carry fading exit nodes. Keep one only if the latest
  // projection explicitly revives its concrete or semantic identity; otherwise it would stack
  // another invisible generation behind every rapid tab click.
  const source = current.filter((node) => {
    const motions = projectionNodeMotions(node);
    if (!motions.includes("exit") && !projectionNodePendingExit(node)) return true;
    if (nextIds.has(node.id)) return true;
    const key = projectionMotionMetadata(node)?.motionKey;
    return Boolean(key && nextMotionKeys.has(key));
  });
  const currentById = new Map(source.map((node) => [node.id, node]));
  const leaving = source.filter((node) => !nextIds.has(node.id));
  const enteringPlans = new Map(next.flatMap((node) => {
    if (currentById.has(node.id)) return [];
    const counterpart = semanticCounterpart(node, source);
    return [[node.id, {
      counterpart,
      fadeOnly: !shouldMoveBetweenCounterparts(node, counterpart, options),
    }] as const];
  }));
  const leavingPlans = new Map(leaving.map((node) => {
    const counterpart = semanticCounterpart(node, next);
    return [node.id, {
      counterpart,
      fadeOnly: !shouldMoveBetweenCounterparts(node, counterpart, options),
    }] as const;
  }));
  const simultaneousCrossfade = crossfadesUnmatchedNodes(options);
  // Adjacent semantic levels are one reversible gesture, while a lateral Detail swap is one
  // result-set replacement. Staggering either case implies an ordering that does not exist, so
  // unmatched nodes crossfade simultaneously while retained summaries/screens remain continuous.
  const enteringDelays = simultaneousCrossfade
    ? new Map<string, number>()
    : staggeredFadeDelays(next.filter((node) => enteringPlans.get(node.id)?.fadeOnly));
  const leavingDelays = simultaneousCrossfade
    ? new Map<string, number>()
    : staggeredFadeDelays(leaving.filter((node) => leavingPlans.get(node.id)?.fadeOnly));

  const preparedArriving = next.map((node) => {
    const existing = currentById.get(node.id);
    if (existing) {
      const existingMotions = projectionNodeMotions(existing);
      return withProjectionPendingExit(withProjectionMotions(
        withProjectionDelay(withProjectionFadeOnly(
          { ...node, position: { ...existing.position } },
          false,
        ), 0),
        existingMotions.length > 0 ? existingMotions : ["moving"],
      ), false);
    }
    const plan = enteringPlans.get(node.id)!;
    const prepared = !plan.fadeOnly && plan.counterpart
      ? positionedAtCenter(node, projectionNodeCenter(plan.counterpart))
      : withProjectionFadeOnly(node, true);
    return withProjectionMotion(withProjectionDelay(
      prepared,
      enteringDelays.get(node.id) ?? 0,
    ), "enter");
  });
  // Mark obsolete nodes before the double-RAF reveal without changing their paint yet. A rapid
  // retarget can then prune this generation instead of carrying every prepared layout forward.
  // The marker lives in node data: changing a class cancels an in-flight CSS transform and snaps
  // the node to its logical target before the replacement transition can begin.
  const preparedLeaving = leaving.map((node) => {
    const paintedMotions = projectionNodeMotions(node);
    const continuingMotions: ProjectionNodeMotion[] = paintedMotions.length > 0
      ? paintedMotions
      : ["moving"];
    return withProjectionPendingExit(withProjectionMotions(
      node,
      continuingMotions,
    ), true);
  });

  const activeArriving = next.map((node) => {
    const existing = currentById.get(node.id);
    if (existing) {
      return withProjectionPendingExit(withProjectionMotion(
        withProjectionDelay(
          withProjectionFadeOnly(node, false),
          0,
        ),
        "moving",
      ), false);
    }
    const plan = enteringPlans.get(node.id)!;
    return withProjectionPendingExit(withProjectionMotion(
      withProjectionDelay(
        withProjectionFadeOnly(node, plan.fadeOnly),
        enteringDelays.get(node.id) ?? 0,
      ),
      "moving",
    ), false);
  });
  const activeLeaving = leaving.map((node) => {
    const plan = leavingPlans.get(node.id)!;
    const active = !plan.fadeOnly && plan.counterpart
      ? positionedAtCenter(node, projectionNodeCenter(plan.counterpart))
      : withProjectionFadeOnly(node, true);
    return withProjectionPendingExit(withProjectionMotion(withProjectionDelay(
      active,
      leavingDelays.get(node.id) ?? 0,
    ), "exit"), false);
  });

  return {
    source,
    prepared: [...preparedArriving, ...preparedLeaving],
    active: [...activeArriving, ...activeLeaving],
  };
}

/**
 * Converts a projection transition into a target-first screen-space FLIP. The target camera can
 * be committed together with `prepared` without changing the pixels the reader sees: every
 * existing node is moved to the inverse target-camera position and receives the inverse zoom.
 * `active` then moves retained nodes to their real target while fading exits at their original
 * screen rect. This avoids the curved W(t) * zoom(t) path produced by animating world layout and
 * camera independently.
 */
export function projectionScreenSpaceFrames<T extends ProjectionMotionNode>(
  frames: ProjectionTransitionFrames<T>,
  sourceViewport: ProjectionViewport,
  targetViewport: ProjectionViewport,
): ProjectionTransitionFrames<T> {
  if (sourceViewport.zoom <= 0 || targetViewport.zoom <= 0) return frames;
  const sourceById = new Map(frames.source.map((node) => [node.id, node]));
  const inverseScale = sourceViewport.zoom / targetViewport.zoom;
  const compensate = (node: T, source: T) => {
    const sourceCenter = projectionNodeCenter(source);
    const sourceScreenCenter = {
      x: sourceCenter.x * sourceViewport.zoom + sourceViewport.x,
      y: sourceCenter.y * sourceViewport.zoom + sourceViewport.y,
    };
    const targetWorldCenter = {
      x: (sourceScreenCenter.x - targetViewport.x) / targetViewport.zoom,
      y: (sourceScreenCenter.y - targetViewport.y) / targetViewport.zoom,
    };
    return withProjectionScreenScale(positionedAtCenter(node, targetWorldCenter), inverseScale);
  };

  const prepared = frames.prepared.map((node) => {
    const source = sourceById.get(node.id);
    if (!source) return node;
    // The inverse frame is committed without a CSS transition. The following active frame adds
    // the motion class only after the target camera and inverse geometry have painted once.
    return withProjectionMotions(compensate(node, source), []);
  });
  const preparedById = new Map(prepared.map((node) => [node.id, node]));
  const active = frames.active.map((node) => {
    if (projectionNodeMotions(node).includes("exit")) {
      const inverse = preparedById.get(node.id);
      return inverse
        ? withProjectionPendingExit(withProjectionMotion(withProjectionDelay(
            withProjectionFadeOnly(inverse, projectionNodeFadeOnly(node)),
            projectionNodeDelay(node),
          ), "exit"), false)
        : node;
    }
    return withProjectionScreenScale(node, 1);
  });
  return { source: frames.source, prepared, active };
}

/**
 * Returns the DOM node whose pixels represent the semantic anchor during this transition.
 * Expansions follow the entering child, collapses follow the leaving child, and retained objects
 * follow their stable node. Reading the destination summary during a collapse would jump the
 * camera to a different object on the first frame.
 */
export function projectionAnchorActor<T extends ProjectionMotionNode>(
  pair: ProjectionAnchorPair<T>,
  current: readonly T[],
  next: readonly T[],
): T {
  if (pair.from.id === pair.to.id) return pair.to;
  const fromRole = projectionMotionMetadata(pair.from)?.role;
  const toRole = projectionMotionMetadata(pair.to)?.role;
  // A hierarchy boundary has an unambiguous visual actor: the child. On expansion the entering
  // screen grows out of the summary; on collapse that same screen contracts back into it.
  if (fromRole === "summary" && toRole === "screen") return pair.to;
  if (fromRole === "screen" && toRole === "summary") return pair.from;
  const nextIds = new Set(next.map((node) => node.id));
  if (!nextIds.has(pair.from.id)) return pair.from;
  const currentIds = new Set(current.map((node) => node.id));
  if (!currentIds.has(pair.to.id)) return pair.to;
  return pair.to;
}

/** Selects the same semantic object on both sides of a projection change. */
export function selectProjectionAnchor<T extends ProjectionMotionNode>(
  current: readonly T[],
  next: readonly T[],
  preferredScreenId: string | undefined,
  viewportCenter: ProjectionPoint,
): ProjectionAnchorPair<T> | undefined {
  if (preferredScreenId) {
    const from = findScreenRepresentation(current, preferredScreenId);
    const to = findScreenRepresentation(next, preferredScreenId);
    if (from && to) return { from, to };
    if (from) {
      const counterpart = semanticCounterpart(from, next);
      if (counterpart) return { from, to: counterpart };
    }
    if (to) {
      const counterpart = semanticCounterpart(to, current);
      if (counterpart) return { from: counterpart, to };
    }
  }

  const nextById = new Map(next.map((node) => [node.id, node]));
  const shared = current.flatMap((from) => {
    const to = nextById.get(from.id);
    return to ? [{ from, to }] : [];
  });
  if (shared.length > 0) {
    let nearest = shared[0]!;
    let nearestDistance = squaredDistance(projectionNodeCenter(nearest.from), viewportCenter);
    for (const candidate of shared.slice(1)) {
      const distance = squaredDistance(projectionNodeCenter(candidate.from), viewportCenter);
      if (distance >= nearestDistance) continue;
      nearest = candidate;
      nearestDistance = distance;
    }
    return nearest;
  }

  const nextByMotionKey = new Map(next.flatMap((node) => {
    const key = projectionMotionMetadata(node)?.motionKey;
    return key ? [[key, node] as const] : [];
  }));
  const semanticMatches = current.flatMap((from) => {
    const key = projectionMotionMetadata(from)?.motionKey;
    const to = key ? nextByMotionKey.get(key) : undefined;
    return to ? [{ from, to }] : [];
  });
  if (semanticMatches.length > 0) {
    const from = nearestNode(semanticMatches.map((pair) => pair.from), viewportCenter)!;
    return semanticMatches.find((pair) => pair.from === from);
  }

  const from = nearestNode(current, viewportCenter);
  const to = from ? semanticCounterpart(from, next) : undefined;
  return from && to ? { from, to } : undefined;
}

/**
 * Selects an anchor whose painted actor really follows the planned path. A disappearing node that
 * crossfades in place cannot anchor the camera to a summary elsewhere: doing so makes the camera
 * follow an imaginary world-space movement and then snap to its real target at cleanup.
 */
export function selectProjectionMotionAnchor<T extends ProjectionMotionNode>(
  current: readonly T[],
  next: readonly T[],
  active: readonly T[],
  preferredScreenId: string | undefined,
  viewportCenter: ProjectionPoint,
): ProjectionAnchorPair<T> | undefined {
  const activeById = new Map(active.map((node) => [node.id, node]));
  const trackable = (pair: ProjectionAnchorPair<T> | undefined) => {
    if (!pair) return false;
    const actor = projectionAnchorActor(pair, current, next);
    const activeActor = activeById.get(actor.id);
    return Boolean(activeActor && !projectionNodeFadeOnly(activeActor));
  };

  if (preferredScreenId) {
    const preferred = selectProjectionAnchor(
      current,
      next,
      preferredScreenId,
      viewportCenter,
    );
    if (trackable(preferred)) return preferred;
    // If the preferred phone fades instead of morphing, keep its semantic destination: the same
    // summary ID usually exists in the source projection and is the correct area-level actor.
    for (const id of [preferred?.to.id, preferred?.from.id]) {
      if (!id) continue;
      const from = current.find((node) => node.id === id);
      const to = next.find((node) => node.id === id);
      const sharedPair = from && to ? { from, to } : undefined;
      if (trackable(sharedPair)) return sharedPair;
    }
  }

  // Stable IDs are the strongest remaining continuity signal. In a collapse this selects an area
  // summary already visible on both sides rather than a screen that is about to disappear.
  const nextById = new Map(next.map((node) => [node.id, node]));
  const shared = current.flatMap((from) => {
    const to = nextById.get(from.id);
    const pair = to ? { from, to } : undefined;
    return pair && trackable(pair) ? [pair] : [];
  });
  if (shared.length > 0) {
    let nearest = shared[0]!;
    let nearestDistance = squaredDistance(projectionNodeCenter(nearest.from), viewportCenter);
    for (const candidate of shared.slice(1)) {
      const distance = squaredDistance(projectionNodeCenter(candidate.from), viewportCenter);
      if (distance >= nearestDistance) continue;
      nearest = candidate;
      nearestDistance = distance;
    }
    return nearest;
  }

  const fallback = selectProjectionAnchor(current, next, undefined, viewportCenter);
  return trackable(fallback) ? fallback : undefined;
}

export function projectionContentBox(nodes: readonly ProjectionMotionNode[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.parentId) continue;
    const size = dimensions(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function constrainedTranslation(
  ideal: number,
  minimum: number,
  maximum: number,
  centered: number,
) {
  return minimum <= maximum ? clamp(ideal, minimum, maximum) : centered;
}

/**
 * Fits the incoming bounds while keeping the chosen semantic anchor at the same screen point
 * whenever the bounds permit it. If they do not, the anchor moves only as far as fit requires.
 */
export function projectionCameraPlan<T extends ProjectionMotionNode>(options: {
  current: readonly T[];
  next: readonly T[];
  startViewport: ProjectionViewport;
  canvasWidth: number;
  canvasHeight: number;
  padding: number;
  minZoom: number;
  maxZoom: number;
  preferredScreenId?: string;
  fromAnchorScreen?: ProjectionPoint;
  /** `null` explicitly disables anchoring; `undefined` retains automatic anchor selection. */
  anchorPair?: ProjectionAnchorPair<T> | null;
}): ProjectionCameraPlan | undefined {
  const box = projectionContentBox(options.next);
  if (!box || box.width <= 0 || box.height <= 0) return undefined;
  // Numeric React Flow padding is a ratio around the fitted bounds, not a percentage removed
  // from both viewport edges. Match `getViewportForBounds` so automatic projection fits land at
  // the same scale as the visible Fit canvas control.
  const availableWidth = options.canvasWidth / (1 + options.padding);
  const availableHeight = options.canvasHeight / (1 + options.padding);
  const boundsZoom = Math.min(availableWidth / box.width, availableHeight / box.height);
  const zoom = Math.min(options.maxZoom, Math.max(options.minZoom, boundsZoom));
  const centered = {
    x: (options.canvasWidth - box.width * zoom) / 2 - box.minX * zoom,
    y: (options.canvasHeight - box.height * zoom) / 2 - box.minY * zoom,
  };
  const viewportCenter = {
    x: (options.canvasWidth / 2 - options.startViewport.x) / options.startViewport.zoom,
    y: (options.canvasHeight / 2 - options.startViewport.y) / options.startViewport.zoom,
  };
  const anchorPair = options.anchorPair === undefined
    ? selectProjectionAnchor(
        options.current,
        options.next,
        options.preferredScreenId,
        viewportCenter,
      )
    : options.anchorPair ?? undefined;
  if (!anchorPair) return { target: { ...centered, zoom } };

  const logicalFromWorld = projectionNodeCenter(anchorPair.from);
  const fromScreen = options.fromAnchorScreen ?? {
    x: logicalFromWorld.x * options.startViewport.zoom + options.startViewport.x,
    y: logicalFromWorld.y * options.startViewport.zoom + options.startViewport.y,
  };
  // A rapid retarget may catch a CSS transform between logical positions. Converting the actual
  // screen rect back through the current camera gives the world point the eye is following now.
  const fromWorld = {
    x: (fromScreen.x - options.startViewport.x) / options.startViewport.zoom,
    y: (fromScreen.y - options.startViewport.y) / options.startViewport.zoom,
  };
  const toWorld = projectionNodeCenter(anchorPair.to);
  const paddingX = (options.canvasWidth - availableWidth) / 2;
  const paddingY = (options.canvasHeight - availableHeight) / 2;
  const minX = paddingX - box.minX * zoom;
  const maxX = options.canvasWidth - paddingX - (box.minX + box.width) * zoom;
  const minY = paddingY - box.minY * zoom;
  const maxY = options.canvasHeight - paddingY - (box.minY + box.height) * zoom;
  const target = {
    zoom,
    x: constrainedTranslation(fromScreen.x - toWorld.x * zoom, minX, maxX, centered.x),
    y: constrainedTranslation(fromScreen.y - toWorld.y * zoom, minY, maxY, centered.y),
  };
  return {
    target,
    anchor: {
      fromWorld,
      toWorld,
      fromScreen,
      toScreen: {
        x: toWorld.x * target.zoom + target.x,
        y: toWorld.y * target.zoom + target.y,
      },
    },
  };
}

function cubicCoordinate(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first
    + 3 * inverse * t * t * second
    + t * t * t;
}

function cubicDerivative(t: number, first: number, second: number) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * first
    + 6 * inverse * t * (second - first)
    + 3 * t * t * (1 - second);
}

/** Matches CSS `cubic-bezier(0.42, 0, 0.58, 1)` for the camera RAF. */
export function projectionEasing(progress: number) {
  const x = clamp(progress, 0, 1);
  let parameter = x;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const derivative = cubicDerivative(parameter, 0.42, 0.58);
    if (Math.abs(derivative) < 0.000001) break;
    parameter = clamp(
      parameter - (cubicCoordinate(parameter, 0.42, 0.58) - x) / derivative,
      0,
      1,
    );
  }
  return cubicCoordinate(parameter, 0, 1);
}
