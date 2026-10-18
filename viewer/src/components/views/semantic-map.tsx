import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Handle, MarkerType, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  CanvasStage,
  screenFocus,
  type CanvasViewport,
  type CanvasViewportChangeEvent,
} from "../canvas/stage";
import type { ProjectionMotionMetadata } from "../canvas/projection-motion";
import { ScreenScreenshotCard } from "../canvas/screen-screenshot-card";
import { TransitionEdge, type TransitionGraphEdge } from "../canvas/transition-edge";
import {
  buildViewerGraph,
  isBlackBoxMap,
  projectFullGraph,
  type ConnectionGroup,
  type GraphProjection,
  type ProjectionNode,
} from "../../utils/graph-model";
import { artifactUrl, isLaunchScreen, type ExploreMap, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize, typicalScreenshotSize, type ScreenshotSize } from "../../utils/screen-images";
import { mapFrame, type MapFrame } from "../../utils/map-frame";
import type { BuildDiff, DiffStatus } from "../../utils/build-diff";
import { CANVAS_MAX_ZOOM } from "../../utils/canvas-zoom";
import { usePhoneLayout } from "../../utils/phone-layout";
import type { FocusBehavior, FocusRequest, FocusStatus, MapDirection } from "../../utils/navigation";
import { focusStatusOf } from "../../utils/changed-screens";
import { displayPathForScreen } from "../../utils/screen-path";
import { shortcutsLive } from "../../utils/shortcuts";
import { arrowsOwnedBy, mapKeyDirection, mapKeyEntry, mapKeyTarget, type MapKeyDirection } from "../../utils/map-keyboard";
import { createKeyHold } from "../../utils/key-hold";

const HOVER_CLEAR_DELAY = 180;
const MAP_LAYOUT_REVISION = "flat-v1";
const MAP_FIT_VIEW_OPTIONS = {
  padding: 0.04,
  minZoom: 0.02,
  maxZoom: 0.9,
};
const MAP_READABLE_ZOOM_FLOOR = 0.08;
// A phone frame is a fifth of a desktop one: a run that fits whole there is thumbnails, so Fit frames the start of the map instead.
const MAP_PHONE_READABLE_ZOOM_FLOOR = 0.28;
// The phone's top bar (53px and its hairline) sits over the canvas; Fit starts the map below it so the first
// card's title is not under the bar when the map is a column.
const MAP_PHONE_FIT_TOP_INSET = 54 + 16;
type Point = { x: number; y: number };
/** A screen's representative screenshot and, when recorded, its pixel size. */
type MapScreenshot = { url: string; size?: ScreenshotSize };
type ScreenNodeData = {
  screen: Screen;
  /** A black-box screen: title is the heading, no route to copy. */
  plainTitle?: boolean;
  screenshot?: string;
  screenshotSize?: ScreenshotSize;
  /** Why the screen has no screenshot, when the run recorded a reason (a capture-protected screen). */
  missingReason?: string;
  highlighted: boolean;
  direction: MapDirection;
  frame: MapFrame;
  diff?: DiffStatus;
  accessibilityOnly?: boolean;
  projectionDelayMs?: number;
  projectionScreenScale?: number;
  projectionMotion: ProjectionMotionMetadata;
  onSelect: (id: string) => void;
  onHover: (id: string | undefined) => void;
};
/** How many of an area's screens the review found changed, by status, in display order. */
type ScreenGraphNode = Node<ScreenNodeData, "screen">;
type CanvasGraphNode = ScreenGraphNode;
type ProjectedStructure = {
  projectionNodes: ProjectionNode[];
  groups: ConnectionGroup[];
  positions: Map<string, Point>;
  screenshots: Map<string, MapScreenshot | undefined>;
  /** Every card's size, from the shape of the run's screenshots. */
  frame: MapFrame;
  screenNotes: Map<string, string>;
  hoverPaths: Map<string, { nodeIds: Set<string>; edgeIds: Set<string> }>;
  primaryEdgeKeys: Set<string>;
  horizontal: boolean;
  /** A black-box exploration names screens by what it saw, not by a route. */
  plainTitles: boolean;
};

