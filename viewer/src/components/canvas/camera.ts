export type CanvasViewport = {
  x: number;
  y: number;
  zoom: number;
  /** Optional history hint used to re-anchor this camera in a newly sized visible frame. */
  center?: { x: number; y: number };
};

/**
 * The unobscured portion of a React Flow canvas, expressed in canvas-local screen pixels.
 * `revision` lets consumers distinguish layout generations whose numeric bounds happen to match.
 */
export type CanvasVisibleFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  revision: number;
};

export type CanvasBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CanvasBoundsViewportOptions = {
  canvasWidth: number;
  canvasHeight: number;
  minZoom: number;
  maxZoom: number;
  padding?: number;
  /** Start-align this far inside a visible frame inset by a real left-side occluder. */
  leftInset?: number;
  /** When supplied, anchor the fitted bounds exactly this far below the visible frame top. */
  topInset?: number;
  visibleFrame?: CanvasVisibleFrame;
};

export type CanvasRecenterViewportOptions = {
  canvasWidth: number;
  canvasHeight: number;
  visibleFrame?: CanvasVisibleFrame;
};

export type CanvasPriorityPrefixOptions = {
  canvasWidth: number;
  canvasHeight: number;
  readableZoom: number;
  padding?: number;
  visibleFrame?: CanvasVisibleFrame;
};

export type CanvasPriorityPrefix = {
  nodeIds: string[];
  bounds: CanvasBounds;
  fitZoom: number;
};

/** Shared contract for the persistent Fit action and panel-driven selected-item refits. */
export const CANVAS_SELECTION_FIT_PADDING = 0.25;
export const CANVAS_SELECTION_MAX_ZOOM = 1.2;

/**
 * The largest settled frame seen for one projection layout. Priority inventory canvases use this
 * frame to choose one stable leading node set, then fit that same set into every panel geometry.
 */
export type CanvasPriorityFitReference = {
  canvasWidth: number;
  canvasHeight: number;
  visibleFrame: CanvasVisibleFrame;
};

export type CanvasPriorityProjectionOptions = {
  canvasWidth: number;
  canvasHeight: number;
  padding: number;
  priorityNodeIds?: readonly string[];
  readableZoomFloor?: number;
  visibleFrame?: CanvasVisibleFrame;
  priorityFitReference?: CanvasPriorityFitReference;
};

export type CanvasViewportSource = "gesture" | "programmatic";
export type CanvasViewportPhase = "continuous" | "end";

/**
 * A serializable camera update. `x`, `y`, and `zoom` can be saved directly; `center` is the
 * equivalent world-space point used by semantic-map navigation heuristics.
 */
export type CanvasViewportChangeEvent = CanvasViewport & {
  center: { x: number; y: number };
  source: CanvasViewportSource;
  phase: CanvasViewportPhase;
};

export type CanvasCameraNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  parentId?: string;
  selected?: boolean;
  hidden?: boolean;
};

function finite(value: number) {
  return Number.isFinite(value);
}

function validCanvasDimensions(width: number, height: number) {
  return finite(width) && finite(height) && width > 0 && height > 0;
}

function validBounds(bounds: CanvasBounds) {
  return finite(bounds.x)
    && finite(bounds.y)
    && validCanvasDimensions(bounds.width, bounds.height);
}

/**
 * Intersects a measured visible frame with its canvas. Omitting the frame means the whole canvas
 * is visible; supplying corrupt or completely occluded geometry returns `undefined`.
 */
export function normalizeCanvasVisibleFrame(
  frame: CanvasVisibleFrame | undefined,
  canvasWidth: number,
  canvasHeight: number,
): CanvasVisibleFrame | undefined {
  if (!validCanvasDimensions(canvasWidth, canvasHeight)) return undefined;
  if (!frame) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight, revision: 0 };
  }
  if (
    !finite(frame.x)
    || !finite(frame.y)
    || !finite(frame.width)
    || !finite(frame.height)
    || !finite(frame.revision)
    || frame.width <= 0
    || frame.height <= 0
  ) return undefined;
  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(canvasWidth, frame.x + frame.width);
  const bottom = Math.min(canvasHeight, frame.y + frame.height);
  if (right <= left || bottom <= top) return undefined;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    revision: frame.revision,
  };
}

function normalizePadding(padding: number | undefined) {
  const value = padding ?? 0;
  if (!finite(value) || value < 0 || value >= 0.5) return undefined;
  return value;
}

function fittedCanvasZoom(
  bounds: CanvasBounds,
  frame: CanvasVisibleFrame,
  padding: number,
) {
  const contentWidth = frame.width * (1 - padding * 2);
  const contentHeight = frame.height * (1 - padding * 2);
  if (!validCanvasDimensions(contentWidth, contentHeight)) return undefined;
  return Math.min(contentWidth / bounds.width, contentHeight / bounds.height);
}

/** Plans a centred or explicitly top-anchored fit inside the visible canvas frame. */
export function canvasBoundsViewport(
  bounds: CanvasBounds,
  options: CanvasBoundsViewportOptions,
): CanvasViewport | undefined {
  if (
    !validBounds(bounds)
    || !finite(options.minZoom)
    || !finite(options.maxZoom)
    || options.minZoom <= 0
    || options.maxZoom < options.minZoom
  ) return undefined;
  const frame = normalizeCanvasVisibleFrame(
    options.visibleFrame,
    options.canvasWidth,
    options.canvasHeight,
  );
  const padding = normalizePadding(options.padding);
  if (!frame || padding === undefined) return undefined;
  if (options.topInset !== undefined && (!finite(options.topInset) || options.topInset < 0)) {
    return undefined;
  }
  if (options.leftInset !== undefined && (!finite(options.leftInset) || options.leftInset < 0)) {
    return undefined;
  }
  const fittedZoom = fittedCanvasZoom(bounds, frame, padding);
  if (!fittedZoom || !finite(fittedZoom)) return undefined;
  const zoom = Math.min(options.maxZoom, Math.max(options.minZoom, fittedZoom));
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const startAligned = options.leftInset !== undefined && frame.x > 0;
  return {
    zoom,
    x: startAligned
      ? frame.x + options.leftInset! - bounds.x * zoom
      : frame.x + frame.width / 2 - centerX * zoom,
    y: options.topInset === undefined
      ? frame.y + frame.height / 2 - centerY * zoom
      : frame.y + options.topInset - bounds.y * zoom,
  };
}

/**
 * Plans a width-led inventory fit inside the visible frame. The content remains horizontally
 * centred, while its top edge is anchored to the frame padding so tall inventories begin where
 * readers expect instead of being vertically centred far below the canvas chrome.
 */
export function canvasWidthViewport(
  bounds: CanvasBounds,
  options: CanvasBoundsViewportOptions,
): CanvasViewport | undefined {
  if (
    !validBounds(bounds)
    || !finite(options.minZoom)
    || !finite(options.maxZoom)
    || options.minZoom <= 0
    || options.maxZoom < options.minZoom
  ) return undefined;
  const frame = normalizeCanvasVisibleFrame(
    options.visibleFrame,
    options.canvasWidth,
    options.canvasHeight,
  );
  const padding = normalizePadding(options.padding);
  if (!frame || padding === undefined) return undefined;
  if (options.topInset !== undefined && (!finite(options.topInset) || options.topInset < 0)) {
    return undefined;
  }
  const contentWidth = frame.width * (1 - padding * 2);
  if (!finite(contentWidth) || contentWidth <= 0) return undefined;
  const fittedZoom = contentWidth / bounds.width;
  if (!finite(fittedZoom) || fittedZoom <= 0) return undefined;
  const zoom = Math.min(options.maxZoom, Math.max(options.minZoom, fittedZoom));
  const centerX = bounds.x + bounds.width / 2;
  const topInset = options.topInset ?? frame.height * padding;
  return {
    zoom,
    x: frame.x + frame.width / 2 - centerX * zoom,
    y: frame.y + topInset - bounds.y * zoom,
  };
}