function ScreenNodeCard({ data, selected }: NodeProps<ScreenGraphNode>) {
  const horizontal = data.direction === "LR";
  const path = displayPathForScreen(data.screen);
  return (
    <ScreenScreenshotCard
      className="screen-node"
      title={data.screen.title}
      path={path}
      {...(data.plainTitle ? { plainTitle: true } : {})}
      {...(data.screenshot ? { screenshot: data.screenshot } : {})}
      {...(data.missingReason ? { missingReason: data.missingReason } : {})}
      {...(data.diff ? { diff: data.diff } : {})}
      {...(data.accessibilityOnly ? { accessibilityOnly: true } : {})}
      selected={selected}
      highlighted={data.highlighted}
      style={{
        "--map-screen-width": `${data.frame.width}px`,
        "--map-screen-height": `${data.frame.height}px`,
        "--projection-delay": `${data.projectionDelayMs ?? 0}ms`,
        "--projection-scale": data.projectionScreenScale ?? 1,
        ...(data.projectionScreenScale !== undefined
          ? { transform: `scale(${data.projectionScreenScale})` }
          : {}),
      } as CSSProperties}
      ariaLabel={`Open ${data.screen.title}`}
      ariaPressed={selected}
      // The slot's own proportions stand in only when the screenshot's size is not recorded.
      // A screenshot of unrecorded size, or none, is framed like the run's other screenshots.
      imageWidth={data.screenshotSize?.imageWidth ?? data.frame.screen.width}
      imageHeight={data.screenshotSize?.imageHeight ?? data.frame.screen.height}
      placeholderSize={data.frame.screen}
      loading="lazy"
      leading={<Handle type="target" position={horizontal ? Position.Left : Position.Top} className="graph-handle" />}
      trailing={<Handle type="source" position={horizontal ? Position.Right : Position.Bottom} className="graph-handle" />}
      onMouseEnter={() => data.onHover(data.screen.id)}
      onMouseLeave={() => data.onHover(undefined)}
      onClick={() => data.onSelect(data.screen.id)}
    />
  );
}

const NODE_TYPES = { screen: ScreenNodeCard };
const EDGE_TYPES = { transition: TransitionEdge };

function conciseActionLabel(label: string): string | undefined {
  if (/^Continue in .+ \(\d+ → \d+\)$/i.test(label)) return undefined;
  const concise = label.replace(/\s+\(\d+ → \d+\)$/, "");
  return /^(continue|next|open)$/i.test(concise) ? undefined : concise;
}

function nodeDimensions(frame: MapFrame) {
  return { width: frame.width, height: frame.height };
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

function edgeElementId(groupKey: string) {
  return `edge-${encodeURIComponent(groupKey)}`;
}

function spanningEdges(nodes: readonly ProjectionNode[], groups: readonly ConnectionGroup[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const { outgoing } = adjacency(groups);
  const result = new Set<string>();
  const visited = new Set<string>();
  const roots = [
    ...nodes.filter((node) => node.kind === "screen" && isLaunchScreen(node.screen)),
    ...nodes.filter((node) => node.kind === "screen" && node.screen.start),
    ...nodes.filter((node) => node.kind !== "screen" || !node.screen.start),
  ];
  for (const root of roots) {
    if (visited.has(root.id)) continue;
    visited.add(root.id);
    const queue = [root.id];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const group of outgoing.get(queue[cursor]!) ?? []) {
        if (!nodeIds.has(group.to) || visited.has(group.to)) continue;
        visited.add(group.to);
        result.add(group.key);
        queue.push(group.to);
      }
    }
  }
  return result;
}

function hoverNeighborhood(nodes: readonly ProjectionNode[], groups: readonly ConnectionGroup[]) {
  const { outgoing, incoming } = adjacency(groups);
  const result = new Map<string, { nodeIds: Set<string>; edgeIds: Set<string> }>();
  for (const node of nodes) {
    if (node.kind !== "screen") continue;
    const nodeIds = new Set([node.id]);
    const edgeIds = new Set<string>();
    const include = (group: ConnectionGroup) => {
      edgeIds.add(edgeElementId(group.key));
      nodeIds.add(group.from);
      nodeIds.add(group.to);
    };
    for (const group of outgoing.get(node.id) ?? []) include(group);
    for (const group of incoming.get(node.id) ?? []) include(group);
    result.set(node.id, { nodeIds, edgeIds });
  }
  return result;
}

/**
 * One card per screen, layered by how many transitions it took to reach it from the start screen;
 * a screen never reached by a recorded transition joins the last layer. Edges are the transitions.
 */
function flatPositions(projection: GraphProjection, frame: MapFrame): { positions: Map<string, Point>; horizontal: boolean } {
  const screenNodes = projection.nodes.filter((node): node is Extract<ProjectionNode, { kind: "screen" }> => node.kind === "screen");
  const ids = new Set(screenNodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  for (const group of projection.groups) {
    if (group.from === group.to || !ids.has(group.from) || !ids.has(group.to)) continue;
    outgoing.set(group.from, [...(outgoing.get(group.from) ?? []), group.to]);
  }
  const depth = new Map<string, number>();
  // The launch sits above the start screens it leads into; without one the start screens head the map.
  const launch = screenNodes.filter((node) => isLaunchScreen(node.screen));
  const queue = (launch.length ? launch : screenNodes.filter((node) => node.screen.start)).map((node) => node.id);
  if (queue.length === 0 && screenNodes[0]) queue.push(screenNodes[0].id);
  for (const id of queue) depth.set(id, 0);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const next of outgoing.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(current)! + 1);
      queue.push(next);
    }
  }
  const deepest = Math.max(0, ...depth.values());
  const layers = new Map<number, string[]>();
  for (const node of screenNodes) {
    const layer = depth.get(node.id) ?? deepest + (depth.size < screenNodes.length ? 1 : 0);
    layers.set(layer, [...(layers.get(layer) ?? []), node.id]);
  }
  // Lay the deeper axis along the wider screen axis: a long chain of taps reads left to right.
  const horizontal = layers.size > Math.max(...[...layers.values()].map((members) => members.length));
  const alongPitch = (horizontal ? frame.width : frame.height) + 160;
  const acrossPitch = (horizontal ? frame.height : frame.width) + 56;
  const positions = new Map<string, Point>();
  // Order each layer by where its parents sit in the previous one so edges cross as little as possible.
  const incoming = new Map<string, string[]>();
  for (const [from, targets] of outgoing) for (const to of targets) incoming.set(to, [...(incoming.get(to) ?? []), from]);
  const slot = new Map<string, number>();
  for (const layer of [...layers.keys()].sort((left, right) => left - right)) {
    const members = layers.get(layer)!;
    const weight = (id: string) => {
      const parents = (incoming.get(id) ?? []).map((from) => slot.get(from)).filter((value): value is number => value !== undefined);
      return parents.length ? parents.reduce((sum, value) => sum + value, 0) / parents.length : Number.POSITIVE_INFINITY;
    };
    members.sort((left, right) => weight(left) - weight(right) || left.localeCompare(right));
    members.forEach((id, index) => slot.set(id, index - (members.length - 1) / 2));
  }
  for (const [layer, members] of layers) {
    members.forEach((id, index) => {
      const along = layer * alongPitch;
      const across = (index - (members.length - 1) / 2) * acrossPitch;
      positions.set(id, horizontal ? { x: along, y: across } : { x: across, y: along });
    });
  }
  return { positions, horizontal };
}