/** Keeps a camera's zoom while moving world-space bounds to the visible frame's centre. */
export function canvasRecenterViewport(
  bounds: CanvasBounds,
  zoom: number,
  options: CanvasRecenterViewportOptions,
): CanvasViewport | undefined {
  if (!validBounds(bounds) || !finite(zoom) || zoom <= 0) return undefined;
  const frame = normalizeCanvasVisibleFrame(
    options.visibleFrame,
    options.canvasWidth,
    options.canvasHeight,
  );
  if (!frame) return undefined;
  return {
    zoom,
    x: frame.x + frame.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: frame.y + frame.height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** Rejects corrupt persisted values and constrains a valid zoom to this canvas' limits. */
export function normalizeCanvasViewport(
  viewport: CanvasViewport | undefined,
  minZoom: number,
  maxZoom: number,
): CanvasViewport | undefined {
  if (
    !viewport
    || !finite(viewport.x)
    || !finite(viewport.y)
    || !finite(viewport.zoom)
    || viewport.zoom <= 0
  ) return undefined;
  return {
    x: viewport.x,
    y: viewport.y,
    zoom: Math.min(maxZoom, Math.max(minZoom, viewport.zoom)),
    ...(viewport.center
      && finite(viewport.center.x)
      && finite(viewport.center.y)
      ? { center: { ...viewport.center } }
      : {}),
  };
}

/**
 * An explicit identity lets history entries restore identical coordinates as separate events.
 * Without one, value equality prevents an inline object from repeatedly taking over the camera.
 */
export function canvasViewportRestoreToken(
  viewport: CanvasViewport | undefined,
  identity: string | number | undefined,
): string | undefined {
  if (!viewport) return undefined;
  const value = `viewport:${viewport.x}:${viewport.y}:${viewport.zoom}`;
  if (identity !== undefined) return `${typeof identity}:${String(identity)}:${value}`;
  return value;
}

export function canvasViewportChangeEvent(
  viewport: CanvasViewport,
  width: number,
  height: number,
  source: CanvasViewportSource,
  phase: CanvasViewportPhase,
  visibleFrame?: CanvasVisibleFrame,
): CanvasViewportChangeEvent | undefined {
  if (!finite(viewport.x) || !finite(viewport.y) || !finite(viewport.zoom) || viewport.zoom <= 0) {
    return undefined;
  }
  const frame = normalizeCanvasVisibleFrame(visibleFrame, width, height);
  if (!frame) return undefined;
  return {
    ...viewport,
    center: {
      x: (frame.x + frame.width / 2 - viewport.x) / viewport.zoom,
      y: (frame.y + frame.height / 2 - viewport.y) / viewport.zoom,
    },
    source,
    phase,
  };
}

function absoluteNodePosition(
  node: CanvasCameraNode,
  byId: ReadonlyMap<string, CanvasCameraNode>,
) {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>([node.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/** Returns a node's world-space bounds, including every available ancestor offset. */
export function canvasCameraNodeBounds(
  nodes: readonly CanvasCameraNode[],
  nodeId: string,
): CanvasBounds | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId);
  if (!node) return undefined;
  const width = node.width ?? node.measured?.width ?? 0;
  const height = node.height ?? node.measured?.height ?? 0;
  const position = absoluteNodePosition(node, byId);
  const bounds = { ...position, width, height };
  return validBounds(bounds) ? bounds : undefined;
}

function unionCanvasBounds(left: CanvasBounds, right: CanvasBounds): CanvasBounds {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

/** True when any part of a node's box is inside the visible frame at the given camera. */
export function canvasNodeVisible(
  nodes: readonly CanvasCameraNode[],
  nodeId: string,
  viewport: { x: number; y: number; zoom: number },
  visibleFrame: CanvasVisibleFrame,
): boolean {
  const bounds = canvasCameraNodeBounds(nodes, nodeId);
  if (!bounds) return false;
  const left = bounds.x * viewport.zoom + viewport.x;
  const top = bounds.y * viewport.zoom + viewport.y;
  return left < visibleFrame.x + visibleFrame.width
    && top < visibleFrame.y + visibleFrame.height
    && left + bounds.width * viewport.zoom > visibleFrame.x
    && top + bounds.height * viewport.zoom > visibleFrame.y;
}

/** Resolves the same visible selection for persistent Fit and panel-driven camera commands. */
export function canvasSelectionNodeIds(
  nodes: readonly CanvasCameraNode[],
  preferredNodeId?: string | null,
): string[] {
  if (
    preferredNodeId
    && nodes.some((node) => node.id === preferredNodeId && !node.hidden)
  ) return [preferredNodeId];
  return nodes.flatMap((node) => (node.selected && !node.hidden ? [node.id] : []));
}

/** Calculates the canonical camera for the currently selected canvas nodes. */
export function canvasSelectionViewport(
  nodes: readonly CanvasCameraNode[],
  selectedNodeIds: readonly string[],
  options: {
    canvasWidth: number;
    canvasHeight: number;
    minZoom: number;
    maxZoom: number;
    visibleFrame?: CanvasVisibleFrame;
  },
): CanvasViewport | undefined {
  let bounds: CanvasBounds | undefined;
  const seen = new Set<string>();
  for (const nodeId of selectedNodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const nodeBounds = canvasCameraNodeBounds(nodes, nodeId);
    if (!nodeBounds) continue;
    bounds = bounds ? unionCanvasBounds(bounds, nodeBounds) : nodeBounds;
  }
  return bounds ? canvasBoundsViewport(bounds, {
    canvasWidth: options.canvasWidth,
    canvasHeight: options.canvasHeight,
    minZoom: options.minZoom,
    maxZoom: Math.min(options.maxZoom, CANVAS_SELECTION_MAX_ZOOM),
    padding: CANVAS_SELECTION_FIT_PADDING,
    ...(options.visibleFrame ? { visibleFrame: options.visibleFrame } : {}),
  }) : undefined;
}

/**
 * Selects the largest leading run of priority-ordered nodes that still fits at a readable zoom.
 * The first valid node is always retained, even when it alone is larger than the frame.
 */
export function canvasPriorityNodePrefix(
  nodes: readonly CanvasCameraNode[],
  priorityNodeIds: readonly string[],
  options: CanvasPriorityPrefixOptions,
): CanvasPriorityPrefix | undefined {
  if (!finite(options.readableZoom) || options.readableZoom <= 0) return undefined;
  const frame = normalizeCanvasVisibleFrame(
    options.visibleFrame,
    options.canvasWidth,
    options.canvasHeight,
  );
  const padding = normalizePadding(options.padding);
  if (!frame || padding === undefined) return undefined;

  let bounds: CanvasBounds | undefined;
  let fitZoom = 0;
  const nodeIds: string[] = [];
  const seen = new Set<string>();
  for (const nodeId of priorityNodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const candidateBounds = canvasCameraNodeBounds(nodes, nodeId);
    if (!candidateBounds) continue;
    const nextBounds = bounds ? unionCanvasBounds(bounds, candidateBounds) : candidateBounds;
    const nextFitZoom = fittedCanvasZoom(nextBounds, frame, padding);
    if (!nextFitZoom) continue;
    if (bounds && nextFitZoom < options.readableZoom) break;
    bounds = nextBounds;
    fitZoom = nextFitZoom;
    nodeIds.push(nodeId);
  }
  return bounds ? { nodeIds, bounds, fitZoom } : undefined;
}

/**
 * Keeps the authored priority shelf stable while fitting it into the current visible frame.
 * Without the reference, a narrower panel geometry can silently swap to fewer nodes and produce
 * the exact same camera transform, making a real panel refit look like a no-op.
 */
export function canvasPriorityProjectionBounds(
  nodes: readonly CanvasCameraNode[],
  fullBounds: CanvasBounds,
  options: CanvasPriorityProjectionOptions,
): CanvasBounds {
  const frame = normalizeCanvasVisibleFrame(
    options.visibleFrame,
    options.canvasWidth,
    options.canvasHeight,
  );
  const readableZoom = options.readableZoomFloor;
  if (
    !frame
    || !options.priorityNodeIds?.length
    || !readableZoom
    || readableZoom <= 0
    || !validBounds(fullBounds)
  ) return fullBounds;
  const padding = normalizePadding(options.padding);
  if (padding === undefined) return fullBounds;
  const fullFitZoom = fittedCanvasZoom(fullBounds, frame, padding);
  if (!fullFitZoom || fullFitZoom >= readableZoom) return fullBounds;
  const reference = options.priorityFitReference ?? {
    canvasWidth: options.canvasWidth,
    canvasHeight: options.canvasHeight,
    visibleFrame: frame,
  };
  return canvasPriorityNodePrefix(nodes, options.priorityNodeIds, {
    canvasWidth: reference.canvasWidth,
    canvasHeight: reference.canvasHeight,
    readableZoom,
    padding,
    visibleFrame: reference.visibleFrame,
  })?.bounds ?? fullBounds;
}

/** Calculates the same centred focus camera before React Flow has mounted/measured its nodes. */
export function canvasFocusViewport(
  nodes: readonly CanvasCameraNode[],
  nodeId: string,
  canvasWidth: number,
  canvasHeight: number,
  minZoom: number,
  maxZoom: number,
  padding: number,
  visibleFrame?: CanvasVisibleFrame,
): CanvasViewport | undefined {
  const bounds = canvasCameraNodeBounds(nodes, nodeId);
  return bounds
    ? canvasBoundsViewport(bounds, {
        canvasWidth,
        canvasHeight,
        minZoom,
        maxZoom,
        padding,
        ...(visibleFrame ? { visibleFrame } : {}),
      })
    : undefined;
}