function projectedStructure(projection: GraphProjection, index: MapIndex, plainTitles: boolean): ProjectedStructure {
  const screenshots = new Map(projection.nodes.map((node) => {
    const artifact = primaryScreenshotForScreen(node.screen, index);
    const url = artifactUrl(artifact);
    const size = screenshotSize(artifact);
    return [node.id, url ? { url, ...(size ? { size } : {}) } : undefined] as const;
  }));
  const frame = mapFrame(typicalScreenshotSize([...screenshots.values()].map((screenshot) => screenshot?.size)));
  const { positions, horizontal } = flatPositions(projection, frame);
  return {
    screenNotes: index.screenNotes,
    projectionNodes: projection.nodes,
    groups: projection.groups,
    positions,
    frame,
    screenshots,
    hoverPaths: hoverNeighborhood(projection.nodes, projection.groups),
    primaryEdgeKeys: spanningEdges(projection.nodes, projection.groups),
    horizontal,
    plainTitles,
  };
}

function projectionElements(
  structure: ProjectedStructure,
  selectedScreenId: string | undefined,
  direction: MapDirection,
  diff: BuildDiff | undefined,
  focus: FocusStatus[],
  onSelectScreen: (id: string) => void,
  onHoverScreen: (id: string | undefined) => void,
): { nodes: CanvasGraphNode[]; edges: TransitionGraphEdge[] } {
  const nodes: CanvasGraphNode[] = structure.projectionNodes.map((projectionNode) => {
    const point = structure.positions.get(projectionNode.id) ?? { x: 0, y: 0 };
    const size = nodeDimensions(structure.frame);
    const position = { x: point.x - size.width / 2, y: point.y - size.height / 2 };
    const screen = projectionNode.screen;
    const screenshot = structure.screenshots.get(screen.id);
    const highlighted = false;
    const status = diff?.screens.get(screen.id)?.status;
    const focusStatus = focusStatusOf(diff?.screens.get(screen.id));
    const muted = focus.length > 0 && !focus.some((state) => state === focusStatus);
    const projectionMotion: ProjectionMotionMetadata = {
      motionKey: `screen:${screen.id}`,
      role: "screen",
      representedScreenIds: [screen.id],
    };
    const className = muted ? "graph-node-muted" : "";
    const common = {
      id: screen.id,
      ...(className ? { className } : {}),
      // Route-backed selection must be part of the incoming node snapshot. CanvasStage also
      // synchronizes selection after navigation, but React Flow can initialize its internal
      // store after that effect on a cold deep link and clear an effect-only selection.
      selected: screen.id === selectedScreenId,
      position,
      sourcePosition: structure.horizontal ? Position.Right : Position.Bottom,
      targetPosition: structure.horizontal ? Position.Left : Position.Top,
      width: size.width,
      height: size.height,
    };
    return {
      ...common,
      type: "screen",
      data: {
        screen,
        ...(structure.plainTitles ? { plainTitle: true } : {}),
        ...(screenshot ? { screenshot: screenshot.url, ...(screenshot.size ? { screenshotSize: screenshot.size } : {}) } : {}),
        ...(!screenshot && structure.screenNotes.get(screen.id) ? { missingReason: structure.screenNotes.get(screen.id)! } : {}),
        highlighted,
        direction: structure.horizontal ? "LR" : "TB",
        frame: structure.frame,
        ...(status ? { diff: status } : {}),
        ...(diff?.screens.get(screen.id)?.accessibilityOnly ? { accessibilityOnly: true } : {}),
        projectionMotion,
        onSelect: onSelectScreen,
        onHover: onHoverScreen,
      },
    };
  });

  const edges: TransitionGraphEdge[] = structure.groups.map((group) => {
    const hierarchyEdge = structure.primaryEdgeKeys.has(group.key);
    const connected = group.from === selectedScreenId || group.to === selectedScreenId;
    const dimmed = false;
    const active = connected;
    const sourceOnly = group.transitionIds.length === 0 && Boolean(group.sourceEdges?.length);
    const previousSource = group.sourceRevision === "baseline";
    const removed = previousSource || (!group.synthetic && diff?.screens.get(group.to)?.status === "removed");
    const labels = [...new Set(
      group.labels.map(conciseActionLabel).filter((label): label is string => Boolean(label)),
    )];
    const label = labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0] ?? "";
    const tooltip = group.sourceEdges?.length ? `${previousSource ? "Previous source navigation" : sourceOnly ? "Source navigation" : "Observed transition with source navigation"}\n${
      group.sourceEdges.slice(0, 5).map(edge => `${edge.kind} · ${edge.sourceFile}`).join("\n")}${group.sourceEdges.length > 5 ? `\n+${group.sourceEdges.length - 5} source links` : ""}` : undefined;
    const primary = hierarchyEdge;
    const stroke = active
      ? "var(--accent)"
      : removed ? "var(--danger)" : primary ? "var(--graph-line)" : "var(--graph-line-soft)";
    return {
      id: edgeElementId(group.key),
      source: group.from,
      target: group.to,
      type: "transition",
      className: `${hierarchyEdge ? "graph-edge-primary" : "graph-edge-secondary"}${sourceOnly ? " graph-edge-source" : ""}${previousSource ? " graph-edge-source-baseline" : ""}${active ? " graph-edge-active" : ""}${dimmed ? " graph-edge-dimmed" : ""}`,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: active || hierarchyEdge ? 14 : 11,
        height: active || hierarchyEdge ? 14 : 11,
        color: stroke,
      },
      style: {
        stroke,
        strokeWidth: active ? 2.2 : hierarchyEdge ? 1.15 : 0.9,
        strokeDasharray: !hierarchyEdge && !active && !removed ? "4 7" : undefined,
      },
      data: { label, transitionCount: group.transitionIds.length, active, primary, dimmed, sourceOnly, previousSource, ...(tooltip ? { tooltip } : {}) },
      // React Flow renders a positive edge z-index above root nodes. Keep every connection in
      // the base edge layer so selected/highlighted paths still pass behind screen imagery.
      zIndex: 0,
    };
  });
  return { nodes, edges };
}

function sameCanvasNode(a: CanvasGraphNode, b: CanvasGraphNode) {
  if (
    a.type !== b.type
    || a.id !== b.id
    || a.className !== b.className
    || Boolean(a.selected) !== Boolean(b.selected)
  ) return false;
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
  if (a.type !== "screen" || b.type !== "screen") return false;
  return a.data.screen === b.data.screen
    && a.data.screenshot === b.data.screenshot
    && a.data.highlighted === b.data.highlighted
    && a.data.direction === b.data.direction
    && a.data.diff === b.data.diff
    && sameProjectionMotion(a.data.projectionMotion, b.data.projectionMotion)
    && a.data.onSelect === b.data.onSelect
    && a.data.onHover === b.data.onHover;
}

function sameProjectionMotion(left: ProjectionMotionMetadata, right: ProjectionMotionMetadata) {
  return left.motionKey === right.motionKey
    && left.role === right.role
    && left.representativeScreenId === right.representativeScreenId
    && left.representedScreenIds.length === right.representedScreenIds.length
    && left.representedScreenIds.every((screenId, index) => (
      screenId === right.representedScreenIds[index]
    ));
}

function sameTransitionEdge(a: TransitionGraphEdge, b: TransitionGraphEdge) {
  const aMarker = typeof a.markerEnd === "object" ? a.markerEnd : undefined;
  const bMarker = typeof b.markerEnd === "object" ? b.markerEnd : undefined;
  return a.id === b.id
    && a.source === b.source
    && a.target === b.target
    && a.className === b.className
    && a.zIndex === b.zIndex
    && aMarker?.width === bMarker?.width
    && aMarker?.height === bMarker?.height
    && aMarker?.color === bMarker?.color
    && a.style?.stroke === b.style?.stroke
    && a.style?.strokeWidth === b.style?.strokeWidth
    && a.style?.strokeDasharray === b.style?.strokeDasharray
    && a.data?.label === b.data?.label
    && a.data?.tooltip === b.data?.tooltip
    && a.data?.sourceOnly === b.data?.sourceOnly
    && a.data?.previousSource === b.data?.previousSource
    && a.data?.transitionCount === b.data?.transitionCount
    && a.data?.active === b.data?.active
    && a.data?.primary === b.data?.primary
    && a.data?.dimmed === b.data?.dimmed;
}

function reuseUnchangedElements(
  next: { nodes: CanvasGraphNode[]; edges: TransitionGraphEdge[] },
  previous: { nodes: CanvasGraphNode[]; edges: TransitionGraphEdge[] } | undefined,
) {
  if (!previous) return next;
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nodes = next.nodes.map((node) => {
    const old = previousNodes.get(node.id);
    return old && sameCanvasNode(old, node) ? old : node;
  });
  const edges = next.edges.map((edge) => {
    const old = previousEdges.get(edge.id);
    return old && sameTransitionEdge(old, edge) ? old : edge;
  });
  return {
    nodes: nodes.length === previous.nodes.length && nodes.every((node, index) => node === previous.nodes[index])
      ? previous.nodes
      : nodes,
    edges: edges.length === previous.edges.length && edges.every((edge, index) => edge === previous.edges[index])
      ? previous.edges
      : edges,
  };
}

type BaseCanvasProps = {
  map: ExploreMap;
  index: MapIndex;
  direction: MapDirection;
  diff?: BuildDiff;
  focus: FocusStatus[];
  selectedScreenId?: string;
  focusRequest?: FocusRequest;
  initialViewport?: CanvasViewport;
  viewportIdentity?: string | number;
  restoreViewportBehavior?: FocusBehavior;
  projectionFitKey?: number;
  onViewportChange?: (event: CanvasViewportChangeEvent) => void;
  onSelectScreen: (id: string, options?: { replace?: boolean }) => void;
  onClearSelection?: () => void;
};
export type MapViewProps = BaseCanvasProps & { projectionFitKey?: number };

function ConnectionCanvas(props: MapViewProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const structureRef = useRef<ProjectedStructure | undefined>(undefined);
  const hoverClearTimer = useRef<number | undefined>(undefined);
  const viewportChangeHandler = useRef(props.onViewportChange);
  viewportChangeHandler.current = props.onViewportChange;
  const hoverHighlight = useRef<{ screenId?: string; nodeIds: Set<string>; edgeIds: Set<string> }>({
    nodeIds: new Set(), edgeIds: new Set(),
  });
  const previousLayout = useRef<{ nodes: CanvasGraphNode[]; edges: TransitionGraphEdge[] } | undefined>(undefined);

  const observedGraph = useMemo(() => buildViewerGraph(props.map, props.index), [props.index, props.map]);
  const projection = useMemo(() => projectFullGraph(observedGraph), [observedGraph]);
  const structure = useMemo(
    () => projectedStructure(projection, props.index, isBlackBoxMap(props.map)),
    [projection, props.index, props.map],
  );
  structureRef.current = structure;

  const { onSelectScreen } = props;
  const applyHover = useCallback((screenId: string | undefined) => {
    const root = surfaceRef.current;
    const structure = structureRef.current;
    if (!root || !structure) return;
    const previous = hoverHighlight.current;
    const path = screenId ? structure.hoverPaths.get(screenId) : undefined;
    const next = {
      ...(screenId ? { screenId } : {}),
      nodeIds: path?.nodeIds ?? new Set<string>(),
      edgeIds: path?.edgeIds ?? new Set<string>(),
    };
    root.classList.toggle("canvas-hovering", Boolean(screenId));
    for (const nodeId of new Set([...previous.nodeIds, ...next.nodeIds])) {
      if (previous.nodeIds.has(nodeId) === next.nodeIds.has(nodeId)) continue;
      root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)
        ?.classList.toggle("graph-node-hover-related", next.nodeIds.has(nodeId));
    }
    for (const edgeId of new Set([...previous.edgeIds, ...next.edgeIds])) {
      if (previous.edgeIds.has(edgeId) === next.edgeIds.has(edgeId)) continue;
      root.querySelector<HTMLElement>(`.react-flow__edge[data-id="${CSS.escape(edgeId)}"]`)
        ?.classList.toggle("graph-edge-hover-related", next.edgeIds.has(edgeId));
    }
    if (previous.screenId !== screenId) {
      if (previous.screenId) {
        root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(previous.screenId)}"]`)
          ?.classList.remove("graph-node-hover-subject");
      }
      if (screenId) {
        root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(screenId)}"]`)
          ?.classList.add("graph-node-hover-subject");
      }
    }
    hoverHighlight.current = next;
  }, []);

  const hoverScreen = useCallback((screenId: string | undefined) => {
    if (hoverClearTimer.current !== undefined) {
      window.clearTimeout(hoverClearTimer.current);
      hoverClearTimer.current = undefined;
    }
    if (screenId) return applyHover(screenId);
    hoverClearTimer.current = window.setTimeout(() => {
      hoverClearTimer.current = undefined;
      applyHover(undefined);
    }, HOVER_CLEAR_DELAY);
  }, [applyHover]);
  const selectScreen = useCallback((screenId: string, options?: { replace?: boolean }) => {
    if (hoverClearTimer.current !== undefined) window.clearTimeout(hoverClearTimer.current);
    hoverClearTimer.current = undefined;
    applyHover(undefined);
    onSelectScreen(screenId, options);
  }, [applyHover, onSelectScreen]);
  useEffect(() => () => {
    if (hoverClearTimer.current !== undefined) window.clearTimeout(hoverClearTimer.current);
    applyHover(undefined);
  }, [applyHover]);
  // The arrow keys (or h j k l) walk the map from the selected screen: along an edge in the
  // layout's flow, across to the neighbour on the same rank otherwise. With nothing selected they
  // enter the map at its edge, as on the Screens page. A held key keeps walking.
  const { selectedScreenId } = props;
  const selectedRef = useRef(selectedScreenId);
  selectedRef.current = selectedScreenId;
  useEffect(() => {
    const hold = createKeyHold();
    const move = (direction: MapKeyDirection, from: string | undefined): string | undefined => {
      const structure = structureRef.current;
      if (!structure) return undefined;
      return from ? mapKeyTarget(structure, from, direction) : mapKeyEntry(structure, direction);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      hold.interrupt(event);
      if (event.repeat && hold.holding(event.code)) { event.preventDefault(); return; }
      if (event.defaultPrevented || !shortcutsLive(event) || arrowsOwnedBy(event.target)) return;
      const direction = mapKeyDirection(event);
      if (!direction) return;
      if (!structureRef.current) return;
      event.preventDefault();
      let at = move(direction, selectedRef.current);
      if (!at) return;
      selectScreen(at);
      hold.begin(event.code, () => {
        const target = move(direction, at);
        if (!target) return false;
        at = target;
        selectScreen(target);
        return true;
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (hold.holding(event.code)) hold.end();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hold.end);
    return () => {
      hold.end();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hold.end);
    };
  }, [selectScreen]);

  const onViewportChange = useCallback((event: CanvasViewportChangeEvent) => {
    viewportChangeHandler.current?.(event);
  }, []);

  const layout = useMemo(() => {
    const next = reuseUnchangedElements(projectionElements(
      structure,
      props.selectedScreenId,
      props.direction,
      props.diff,
      props.focus,
      selectScreen,
      hoverScreen,
    ), previousLayout.current);
    previousLayout.current = next;
    return next;
  }, [hoverScreen, props.diff, props.direction, props.focus, props.selectedScreenId, selectScreen, structure]);

  const focusTarget = useMemo(() => screenFocus(props.focusRequest), [props.focusRequest]);
  // The card size places the cards too: a hosted preview's other target, with the same screens in another shape, is a new
  // layout, not the old positions under bigger cards.
  const layoutIdentity = useMemo(() => [
    MAP_LAYOUT_REVISION,
    props.map.run.id,
    props.direction,
    `${structure.frame.width}x${structure.frame.height}`,
    projection.nodes.map((node) => node.id).join(","),
    projection.groups.map((group) => `${group.from}>${group.to}`).join(","),
  ].join(":"), [projection.groups, projection.nodes, props.direction, props.map.run.id, structure.frame]);
  // Screens closest to the start load first; within a layer, in reading order.
  const priorityNodeIds = useMemo(() => layout.nodes
    .map((node, index) => ({ id: node.id, depth: node.data.screen.depth, y: node.position.y, x: node.position.x, index }))
    .sort((left, right) => left.depth - right.depth || left.y - right.y || left.x - right.x || left.index - right.index)
    .map(({ id }) => id), [layout.nodes]);
  const phone = usePhoneLayout();
  const selectedScreenVisible = Boolean(
    props.selectedScreenId && layout.nodes.some((node) => node.id === props.selectedScreenId),
  );
  if (props.map.screens.length === 0) {
    const blockers = props.map.gaps.filter((gap) => gap.status === "open" && !gap.screenId).map((gap) => gap.message);
    return (
      <div className="graph-canvas canvas-empty">
        <div className="page-empty compact-empty map-empty">
          <h2>No screens were recorded</h2>
          {blockers.length > 0
            ? blockers.map((message) => <p key={message}>{message}</p>)
            : <p>The run ended before any screen of the app was observed.</p>}
        </div>
      </div>
    );
  }
  return (
    <div ref={surfaceRef} className="connection-canvas-surface map-surface">
      <CanvasStage
        ariaLabel="Screen map"
        className={[
          "map-canvas",
          selectedScreenVisible ? "screen-selection-active" : "",
        ].filter(Boolean).join(" ")}
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        layoutIdentity={layoutIdentity}
        historyIdentity={`${props.map.run.id}:map:${props.direction}`}
        preserveViewportOnLayoutChange
        preserveNodePositionsOnLayoutChange={false}
        animateProjectionChanges
        projectionSemanticLevel="overview"
        {...(props.selectedScreenId ? { projectionAnchorScreenId: props.selectedScreenId } : {})}
        {...(props.projectionFitKey !== undefined ? { projectionFitKey: props.projectionFitKey } : {})}
        {...(props.initialViewport ? { initialViewport: props.initialViewport } : {})}
        {...(props.viewportIdentity !== undefined ? { viewportIdentity: props.viewportIdentity } : {})}
        {...(props.restoreViewportBehavior ? { restoreViewportBehavior: props.restoreViewportBehavior } : {})}
        onViewportChange={onViewportChange}
        {...(focusTarget ? { focus: focusTarget } : {})}
        selectedNodeId={props.selectedScreenId ?? null}
        {...(props.onClearSelection ? { onClearSelection: props.onClearSelection } : {})}
        fit="bounds"
        fitViewOptions={MAP_FIT_VIEW_OPTIONS}
        priorityNodeIds={priorityNodeIds}
        readableZoomFloor={phone ? MAP_PHONE_READABLE_ZOOM_FLOOR : MAP_READABLE_ZOOM_FLOOR}
        {...(phone ? { fitTopInset: MAP_PHONE_FIT_TOP_INSET } : {})}
        minZoom={0.02}
        maxZoom={CANVAS_MAX_ZOOM}
      />
    </div>
  );
}

export function MapView(props: MapViewProps) {
  return <ConnectionCanvas {...props} />;
}
