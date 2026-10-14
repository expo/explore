import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  Background,
  BackgroundVariant,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  useStore,
  useStoreApi,
  type Edge,
  type EdgeTypes,
  type FitViewOptions,
  type Node,
  type NodeTypes,
  type OnMove,
  type Viewport,
  type XYPosition,
} from "@xyflow/react";
import { ZoomBridge } from "./zoom-bridge";
import {
  isTouchPanEvent,
  panGlideDuration,
  panGlideOffset,
  panReleaseVelocity,
  recordPanSample,
  type PanInertiaSample,
} from "./pan-inertia";
import { CanvasMiniMap } from "./mini-map";
import { useCanvasVisibleFrame } from "./visible-frame-provider";
import { canvasVisibleFrameContracts } from "./visible-frame";
import type { FocusBehavior, FocusRequest } from "../../utils/navigation";
import { matchesShortcut, SHORTCUTS, shortcutsLive } from "../../utils/shortcuts";
import { CANVAS_MAX_ZOOM } from "../../utils/canvas-zoom";
import {
  isAdjacentSemanticTransition,
  projectionAnchorActor,
  projectionCameraPlan,
  projectionContentBox,
  projectionEasing,
  projectionNodeDelay,
  projectionNodeMotions,
  projectionScreenSpaceFrames,
  selectProjectionMotionAnchor,
  projectionTransitionFrames,
  selectProjectionAnchor,
  withProjectionMotions,
  type ProjectionSemanticLevel,
} from "./projection-motion";
import {
  canvasBoundsViewport,
  canvasFocusViewport,
  canvasNodeVisible,
  canvasPriorityProjectionBounds,
  canvasSelectionNodeIds,
  canvasSelectionViewport,
  canvasWidthViewport,
  canvasViewportChangeEvent,
  canvasViewportRestoreToken,
  normalizeCanvasVisibleFrame,
  normalizeCanvasViewport,
  type CanvasPriorityFitReference,
  type CanvasVisibleFrame,
  type CanvasViewport,
  type CanvasViewportChangeEvent,
  type CanvasViewportPhase,
  type CanvasViewportSource,
} from "./camera";
import { followSelection } from "../../utils/follow-selection";

export type {
  CanvasViewport,
  CanvasViewportChangeEvent,
  CanvasViewportPhase,
  CanvasViewportSource,
} from "./camera";

/** Camera navigation runs 50% faster than the previous 420ms flight. */
const FOCUS_DURATION = 280;
const FOCUS_PADDING = 0.05;
const FOCUS_MAX_ZOOM = 0.9;
/** Small and medium canvases move more smoothly as one stable layer than as virtualized nodes. */
const VIRTUALIZATION_THRESHOLD = 100;
/** Semantic hierarchy changes use one shared timeline for node morphs and the anchored camera. */
/** Semantic layout navigation runs 50% faster than the previous 300ms transition. */
const PROJECTION_MOVE_DURATION = 200;
/** One paint of slack keeps cleanup from removing transition classes before the browser settles. */
const PROJECTION_SETTLE_SLACK = 32;

/** Connections stay in the base edge layer in every canvas projection. */
const CANVAS_EDGE_OPTIONS = { zIndex: 0 } as const;

/**
 * A re-layout is a cut, not a move: the canvas blinks out, the graph changes shape and the
 * camera refits while nothing is on screen, and the new arrangement comes straight back. Short
 * enough to read as a transition rather than a wait, and nothing travels for the eye to chase.
 */
const RELAYOUT_FADE_OUT = 80;
/** One beat in the dark, long enough for the new frame to paint before it is faded back in. */
const RELAYOUT_HOLD = 20;
const RELAYOUT_FADE_IN = 120;
/**
 * A re-layout never zooms closer than this. The anchor box is barely wider than one screen, so
 * fitting it literally would fill the canvas with a single thumbnail.
 */
const ANCHOR_MAX_ZOOM = 0.75;

/** Symmetric ease-in-out: accelerate into the flight and settle gently at the target. */
const easeInOutSine = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;

export type CanvasProjectionMotion = {
  active: boolean;
  /** Final projection zoom, so newly mounted nodes use their destination information density. */
  targetZoom?: number;
};

/** Lets node renderers keep zoom-dependent paint stable during a projection flight. */
export const CanvasProjectionMotionContext = createContext<CanvasProjectionMotion>({
  active: false,
});

export type CanvasFit = "bounds" | "width";
export type CanvasBox = { minX: number; minY: number; width: number; height: number };
/**
 * A box to frame, plus where it sits once framed. A top-down map hangs its entrance under the
 * canvas top and reads downwards; a left-right one runs off both edges, so its entrance belongs
 * on the middle line instead.
 */
export type CanvasAnchor = CanvasBox & { align: "top" | "center" };
/** A node to bring into view, once. A new key repeats it for the same node. */
export type CanvasFocus = { nodeId: string; key: number; behavior: FocusBehavior };

/** The focus for a canvas whose screen nodes carry the screen id; flows are not drawn on it. */
export function screenFocus(request: FocusRequest | undefined): CanvasFocus | undefined {
  if (!request || request.target !== "screen") return undefined;
  return { nodeId: request.id, key: request.key, behavior: request.behavior };
}

export type CanvasStageProps = {
  nodes: Node[];
  edges: Edge[];
  nodeTypes: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Changing this refits the view and drops any positions the user dragged. */
  layoutIdentity: string;
  /**
   * A broader document identity for drag history. Progressive Map expansion changes layout but
   * remains the same editable document, so its positions and Undo/Redo stack survive.
   */
  historyIdentity?: string;
  ariaLabel: string;
  className?: string;
  fit?: CanvasFit;
  /** Start-align inside a left-inset visible frame; full-width and selection fits stay centred. */
  fitLeftInset?: number;
  /** Exact visible-frame top inset for an inventory-style fit. */
  fitTopInset?: number;
  fitViewOptions?: FitViewOptions;
  minZoom?: number;
  maxZoom?: number;
  /**
   * Pans and zooms to a single node — a deep link, a history step or a side-panel row landing
   * on a screen. Waits for any pending fit or re-layout.
   */
  focus?: CanvasFocus;
  /** Optional route-backed selection, synchronized without rebuilding the graph layout. */
  selectedNodeId?: string | null;
  /** Clears the route-backed screen selection when the reader clicks empty canvas. */
  onClearSelection?: () => void;
  /**
   * A serializable camera restored before the first fit, or when `viewportIdentity` changes.
   * A valid restore owns that camera generation: pending fit and focus requests cannot move it
   * again. Inline objects are safe because values, not object identity, are compared.
   */
  initialViewport?: CanvasViewport;
  /**
   * Restore generation supplied by App/history. Change it to reapply even identical coordinates.
   * When omitted, a change to x/y/zoom itself starts the next generation.
   */
  viewportIdentity?: string | number;
  /** In-place restores may fly; first mount and reduced-motion restores always cut. */
  restoreViewportBehavior?: FocusBehavior;
  /**
   * Observes camera movement without making CanvasStage subscribe React state to the transform.
   * Consumers should avoid setting continuously changing React state because gesture snapshots
   * can arrive once per animation frame.
   */
  onViewportChange?: (event: CanvasViewportChangeEvent) => void;
  /**
   * Treat a layout identity change as another projection of the same world: keep the camera and
   * swap the node set without the normal fade/refit choreography.
   */
  preserveViewportOnLayoutChange?: boolean;
  /** Keep the current transform when floating chrome changes the unobscured canvas frame. */
  preserveViewportOnVisibleFrameChange?: boolean;
  /**
   * Also retain matching node positions across those projections. This is useful for progressive
   * expansion in one coordinate system, but must be false when each semantic level owns a
   * collision-free layout of its own.
   */
  preserveNodePositionsOnLayoutChange?: boolean;
  /** Animate matching/entering/leaving nodes when one semantic projection replaces another. */
  animateProjectionChanges?: boolean;
  /** Semantic hierarchy level used to choose a general shared-object policy for this transition. */
  projectionSemanticLevel?: ProjectionSemanticLevel;
  /** A changing value asks the latest explicitly selected projection to fit. */
  projectionFitKey?: number;
  /**
   * Nodes ordered from the most important projection landmark to the least important. When the
   * whole projection would fall below `readableZoomFloor`, Fit frames the largest leading run
   * that remains readable. All remaining nodes stay mounted and reachable by pan/minimap.
   */
  priorityNodeIds?: readonly string[];
  readableZoomFloor?: number;
  /** Canonical screen whose card/summary should remain the reader's visual anchor. */
  projectionAnchorScreenId?: string;
  /**
   * The region a re-layout refits around, in flow coordinates — the map passes the start
   * screen and the rank it opens onto. Opening the canvas still frames everything; only the
   * re-layout camera uses this, so it lands somewhere a reader recognises.
   */
  anchorBox?: CanvasAnchor;
};

type PositionSnapshot = Record<string, XYPosition>;
type PositionHistoryEntry = { before: PositionSnapshot; after: PositionSnapshot };

function canvasContainsVisibleFrame(
  visibleFrame: CanvasPriorityFitReference["visibleFrame"] | undefined,
  canvasWidth: number,
  canvasHeight: number,
) {
  if (!visibleFrame || canvasWidth <= 0 || canvasHeight <= 0) return false;
  const tolerance = 0.5;
  return visibleFrame.x >= -tolerance
    && visibleFrame.y >= -tolerance
    && visibleFrame.x + visibleFrame.width <= canvasWidth + tolerance
    && visibleFrame.y + visibleFrame.height <= canvasHeight + tolerance;
}

function positionSnapshot(nodes: Node[]): PositionSnapshot {
  return Object.fromEntries(nodes.map((node) => [node.id, { ...node.position }]));
}

/**
 * React Flow state stores the destination transform while CSS is still painting an interpolated
 * one. Retargeting from the state value would skip the rest of the visible path. Read all mounted
 * transforms in one phase and use that painted geometry as the next generation's source frame.
 */
function nodesAtPaintedPositions(nodes: Node[], root: HTMLElement | null): Node[] {
  if (!root) return nodes;
  const positions = new Map<string, XYPosition>();
  const knownIds = new Set(nodes.map((node) => node.id));
  for (const element of root.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")) {
    const id = element.dataset.id;
    if (!id || !knownIds.has(id)) continue;
    const transform = getComputedStyle(element).transform;
    if (!transform || transform === "none") continue;
    const matrix = new DOMMatrixReadOnly(transform);
    if (!Number.isFinite(matrix.m41) || !Number.isFinite(matrix.m42)) continue;
    positions.set(id, { x: matrix.m41, y: matrix.m42 });
  }
  if (positions.size === 0) return nodes;
  return nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, position } : node;
  });
}

function positionsChanged(before: PositionSnapshot, after: PositionSnapshot): boolean {
  const ids = Object.keys(before);
  return ids.length !== Object.keys(after).length || ids.some((id) => (
    before[id]?.x !== after[id]?.x || before[id]?.y !== after[id]?.y
  ));
}

function retainNodePositions(next: Node[], current: Node[]): Node[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return next.map((node) => {
    const existing = currentById.get(node.id);
    return existing ? { ...node, position: { ...existing.position } } : node;
  });
}

function retainProjectionPositions(
  next: Node[],
  current: Node[],
  remembered: ReadonlyMap<string, XYPosition>,
): Node[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return next.map((node) => {
    const position = currentById.get(node.id)?.position ?? remembered.get(node.id);
    return position ? { ...node, position: { ...position } } : node;
  });
}

function Stage(props: CanvasStageProps) {
  const { visibleFrame } = useCanvasVisibleFrame();
  const { getInternalNode, getNodes, getViewport, setViewport } = useReactFlow();
  /** True once any fit, flight, cut or gesture has moved this canvas' camera. */
  const cameraPlaced = useRef(false);
  /**
   * What last placed the camera on its own, when nothing has moved it since: a fit of the content,
   * or a flight to a requested focus (a flow, a screen). A panel that opens or closes then aims
   * at the same thing again in the new frame, so content placed just before the Inspector opened
   * never ends up under the panel. A gesture, or a selection made after the placement, clears it.
   */
  const autoCamera = useRef<{ kind: "fit" } | { kind: "focus"; nodeId: string } | undefined>(undefined);
  // A reader's click on a visible screen comes after the placement: that selection then owns the
  // camera, and opening the Inspector leaves it where it is. A group the reader opens selects its
  // entry screen first and is framed afterwards, so that framing still holds.
  // A layout effect, declared before the camera's own: it runs before any flight this same
  // update starts, so the flight it clears is never the one just requested.
  useLayoutEffect(() => {
    autoCamera.current = undefined;
  }, [props.selectedNodeId]);
  /**
   * When a panel opens or closes, the camera re-frames the selection only if the reader asked it
   * to follow the selection, or if no part of the selection is left in the visible frame.
   */
  const selectionStaysInView = (
    nodes: Node[],
    selectedNodeIds: readonly string[],
    frame: CanvasVisibleFrame,
  ) => !followSelection()
    // A camera that has not moved yet (a fresh mount) has nothing to keep.
    && cameraPlaced.current
    && selectedNodeIds.length > 0
    && selectedNodeIds.every((id) => canvasNodeVisible(nodes, id, getViewport(), frame));
  const storeApi = useStoreApi();
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodesInitialized = useNodesInitialized();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const minZoom = props.minZoom ?? 0.08;
  const maxZoom = props.maxZoom ?? CANVAS_MAX_ZOOM;
  const fit = props.fit ?? "bounds";
  // Keep the normalized command referentially stable. `initialViewport` may be presented as a
  // fresh inline object, while the layout effect also updates React Flow's controlled nodes; an
  // object-valued dependency here would therefore retrigger that effect after every node-store
  // sync even though the camera generation itself had already been consumed.
  const normalizedRestoredViewport = useMemo(
    () => normalizeCanvasViewport(props.initialViewport, minZoom, maxZoom),
    [
      maxZoom,
      minZoom,
      props.initialViewport?.x,
      props.initialViewport?.y,
      props.initialViewport?.zoom,
      props.initialViewport?.center?.x,
      props.initialViewport?.center?.y,
    ],
  );
  const restoredFrame = useMemo(
    () => normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight),
    [canvasHeight, canvasWidth, visibleFrame],
  );
  const [priorityFitReferenceState, setPriorityFitReferenceState] = useState<{
    layoutIdentity: string;
    outerViewportWidth: number;
    reference: CanvasPriorityFitReference;
  }>();
  const outerViewportWidth = canvasRef.current?.ownerDocument.defaultView?.innerWidth;
  const priorityFitReference = priorityFitReferenceState?.layoutIdentity === props.layoutIdentity
    && outerViewportWidth !== undefined
    && Math.abs(priorityFitReferenceState.outerViewportWidth - outerViewportWidth) <= 0.5
    ? priorityFitReferenceState.reference
    : undefined;
  useLayoutEffect(() => {
    if (
      !visibleFrame
      || !props.priorityNodeIds?.length
      || !props.readableZoomFloor
      || !canvasContainsVisibleFrame(visibleFrame, canvasWidth, canvasHeight)
    ) return;
    const frame = normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight);
    if (!frame) return;
    const nextOuterViewportWidth = canvasRef.current?.ownerDocument.defaultView?.innerWidth;
    if (!nextOuterViewportWidth) return;
    setPriorityFitReferenceState((current) => {
      const previous = current?.layoutIdentity === props.layoutIdentity
        && Math.abs(current.outerViewportWidth - nextOuterViewportWidth) <= 0.5
        ? current.reference
        : undefined;
      const wider = !previous
        || frame.width > previous.visibleFrame.width + 0.5
        || (
          Math.abs(frame.width - previous.visibleFrame.width) <= 0.5
          && frame.height > previous.visibleFrame.height + 0.5
        );
      if (!wider) return current;
      return {
        layoutIdentity: props.layoutIdentity,
        outerViewportWidth: nextOuterViewportWidth,
        reference: { canvasWidth, canvasHeight, visibleFrame: frame },
      };
    });
  }, [
    canvasHeight,
    canvasWidth,
    props.layoutIdentity,
    props.priorityNodeIds,
    props.readableZoomFloor,
    visibleFrame,
  ]);
  const restoredViewport = useMemo<CanvasViewport | undefined>(() => {
    if (!normalizedRestoredViewport) return undefined;
    const { x, y, zoom, center } = normalizedRestoredViewport;
    if (!center) return { x, y, zoom };
    // React Flow's dimensions are still zero on a newly mounted canvas. Use the serialized
    // transform for its first paint, then realign the saved world centre exactly once when the
    // measured visible frame arrives.
    if (!restoredFrame) return { x, y, zoom };
    return {
      zoom,
      x: restoredFrame.x + restoredFrame.width / 2 - center.x * zoom,
      y: restoredFrame.y + restoredFrame.height / 2 - center.y * zoom,
    };
  }, [normalizedRestoredViewport, restoredFrame]);
  // The restore generation belongs to the history entry, not to responsive frame geometry.
  // Recomputing x/y from the same saved world center must not replay a consumed restore later.
  const restoreToken = canvasViewportRestoreToken(
    normalizedRestoredViewport,
    props.viewportIdentity,
  );
  const appliedRestoreToken = useRef<string | undefined>(
    normalizedRestoredViewport?.center && !restoredFrame ? undefined : restoreToken,
  );
  const restoreRequested = restoredViewport !== undefined
    && appliedRestoreToken.current !== restoreToken
    && (!normalizedRestoredViewport?.center || restoredFrame !== undefined);
  const initialFocusOwnsCamera = props.focus !== undefined
    && props.nodes.some((node) => node.id === props.focus?.nodeId);
  const [nodes, setNodes, onNodesChange] = useNodesState(props.nodes);
  const [initialCameraReady, setInitialCameraReady] = useState(
    restoredViewport !== undefined || initialFocusOwnsCamera,
  );
  // Nodes and edges are one projection snapshot. Keeping edges local prevents the render between
  // a prop change and this stage's layout effect from pairing old nodes with new edge endpoints.
  const [edges, setEdges] = useState(props.edges);
  const [fitRequest, setFitRequest] = useState<string | undefined>(() => (
    restoredViewport || initialFocusOwnsCamera ? undefined : props.layoutIdentity
  ));
  const previousLayoutIdentity = useRef(props.layoutIdentity);
  const previousHistoryIdentity = useRef(props.historyIdentity ?? props.layoutIdentity);
  const alignedLayout = useRef<string | undefined>(
    restoredViewport || initialFocusOwnsCamera ? props.layoutIdentity : undefined,
  );
  const timers = useRef<number[]>([]);
  /** The layout waiting behind the fade-out, kept fresh in case props move again mid-dip. */
  const incoming = useRef(props.nodes);
  const incomingEdges = useRef(props.edges);
  const [relayout, setRelayout] = useState<"idle" | "out" | "in">("idle");
  const [projectionAnimating, setProjectionAnimating] = useState(false);
  const [projectionTargetZoom, setProjectionTargetZoom] = useState<number | undefined>(undefined);
  /**
   * Synchronous companion to projectionAnimating. Effects from one commit all observe the
   * previous React state, so a focus request needs this ref to see a projection that the layout
   * effect has just started and wait for its final node geometry.
   */
  const projectionActive = useRef(false);
  const projectionSequence = useRef(0);
  const projectionPrepareFrame = useRef<number | undefined>(undefined);
  const projectionFlight = useRef<number | undefined>(undefined);
  /** A direct pan/zoom wins over a projection fit, including one waiting in the double RAF. */
  const projectionCameraGesture = useRef(0);
  const previousProjectionFitKey = useRef(props.projectionFitKey);
  const previousProjectionSemanticLevel = useRef(props.projectionSemanticLevel);
  const [focusAnimating, setFocusAnimating] = useState(false);
  /** Any animated camera flight. Styles freeze small text rasters for its duration only. */
  const [cameraFlying, setCameraFlying] = useState(false);
  /** The focus request already acted on, so a re-render never replays a flight. */
  const consumedFocus = useRef<number | undefined>(
    restoredViewport && props.focus ? props.focus.key : undefined,
  );
  /** A restore also wins a focus that App schedules in its first post-mount effect. */
  const restoreFocusGuard = useRef(restoredViewport !== undefined);
  const restoreFocusGuardFrame = useRef<number | undefined>(undefined);
  /** The opening fit waits one paint so a route-backed focus can claim the first camera command. */
  const initialFitFrame = useRef<number | undefined>(undefined);
  /** Reveals opening nodes one paint after their final viewport has been committed. */
  const initialRevealFrame = useRef<number | undefined>(undefined);
  /** A stable visible-frame generation is consumed by exactly one automatic camera command. */
  const appliedVisibleFrameRevision = useRef(visibleFrame?.revision ?? 0);
  const visibleFrameRefitFrame = useRef<number | undefined>(undefined);
  /** Last screen-space frame whose inward edges were resolved before paint. */
  const previousVisibleFrameBounds = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | undefined>(undefined);
  /**
   * Last screen-space origin paired with a published frame. The canvas' local transform does not
   * include a flex sibling moving its DOM root, so this lets a panel toggle preserve the pixels
   * already under the reader's eyes before the next Fit flight starts.
   */
  const visibleFrameCanvasOrigin = useRef<{ x: number; y: number } | undefined>(undefined);
  const firstCameraSettled = useRef(restoredViewport !== undefined);
  /** The single camera-frame loop currently moving toward a focused node. */
  const flight = useRef<number | undefined>(undefined);
  /**
   * Focus and route/projection restores share the same RAF implementation, but not the same
   * lifecycle. Removing a focus may cancel only a focus-owned flight; otherwise a projection
   * rerender with no focus would cancel an in-flight history restore before its first frame.
   */
  const flightOwner = useRef<"focus" | "selection" | "camera" | "glide" | undefined>(undefined);
  /** The last stretch of a touch pan, so a lifted finger can hand its velocity to a glide. */
  const panSamples = useRef<PanInertiaSample[]>([]);
  const overlayRestore = useRef<number | undefined>(undefined);
  /** Drag history is local to this canvas document, not to a temporary expanded projection. */
  const undoStack = useRef<PositionHistoryEntry[]>([]);
  const redoStack = useRef<PositionHistoryEntry[]>([]);
  const dragOrigin = useRef<PositionSnapshot | undefined>(undefined);
  /** Positions survive while semantic projections temporarily omit their nodes. */
  const projectionPositions = useRef<Map<string, XYPosition>>(new Map());
  /** Manual RAF flights emit one explicit end; React Flow's per-frame synthetic ends are ignored. */
  const suppressProgrammaticEndUntil = useRef(0);
  /** D3 may omit sourceEvent on later frames of a user-initiated animated zoom. */
  const activeMoveSource = useRef<CanvasViewportSource | undefined>(undefined);
  const onViewportChange = useRef(props.onViewportChange);
  onViewportChange.current = props.onViewportChange;
  const latestFocus = useRef(props.focus);
  latestFocus.current = props.focus;

  const emitViewportChange = useCallback((
    viewport: Viewport,
    source: CanvasViewportSource,
    phase: CanvasViewportPhase,
  ) => {
    cameraPlaced.current = true;
    const handler = onViewportChange.current;
    if (!handler) return;
    const { width, height } = storeApi.getState();
    const event = canvasViewportChangeEvent(viewport, width, height, source, phase, visibleFrame);
    if (event) handler(event);
  }, [storeApi, visibleFrame]);

  const handleMove = useCallback<OnMove>((event, viewport) => {
    const source = event ? "gesture" : activeMoveSource.current ?? "programmatic";
    if (isTouchPanEvent(event)) {
      panSamples.current = recordPanSample(panSamples.current, { at: performance.now(), ...viewport });
    } else if (event) {
      panSamples.current = [];
    }
    emitViewportChange(viewport, source, "continuous");
  }, [emitViewportChange]);

  const stopSequence = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    if (projectionPrepareFrame.current !== undefined) {
      cancelAnimationFrame(projectionPrepareFrame.current);
      projectionPrepareFrame.current = undefined;
    }
    projectionActive.current = false;
  };

  const stopFlight = useCallback((updateState = true) => {
    if (flight.current !== undefined) cancelAnimationFrame(flight.current);
    if (overlayRestore.current !== undefined) cancelAnimationFrame(overlayRestore.current);
    flight.current = undefined;
    flightOwner.current = undefined;
    overlayRestore.current = undefined;
    if (updateState) { setFocusAnimating(false); setCameraFlying(false); }
  }, []);

  /**
   * A finger lifted mid-flick keeps the map moving on the phone: the release velocity decays
   * exponentially, like a native scroll surface, and the gesture's end is reported once the map
   * has settled. Returns false when the release should stop dead (slow release, pinch).
   */
  const startPanGlide = useCallback((released: Viewport) => {
    const releasedAt = performance.now();
    const velocity = panReleaseVelocity(panSamples.current, releasedAt);
    panSamples.current = [];
    if (!velocity) return false;
    stopFlight(false);
    flightOwner.current = "glide";
    activeMoveSource.current = "gesture";
    const duration = panGlideDuration(velocity);
    flight.current = requestAnimationFrame(function step(now) {
      const elapsed = Math.min(duration, Math.max(0, now - releasedAt));
      const offset = panGlideOffset(velocity, elapsed);
      const viewport = { x: released.x + offset.x, y: released.y + offset.y, zoom: released.zoom };
      suppressProgrammaticEndUntil.current = performance.now() + 80;
      void setViewport(viewport);
      if (elapsed < duration) {
        flight.current = requestAnimationFrame(step);
        return;
      }
      flight.current = undefined;
      flightOwner.current = undefined;
      activeMoveSource.current = undefined;
      // React Flow reports this last setViewport as its own end 150ms later; the glide's end is this one.
      suppressProgrammaticEndUntil.current = performance.now() + 200;
      emitViewportChange(viewport, "gesture", "end");
    });
    return true;
  }, [emitViewportChange, setViewport, stopFlight]);

  // React Flow reports a pan's end on a 150ms timer (it coalesces wheel-scroll ends), far too late
  // for a glide to pick up where the finger left off. The lift is taken from the touch event
  // itself; the delayed end is then ignored. d3 stops touch events from propagating, so the
  // listener captures: the last touchmove has already committed the gesture's final transform.
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length > 0 || panSamples.current.length === 0) return;
      startPanGlide(getViewport());
    };
    const options = { capture: true, passive: true };
    element.addEventListener("touchend", onTouchEnd, options);
    element.addEventListener("touchcancel", onTouchEnd, options);
    return () => {
      element.removeEventListener("touchend", onTouchEnd, options);
      element.removeEventListener("touchcancel", onTouchEnd, options);
    };
  }, [getViewport, startPanGlide]);

  const stopProjectionFlight = useCallback(() => {
    if (projectionFlight.current !== undefined) cancelAnimationFrame(projectionFlight.current);
    projectionFlight.current = undefined;
  }, []);

  const cancelVisibleFrameRefit = useCallback(() => {
    if (visibleFrameRefitFrame.current === undefined) return;
    cancelAnimationFrame(visibleFrameRefitFrame.current);
    visibleFrameRefitFrame.current = undefined;
  }, []);

  const startViewportFlight = useCallback((
    target: CanvasViewport,
    behavior: FocusBehavior,
    options: {
      duration?: number;
      hideOverlays?: boolean;
      owner?: "focus" | "selection" | "camera";
    } = {},
  ) => {
    stopFlight();
    flightOwner.current = options.owner ?? (options.hideOverlays ? "focus" : "camera");
    // A flight to the requested focus records it, so a later panel change can aim at it again.
    const focusNodeId = flightOwner.current === "focus" ? latestFocus.current?.nodeId : undefined;
    autoCamera.current = focusNodeId ? { kind: "focus", nodeId: focusNodeId } : undefined;
    appliedVisibleFrameRevision.current = visibleFrame?.revision ?? 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = behavior === "fly" && !reducedMotion;
    firstCameraSettled.current = true;
    if (!animate) {
      suppressProgrammaticEndUntil.current = performance.now() + 80;
      void setViewport(target);
      flightOwner.current = undefined;
      // React Flow reports the synthetic move end on a zero-delay timer. Emit the lifecycle end
      // here so consumers see one committed restore/focus rather than that implementation detail.
      emitViewportChange(target, "programmatic", "end");
      return;
    }

    const duration = options.duration ?? FOCUS_DURATION;
    const start = getViewport();
    if (options.hideOverlays) setFocusAnimating(true);
    setCameraFlying(true);
    const startedAt = performance.now();
    flight.current = requestAnimationFrame(function step(now) {
      // Camera navigation is a wall-clock transition. Accumulating a capped amount per rendered
      // frame made the same 280ms command take 560ms at 30fps (and far longer after a busy frame),
      // which read as a randomly slow zoom. A delayed frame now catches up to the same deadline.
      const progress = Math.min(1, Math.max(0, now - startedAt) / duration);
      const eased = easeInOutSine(progress);
      const viewport = {
        zoom: start.zoom + (target.zoom - start.zoom) * eased,
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      };
      suppressProgrammaticEndUntil.current = performance.now() + 80;
      void setViewport(viewport);
      if (progress < 1) {
        flight.current = requestAnimationFrame(step);
        return;
      }
      flight.current = undefined;
      flightOwner.current = undefined;
      setCameraFlying(false);
      emitViewportChange(target, "programmatic", "end");
      if (!options.hideOverlays) return;
      // Restore overlays on the next paint, after the final camera transform is already visible.
      // Their geometry/content render must not share the landing frame.
      overlayRestore.current = requestAnimationFrame(() => {
        overlayRestore.current = undefined;
        setFocusAnimating(false);
      });
    });
  }, [emitViewportChange, getViewport, setViewport, stopFlight, visibleFrame?.revision]);

  const fitProjectionCamera = useCallback((
    currentNodes: Node[],
    nextNodes: Node[],
    animate: boolean,
    motion?: {
      nodes: Node[];
      camera: "semantic-anchor" | "direct-fit";
    },
  ): boolean => {
    if (!visibleFrame || canvasWidth <= 0 || canvasHeight <= 0) return false;
    // A frame wider than the measured canvas means React Flow has not resized to the newly
    // expanded layout yet. Fitting now would clamp to the stale size and consume the request,
    // so stay pending until the canvas dimensions catch up and this callback re-runs.
    if (!canvasContainsVisibleFrame(visibleFrame, canvasWidth, canvasHeight)) return false;
    const frame = normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight);
    if (!frame) return false;
    const box = projectionContentBox(nextNodes);
    if (!box || box.width <= 0 || box.height <= 0) return false;
    const padding = typeof props.fitViewOptions?.padding === "number" ? props.fitViewOptions.padding : 0.1;
    const fullBounds = { x: box.minX, y: box.minY, width: box.width, height: box.height };
    if (fit === "width") {
      const target = canvasWidthViewport(fullBounds, {
        canvasWidth,
        canvasHeight,
        minZoom: props.fitViewOptions?.minZoom ?? minZoom,
        maxZoom: Math.min(1, props.fitViewOptions?.maxZoom ?? maxZoom),
        padding,
        ...(props.fitTopInset !== undefined ? { topInset: props.fitTopInset } : {}),
        visibleFrame: frame,
      });
      if (!target) return false;
      startViewportFlight(target, animate ? "fly" : "cut", { owner: "camera" });
      autoCamera.current = { kind: "fit" };
      return true;
    }
    if (fit !== "bounds") return false;
    const bounds = canvasPriorityProjectionBounds(nextNodes, fullBounds, {
      canvasWidth,
      canvasHeight,
      padding,
      visibleFrame: frame,
      ...(props.priorityNodeIds ? { priorityNodeIds: props.priorityNodeIds } : {}),
      ...(props.readableZoomFloor !== undefined
        ? { readableZoomFloor: props.readableZoomFloor }
        : {}),
      ...(priorityFitReference ? { priorityFitReference } : {}),
    });
    const fittedTarget = canvasBoundsViewport(bounds, {
      canvasWidth,
      canvasHeight,
      minZoom: props.fitViewOptions?.minZoom ?? minZoom,
      maxZoom: props.fitViewOptions?.maxZoom ?? maxZoom,
      padding,
      ...(props.fitLeftInset !== undefined ? { leftInset: props.fitLeftInset } : {}),
      ...(props.fitTopInset !== undefined ? { topInset: props.fitTopInset } : {}),
      visibleFrame: frame,
    });
    if (!fittedTarget) return false;
    if (motion?.camera === "direct-fit") {
      startViewportFlight(fittedTarget, animate ? "fly" : "cut", { owner: "camera" });
      autoCamera.current = { kind: "fit" };
      return true;
    }
    stopFlight();
    stopProjectionFlight();
    const start = getViewport();
    const viewportCenter = {
      x: (frame.x + frame.width / 2 - start.x) / start.zoom,
      y: (frame.y + frame.height / 2 - start.y) / start.zoom,
    };
    const anchorPair = motion?.camera === "semantic-anchor"
      ? selectProjectionMotionAnchor(
          currentNodes,
          nextNodes,
          motion.nodes,
          props.projectionAnchorScreenId,
          viewportCenter,
        )
      : motion
        ? undefined
        : selectProjectionAnchor(
          currentNodes,
          nextNodes,
          props.projectionAnchorScreenId,
          viewportCenter,
        );
    const anchorActor = anchorPair
      ? projectionAnchorActor(anchorPair, currentNodes, nextNodes)
      : undefined;
    let fromAnchorScreen: XYPosition | undefined;
    const root = canvasRef.current;
    if (root && anchorActor) {
      // One read phase captures the actual in-flight position, so rapid retargets continue from
      // the frame currently under the pointer rather than an obsolete React state target.
      const rootRect = root.getBoundingClientRect();
      const anchorElement = root.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(anchorActor.id)}"]`,
      );
      const anchorRect = anchorElement?.getBoundingClientRect();
      if (anchorRect) {
        fromAnchorScreen = {
          x: anchorRect.left + anchorRect.width / 2 - rootRect.left,
          y: anchorRect.top + anchorRect.height / 2 - rootRect.top,
        };
      }
    }
    const frameStart = {
      ...start,
      x: start.x - frame.x,
      y: start.y - frame.y,
    };
    const rawPlan = projectionCameraPlan({
      current: currentNodes,
      next: nextNodes,
      startViewport: frameStart,
      canvasWidth: frame.width,
      canvasHeight: frame.height,
      padding,
      minZoom: props.fitViewOptions?.minZoom ?? minZoom,
      maxZoom: props.fitViewOptions?.maxZoom ?? maxZoom,
      ...(props.projectionAnchorScreenId
        ? { preferredScreenId: props.projectionAnchorScreenId }
        : {}),
      ...(fromAnchorScreen ? {
        fromAnchorScreen: {
          x: fromAnchorScreen.x - frame.x,
          y: fromAnchorScreen.y - frame.y,
        },
      } : {}),
      ...(motion ? { anchorPair: anchorPair ?? null } : {}),
    });
    if (!rawPlan) return false;
    // Semantic actors can retain their screen-space continuity during the transition, but every
    // projection ends at the same centred priority-aware bounds target as initial/manual Fit.
    // The old anchor planner's independent final translation could bypass both guarantees.
    const plan = {
      target: fittedTarget,
      ...(rawPlan.anchor ? {
        anchor: {
          ...rawPlan.anchor,
          fromScreen: {
            x: rawPlan.anchor.fromScreen.x + frame.x,
            y: rawPlan.anchor.fromScreen.y + frame.y,
          },
          toScreen: {
            x: rawPlan.anchor.toWorld.x * fittedTarget.zoom + fittedTarget.x,
            y: rawPlan.anchor.toWorld.y * fittedTarget.zoom + fittedTarget.y,
          },
        },
      } : {}),
    };
    appliedVisibleFrameRevision.current = frame.revision;
    const movingAnchorElement = root && anchorActor
      ? root.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(anchorActor.id)}"]`,
        )
      : undefined;
    const movingAnchorSize = anchorActor ? {
      width: anchorActor.width ?? anchorActor.measured?.width ?? 0,
      height: anchorActor.height ?? anchorActor.measured?.height ?? 0,
    } : undefined;
    const readMovingAnchorWorld = () => {
      if (!movingAnchorElement || !movingAnchorSize) return undefined;
      const transform = getComputedStyle(movingAnchorElement).transform;
      if (!transform || transform === "none") return undefined;
      const matrix = new DOMMatrixReadOnly(transform);
      return {
        x: matrix.m41 + movingAnchorSize.width / 2,
        y: matrix.m42 + movingAnchorSize.height / 2,
      };
    };
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      suppressProgrammaticEndUntil.current = performance.now() + 80;
      void setViewport(plan.target);
      firstCameraSettled.current = true;
      emitViewportChange(plan.target, "programmatic", "end");
      autoCamera.current = { kind: "fit" };
      return true;
    }
    // The rect read above forces the active CSS transition to start. Take the camera timestamp
    // afterwards so both 200ms timelines end on the same browser frame.
    const startedAt = performance.now();
    projectionFlight.current = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - startedAt) / PROJECTION_MOVE_DURATION);
      if (progress >= 1) {
        suppressProgrammaticEndUntil.current = performance.now() + 80;
        void setViewport(plan.target);
        projectionFlight.current = undefined;
        firstCameraSettled.current = true;
        emitViewportChange(plan.target, "programmatic", "end");
        return;
      }
      const eased = projectionEasing(progress);
      const zoom = start.zoom + (plan.target.zoom - start.zoom) * eased;
      if (plan.anchor) {
        // Read the one shared element before writing the viewport. This follows the browser's
        // actual CSS interpolation, including a rapid retarget caught between logical layouts.
        const world = readMovingAnchorWorld() ?? {
          x: plan.anchor.fromWorld.x
            + (plan.anchor.toWorld.x - plan.anchor.fromWorld.x) * eased,
          y: plan.anchor.fromWorld.y
            + (plan.anchor.toWorld.y - plan.anchor.fromWorld.y) * eased,
        };
        const screen = {
          x: plan.anchor.fromScreen.x
            + (plan.anchor.toScreen.x - plan.anchor.fromScreen.x) * eased,
          y: plan.anchor.fromScreen.y
            + (plan.anchor.toScreen.y - plan.anchor.fromScreen.y) * eased,
        };
        suppressProgrammaticEndUntil.current = performance.now() + 80;
        void setViewport({
          zoom,
          x: screen.x - world.x * zoom,
          y: screen.y - world.y * zoom,
        });
      } else {
        suppressProgrammaticEndUntil.current = performance.now() + 80;
        void setViewport({
          zoom,
          x: start.x + (plan.target.x - start.x) * eased,
          y: start.y + (plan.target.y - start.y) * eased,
        });
      }
      projectionFlight.current = requestAnimationFrame(step);
    });
    autoCamera.current = { kind: "fit" };
    return true;
  }, [
    canvasHeight,
    canvasWidth,
    emitViewportChange,
    fit,
    getViewport,
    maxZoom,
    minZoom,
    props.fitViewOptions,
    props.fitLeftInset,
    props.fitTopInset,
    props.priorityNodeIds,
    props.projectionAnchorScreenId,
    props.readableZoomFloor,
    priorityFitReference,
    setViewport,
    startViewportFlight,
    stopFlight,
    stopProjectionFlight,
    visibleFrame,
  ]);

  useEffect(() => {
    incoming.current = props.nodes;
    incomingEdges.current = props.edges;
    const structureChanged = previousLayoutIdentity.current !== props.layoutIdentity;
    previousLayoutIdentity.current = props.layoutIdentity;
    const previousSemanticLevel = previousProjectionSemanticLevel.current;
    previousProjectionSemanticLevel.current = props.projectionSemanticLevel;
    const historyIdentity = props.historyIdentity ?? props.layoutIdentity;
    const documentChanged = previousHistoryIdentity.current !== historyIdentity;
    previousHistoryIdentity.current = historyIdentity;
    if (documentChanged) {
      undoStack.current = [];
      redoStack.current = [];
      dragOrigin.current = undefined;
      projectionPositions.current.clear();
    }
    // A re-layout is choreographed, so the swap waits for the fade-out to finish; only the
    // very first fit, and the width-fit canvases, take the new nodes on the spot.
    const preserveProjection = !documentChanged
      && structureChanged
      && props.preserveViewportOnLayoutChange === true
      && alignedLayout.current !== undefined;
    const choreograph = structureChanged
      && fit === "bounds"
      && alignedLayout.current !== undefined
      && !preserveProjection;
    const projectionFitRequested = props.projectionFitKey !== undefined
      && previousProjectionFitKey.current !== props.projectionFitKey;
    const requestedFocus = props.focus && consumedFocus.current !== props.focus.key
      ? props.focus
      : undefined;
    // Unless the reader asked the camera to follow the selection, a focus on a node that is
    // already on screen, even in part, is done: the selection changes and the camera stays.
    // A node the reader clicked is always on screen.
    const focusInView = requestedFocus !== undefined
      && !followSelection()
      && !structureChanged
      // Only a camera that has been placed can leave a target where it is. A fresh mount (a
      // history step back to this canvas) still sits at its unplaced 0,0 camera.
      && cameraPlaced.current
      // While panels open or close the frame is briefly unknown; the canvas itself stands in.
      && canvasNodeVisible(props.nodes, requestedFocus.nodeId, getViewport(),
        visibleFrame ?? { x: 0, y: 0, width: canvasWidth, height: canvasHeight, revision: 0 });
    if (requestedFocus && focusInView) consumedFocus.current = requestedFocus.key;
    const pendingFocus = focusInView ? undefined : requestedFocus;
    const focusCameraTarget = pendingFocus && visibleFrame
      ? canvasFocusViewport(
          props.nodes,
          pendingFocus.nodeId,
          canvasWidth,
          canvasHeight,
          minZoom,
          FOCUS_MAX_ZOOM,
          FOCUS_PADDING,
          visibleFrame,
        )
      : undefined;
    // One generation has one camera owner. A history restore wins; otherwise a focus that becomes
    // visible as part of this projection replaces its fit instead of running after it.
    const cameraOverride = restoreRequested && restoredViewport
      ? {
          kind: "restore" as const,
          target: restoredViewport,
          behavior: props.restoreViewportBehavior ?? "cut",
        }
      : pendingFocus && focusCameraTarget
        ? {
            kind: "focus" as const,
            target: focusCameraTarget,
            behavior: pendingFocus.behavior,
          }
        : undefined;
    const claimCameraOverride = () => {
      if (!cameraOverride) return;
      if (cameraOverride.kind === "restore") {
        appliedRestoreToken.current = restoreToken;
        restoreFocusGuard.current = true;
      }
      if (props.focus) consumedFocus.current = props.focus.key;
      if (projectionFitRequested) previousProjectionFitKey.current = props.projectionFitKey;
      alignedLayout.current = props.layoutIdentity;
      setFitRequest(undefined);
    };
    if (!structureChanged) {
      if (cameraOverride?.kind === "restore") {
        stopSequence();
        stopFlight();
        stopProjectionFlight();
        projectionActive.current = false;
        setProjectionAnimating(false);
        setProjectionTargetZoom(undefined);
        claimCameraOverride();
        startViewportFlight(cameraOverride.target, cameraOverride.behavior, { owner: "camera" });
        setEdges(props.edges);
        setNodes((currentNodes) => retainNodePositions(props.nodes, currentNodes));
        setRelayout("idle");
        return;
      }
      // Mid-sequence the old frame stays put: props already hold the new layout, and letting
      // an unrelated re-render through would reveal it behind the fade.
      if (relayout === "out") return;
      setEdges(props.edges);
      if (projectionAnimating || projectionActive.current) {
        // Selection, focus and diff state can update without changing the topology. Refresh the
        // data carried by nodes already in the transition, but keep their motion class, position,
        // and leaving nodes until the projection generation settles. The fit request also remains
        // owned by that projection: replaying it here would start a camera flight against the old
        // world one frame before the prepared node layout commits.
        setNodes((currentNodes) => {
          const latestById = new Map(props.nodes.map((node) => [node.id, node]));
          return currentNodes.map((current) => {
            const latest = latestById.get(current.id);
            if (!latest) return current;
            const motions = projectionNodeMotions(current);
            const latestData = latest.data && typeof latest.data === "object"
              ? { ...(latest.data as Record<string, unknown>) }
              : {};
            const currentData = current.data && typeof current.data === "object"
              ? current.data as Record<string, unknown>
              : {};
            for (const key of [
              "projectionDelayMs",
              "projectionScreenScale",
              "projectionPendingExit",
            ] as const) {
              if (key in currentData) latestData[key] = currentData[key];
            }
            const latestClasses = (latest.className ?? "")
              .split(/\s+/)
              .filter((name) => name
                && !name.startsWith("canvas-node-")
                && name !== "projection-fade-only");
            const currentFadeOnly = (current.className ?? "")
              .split(/\s+/)
              .includes("projection-fade-only");
            const refreshed = {
              ...latest,
              position: current.position,
              data: latestData,
              className: [
                ...latestClasses,
                ...(currentFadeOnly ? ["projection-fade-only"] : []),
              ].join(" "),
            };
            return motions.length > 0
              ? withProjectionMotions(refreshed, motions)
              : refreshed;
          });
        });
        return;
      }
      // Clicking the already-selected content scope is an explicit "fit this projection" action.
      // It changes only the request key, so it must not be lost in the topology-stable path.
      if (
        projectionFitRequested
        && fitProjectionCamera(
          getNodes(),
          props.nodes,
          true,
          props.projectionSemanticLevel === "overview"
            ? { nodes: props.nodes, camera: "direct-fit" }
            : undefined,
        )
      ) {
        previousProjectionFitKey.current = props.projectionFitKey;
      }
      setNodes((currentNodes) => {
        const currentById = new Map(currentNodes.map((node) => [node.id, node]));
        return props.nodes.map((node) => ({
          node,
          current: currentById.get(node.id),
        })).map(({ node, current }) => {
          if (!current) return node;
          if (current === node) return current;
          const position = current.position;
          return position.x === node.position.x && position.y === node.position.y
            ? node
            : { ...node, position };
        });
      });
      return;
    }
    const interruptedProjection = projectionActive.current;
    stopSequence();
    // A new projection owns all moving geometry. Cancel any camera or focus loop still targeting
    // the previous layout before preparing the next last-write-wins generation.
    stopFlight();
    stopProjectionFlight();
    if (preserveProjection) {
      // Swapping semantic projections can make React Flow emit multiple transform frames even
      // when the reader did not touch the camera. Do not report those layout-owned frames as a
      // zoom gesture that immediately reverses an explicit Map content choice.
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animateProjection = props.animateProjectionChanges === true && !reducedMotion;
      const cameraGestureAtStart = projectionCameraGesture.current;
      projectionSequence.current += 1;
      const sequence = projectionSequence.current;
      const logicalCurrent = getNodes();
      for (const node of logicalCurrent) {
        projectionPositions.current.set(node.id, { ...node.position });
      }
      const current = interruptedProjection
        ? nodesAtPaintedPositions(logicalCurrent, canvasRef.current)
        : logicalCurrent;
      const next = props.preserveNodePositionsOnLayoutChange
        ? retainProjectionPositions(props.nodes, current, projectionPositions.current)
        : props.nodes;
      setEdges(props.edges);
      if (animateProjection) {
        // Internal projection state updates rerender this effect before the two-frame preparation
        // finishes. Consume the restore/focus token first, while retaining the local command for
        // the prepared camera step, so that rerender cannot mistake it for a second generation
        // and cancel the projection it just started.
        if (cameraOverride) claimCameraOverride();
        projectionActive.current = true;
        let frames = projectionTransitionFrames(next, current, {
          ...(previousSemanticLevel ? { fromLevel: previousSemanticLevel } : {}),
          ...(props.projectionSemanticLevel ? { toLevel: props.projectionSemanticLevel } : {}),
        });
        // Adjacent hierarchy levels use different world layouts but describe the same map. Treat
        // both pairs as reversible screen-space FLIPs: commit the destination camera with an
        // inverse frame, then let retained nodes traverse the same path forward or backward.
        const adjacentProjectionPair = isAdjacentSemanticTransition({
          ...(previousSemanticLevel ? { fromLevel: previousSemanticLevel } : {}),
          ...(props.projectionSemanticLevel ? { toLevel: props.projectionSemanticLevel } : {}),
        });
        const startViewport = getViewport();
        const nextContentBox = projectionContentBox(next);
        const directFitPadding = typeof props.fitViewOptions?.padding === "number"
          ? props.fitViewOptions.padding
          : 0.1;
        const directFitFrame = normalizeCanvasVisibleFrame(
          visibleFrame,
          canvasWidth,
          canvasHeight,
        );
        const nextFullBounds = nextContentBox ? {
              x: nextContentBox.minX,
              y: nextContentBox.minY,
              width: nextContentBox.width,
              height: nextContentBox.height,
            } : undefined;
        const nextFitBounds = nextFullBounds
          ? fit === "width"
            ? nextFullBounds
            : canvasPriorityProjectionBounds(next, nextFullBounds, {
              canvasWidth,
              canvasHeight,
              padding: directFitPadding,
              ...(directFitFrame ? { visibleFrame: directFitFrame } : {}),
              ...(props.priorityNodeIds ? { priorityNodeIds: props.priorityNodeIds } : {}),
              ...(props.readableZoomFloor !== undefined
                ? { readableZoomFloor: props.readableZoomFloor }
                : {}),
              ...(priorityFitReference ? { priorityFitReference } : {}),
            })
          : undefined;
        const directTarget = nextFitBounds
          ? (fit === "width" ? canvasWidthViewport : canvasBoundsViewport)(nextFitBounds, {
              canvasWidth,
              canvasHeight,
              minZoom: props.fitViewOptions?.minZoom ?? minZoom,
              maxZoom: props.fitViewOptions?.maxZoom ?? maxZoom,
              padding: directFitPadding,
              ...(props.fitLeftInset !== undefined
                ? { leftInset: props.fitLeftInset }
                : {}),
              ...(props.fitTopInset !== undefined
                ? { topInset: props.fitTopInset }
                : {}),
              ...(visibleFrame ? { visibleFrame } : {}),
            })
          : undefined;
        const directFitPlan = cameraOverride
          ? { target: cameraOverride.target }
          : (fit === "bounds" || fit === "width")
            && canvasWidth > 0
            && canvasHeight > 0
            && (projectionFitRequested || adjacentProjectionPair)
            ? directTarget ? { target: directTarget } : undefined
            : undefined;
        // Screen cards mount in the source camera before the fit begins. Give them the target
        // zoom up front so route rows never change the screenshot's flex height at cleanup.
        setProjectionTargetZoom(directFitPlan?.target.zoom ?? startViewport.zoom);
        setProjectionAnimating(true);
        // A Back/Forward restore (or a focus revealed by this projection) is the destination
        // camera. Using the generic projection fit here would consume the higher-priority
        // command while landing somewhere else. The target-first FLIP works with either target:
        // its inverse node frame still makes the first painted pixel continuous with the source.
        const adjacentProjectionTarget = cameraOverride?.target ?? directFitPlan?.target;
        const adjacentProjectionFlip = adjacentProjectionPair && adjacentProjectionTarget
          ? { startViewport, targetViewport: adjacentProjectionTarget }
          : undefined;
        if (adjacentProjectionFlip) {
          frames = projectionScreenSpaceFrames(
            frames,
            adjacentProjectionFlip.startViewport,
            adjacentProjectionFlip.targetViewport,
          );
          if (!cameraOverride) previousProjectionFitKey.current = props.projectionFitKey;
          // Both changes land before the browser can paint. The inverse frame exactly cancels the
          // target-camera cut, so the first visible frame is pixel-continuous with its source.
          flushSync(() => setNodes(frames.prepared));
          suppressProgrammaticEndUntil.current = performance.now() + 80;
          void setViewport(adjacentProjectionFlip.targetViewport);
          appliedVisibleFrameRevision.current = visibleFrame?.revision ?? 0;
          firstCameraSettled.current = true;
          emitViewportChange(adjacentProjectionFlip.targetViewport, "programmatic", "end");
        } else {
          setNodes(frames.prepared);
        }
        // A generic projection may stagger crossfades. Keep every actor alive through its own
        // delay plus the shared motion duration instead of cutting the last group off at 200ms.
        const projectionSettleDuration = PROJECTION_MOVE_DURATION
          + Math.max(0, ...frames.active.map((node) => projectionNodeDelay(node)))
          + PROJECTION_SETTLE_SLACK;
        projectionPrepareFrame.current = requestAnimationFrame(() => {
          if (projectionSequence.current !== sequence) {
            projectionPrepareFrame.current = undefined;
            return;
          }
          // The second frame guarantees the hidden entering cards have committed once. Their
          // next class change can then transition from the painted state instead of being batched
          // into the mount and flashing directly to fully visible.
          projectionPrepareFrame.current = requestAnimationFrame(() => {
            projectionPrepareFrame.current = undefined;
            if (projectionSequence.current !== sequence) return;
            // React may otherwise postpone this RAF update while the imperative camera already
            // advances. One scoped flush makes the node and camera timelines begin on one frame.
            flushSync(() => setNodes(frames.active));
            if (cameraOverride && !adjacentProjectionFlip) {
              if (projectionCameraGesture.current !== cameraGestureAtStart) {
                // A gesture during preparation remains authoritative, but this restore/focus
                // generation is consumed so it cannot replay after the projection settles.
              } else {
                startViewportFlight(cameraOverride.target, cameraOverride.behavior, {
                  duration: PROJECTION_MOVE_DURATION,
                  owner: cameraOverride.kind === "focus" ? "focus" : "camera",
                });
              }
            } else if (projectionFitRequested && !adjacentProjectionFlip) {
              if (projectionCameraGesture.current !== cameraGestureAtStart) {
                // The reader took over during preparation. Consume this fit request so the
                // topology-stable effect after settlement cannot replay it over their gesture.
                previousProjectionFitKey.current = props.projectionFitKey;
              } else if (fitProjectionCamera(frames.source, next, true, {
                nodes: frames.active,
                // App areas is the overview destination: returning to it must frame the complete
                // area grid instead of preserving the branch anchor and its detail-level zoom.
                camera: props.projectionSemanticLevel === "overview"
                  ? "direct-fit"
                  : "semantic-anchor",
              })) {
                previousProjectionFitKey.current = props.projectionFitKey;
              }
            }
            timers.current.push(window.setTimeout(() => {
              if (projectionSequence.current !== sequence) return;
              // React Flow mirrors the controlled arrays into its internal store. Commit the final
              // projection before dropping the motion guard so no frame exposes stale exit actors
              // as an interactive, settled canvas.
              flushSync(() => {
                setNodes(incoming.current);
                setEdges(incomingEdges.current);
              });
              // React Flow synchronizes its internal store after the controlled arrays commit.
              // Keep the projection guard for that paint, then expose the settled canvas.
              const finishProjection = () => {
                projectionPrepareFrame.current = undefined;
                if (projectionSequence.current !== sequence) return;
                // The CSS actors and camera begin on the same frame, but a RAF camera flight
                // needs one cadence-sampling frame before it advances. Its final frame can
                // therefore land one paint after the nominal CSS duration. Keep the projection
                // guard and destination-density geometry active until that camera owner has
                // actually committed its target instead of exposing a one-frame zoom/height tail.
                if (flight.current !== undefined || projectionFlight.current !== undefined) {
                  projectionPrepareFrame.current = requestAnimationFrame(finishProjection);
                  return;
                }
                projectionActive.current = false;
                setProjectionAnimating(false);
                setProjectionTargetZoom(undefined);
              };
              projectionPrepareFrame.current = requestAnimationFrame(finishProjection);
            }, projectionSettleDuration));
          });
        });
      } else if (props.preserveNodePositionsOnLayoutChange) {
        projectionActive.current = false;
        setProjectionAnimating(false);
        setProjectionTargetZoom(undefined);
        setNodes(next);
        if (cameraOverride) {
          claimCameraOverride();
          startViewportFlight(cameraOverride.target, cameraOverride.behavior, {
            duration: PROJECTION_MOVE_DURATION,
            owner: cameraOverride.kind === "focus" ? "focus" : "camera",
          });
        } else if (projectionFitRequested && fitProjectionCamera(
          current,
          next,
          false,
          props.projectionSemanticLevel === "overview"
            ? { nodes: next, camera: "direct-fit" }
            : undefined,
        )) {
          previousProjectionFitKey.current = props.projectionFitKey;
        }
      } else {
        projectionActive.current = false;
        setProjectionAnimating(false);
        setProjectionTargetZoom(undefined);
        setNodes(next);
        if (cameraOverride) {
          claimCameraOverride();
          startViewportFlight(cameraOverride.target, cameraOverride.behavior, {
            duration: PROJECTION_MOVE_DURATION,
            owner: cameraOverride.kind === "focus" ? "focus" : "camera",
          });
        } else if (projectionFitRequested && fitProjectionCamera(
          current,
          next,
          false,
          props.projectionSemanticLevel === "overview"
            ? { nodes: next, camera: "direct-fit" }
            : undefined,
        )) {
          previousProjectionFitKey.current = props.projectionFitKey;
        }
      }
      // A semantic projection already uses the current world and camera, so it is aligned as-is.
      // Marking it prevents onMoveEnd from applying the legacy top alignment after the gesture.
      alignedLayout.current = props.layoutIdentity;
      setFitRequest(undefined);
      setRelayout("idle");
      return;
    }
    projectionSequence.current += 1;
    projectionActive.current = false;
    setProjectionAnimating(false);
    setProjectionTargetZoom(undefined);
    // Decide before claiming the camera: the claim marks this layout aligned, and the setNodes
    // updater runs later, so reading the ref inside it would keep a never-aligned layout's
    // positions (a cold deep link then left overview cards on top of the detail screen).
    const takeIncomingPositions = documentChanged || alignedLayout.current === undefined;
    if (cameraOverride) {
      claimCameraOverride();
      setNodes((current) => (
        takeIncomingPositions
          ? props.nodes
          : retainNodePositions(props.nodes, current)
      ));
      setEdges(props.edges);
      setRelayout("idle");
      startViewportFlight(cameraOverride.target, cameraOverride.behavior, {
        owner: cameraOverride.kind === "focus" ? "focus" : "camera",
      });
      return;
    }
    // The new layout owns the camera now; a flight aimed at the old one would fight the refit.
    if (!choreograph) {
      if (projectionFitRequested) previousProjectionFitKey.current = props.projectionFitKey;
      setFitRequest(props.layoutIdentity);
      setNodes((current) => (
        takeIncomingPositions
          ? props.nodes
          : retainNodePositions(props.nodes, current)
      ));
      setEdges(props.edges);
      setRelayout("idle");
      return;
    }
    setRelayout("out");
    timers.current.push(window.setTimeout(() => {
      // Dark: the nodes take their new places and the camera cuts to the new framing.
      setNodes((current) => documentChanged
        ? incoming.current
        : retainNodePositions(incoming.current, current));
      setEdges(incomingEdges.current);
      setFitRequest(props.layoutIdentity);
    }, RELAYOUT_FADE_OUT));
    timers.current.push(window.setTimeout(() => setRelayout("in"), RELAYOUT_FADE_OUT + RELAYOUT_HOLD));
    // Dropping the class hands opacity back to the stylesheet, which owns the dimmed state of
    // a focused journey — the canvas is already at full opacity by then, so nothing jumps.
    timers.current.push(window.setTimeout(
      () => setRelayout("idle"),
      RELAYOUT_FADE_OUT + RELAYOUT_HOLD + RELAYOUT_FADE_IN,
    ));
  }, [
    emitViewportChange,
    fit,
    fitProjectionCamera,
    getNodes,
    canvasHeight,
    canvasWidth,
    maxZoom,
    minZoom,
    restoreRequested,
    restoreToken,
    restoredViewport,
    startViewportFlight,
    props.focus,
    props.historyIdentity,
    props.layoutIdentity,
    props.nodes,
    props.edges,
    props.animateProjectionChanges,
    props.fitLeftInset,
    props.fitTopInset,
    props.projectionFitKey,
    props.projectionSemanticLevel,
    props.restoreViewportBehavior,
    props.preserveNodePositionsOnLayoutChange,
    props.preserveViewportOnLayoutChange,
    visibleFrame,
    projectionAnimating,
    priorityFitReference,
    relayout,
    setNodes,
    stopFlight,
    stopProjectionFlight,
  ]);

  useEffect(() => {
    const applySnapshot = (snapshot: PositionSnapshot) => {
      if (props.preserveViewportOnLayoutChange) {
        for (const [id, position] of Object.entries(snapshot)) {
          projectionPositions.current.set(id, { ...position });
        }
      }
      setNodes((current) => current.map((node) => {
        const position = snapshot[node.id];
        return position ? { ...node, position: { x: position.x, y: position.y } } : node;
      }));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shortcutsLive(event)) return;
      if (matchesShortcut(event, SHORTCUTS.edit.undo)) {
        const entry = undoStack.current.pop();
        if (!entry) return;
        redoStack.current.push(entry);
        applySnapshot(entry.before);
        event.preventDefault();
      } else if (matchesShortcut(event, SHORTCUTS.edit.redo)) {
        const entry = redoStack.current.pop();
        if (!entry) return;
        undoStack.current.push(entry);
        applySnapshot(entry.after);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.preserveViewportOnLayoutChange, setNodes]);

  useEffect(() => {
    if (props.selectedNodeId === undefined) return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const selected = node.id === props.selectedNodeId;
        if (Boolean(node.selected) === selected) return node;
        changed = true;
        return { ...node, selected };
      });
      return changed ? next : current;
    });
  }, [props.selectedNodeId, setNodes]);

  useEffect(() => {
    if (!restoreFocusGuard.current) return;
    if (restoreFocusGuardFrame.current !== undefined) {
      cancelAnimationFrame(restoreFocusGuardFrame.current);
    }
    // App may derive the route focus in a parent effect. Keep the restore authoritative through
    // that follow-up commit, then let later user-driven focus requests operate normally.
    restoreFocusGuardFrame.current = requestAnimationFrame(() => {
      restoreFocusGuardFrame.current = requestAnimationFrame(() => {
        restoreFocusGuardFrame.current = undefined;
        restoreFocusGuard.current = false;
      });
    });
    return () => {
      if (restoreFocusGuardFrame.current === undefined) return;
      cancelAnimationFrame(restoreFocusGuardFrame.current);
      restoreFocusGuardFrame.current = undefined;
    };
  }, [restoreToken]);

  useEffect(() => () => {
    stopSequence();
    stopFlight(false);
    stopProjectionFlight();
    cancelVisibleFrameRefit();
    if (initialFitFrame.current !== undefined) cancelAnimationFrame(initialFitFrame.current);
    if (initialRevealFrame.current !== undefined) cancelAnimationFrame(initialRevealFrame.current);
    if (restoreFocusGuardFrame.current !== undefined) {
      cancelAnimationFrame(restoreFocusGuardFrame.current);
    }
    projectionActive.current = false;
    projectionSequence.current += 1;
  }, [cancelVisibleFrameRefit, stopFlight, stopProjectionFlight]);

  // Report the initial camera (and a canvas resize that changes its world-space centre). All
  // subsequent user and programmatic camera movement is reported by React Flow's onMove hook.
  useEffect(() => {
    if (!firstCameraSettled.current || fitRequest !== undefined) return;
    emitViewportChange(getViewport(), "programmatic", "end");
  }, [canvasHeight, canvasWidth, emitViewportChange, fitRequest, getViewport]);

  useEffect(() => {
    if (!visibleFrame || !nodesInitialized || fitRequest !== props.layoutIdentity || restoreRequested) return;
    const firstFit = alignedLayout.current === undefined;
    const applyFit = () => {
      initialFitFrame.current = undefined;
      // App resolves direct-link focus in a parent effect. Let that request replace the opening
      // fit even when it arrives one paint after CanvasStage mounted.
      const focus = latestFocus.current;
      if (
        focus
        && consumedFocus.current !== focus.key
        && incoming.current.some((node) => node.id === focus.nodeId)
      ) {
        alignedLayout.current = props.layoutIdentity;
        setFitRequest(undefined);
        return;
      }
      setFitRequest(undefined);
      stopFlight();
      if (fit === "bounds") {
        // Every node carries explicit dimensions, so the bounds come from the incoming layout
        // rather than from React Flow's measurements: with `onlyRenderVisibleElements`, nodes
        // that a re-layout moved off-screen are not measured yet and `fitView` would skip them.
        // Opening the map frames the whole graph; a re-layout frames the entrance instead, so
        // the camera lands on a screen the reader can place rather than on the whole wall of
        // thumbnails at a zoom nothing is readable at.
        const anchored = !firstFit && props.anchorBox !== undefined;
        const box = anchored ? props.anchorBox! : projectionContentBox(nodes);
        if (!box || box.width <= 0 || box.height <= 0 || canvasWidth <= 0 || canvasHeight <= 0) {
          setInitialCameraReady(true);
          return;
        }
        const padding = typeof props.fitViewOptions?.padding === "number" ? props.fitViewOptions.padding : 0.1;
        const frame = normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight);
        const fullBounds = {
          x: box.minX,
          y: box.minY,
          width: box.width,
          height: box.height,
        };
        const bounds = anchored ? fullBounds : canvasPriorityProjectionBounds(nodes, fullBounds, {
          canvasWidth,
          canvasHeight,
          padding,
          ...(frame ? { visibleFrame: frame } : {}),
          ...(props.priorityNodeIds ? { priorityNodeIds: props.priorityNodeIds } : {}),
          ...(props.readableZoomFloor !== undefined
            ? { readableZoomFloor: props.readableZoomFloor }
            : {}),
          ...(priorityFitReference ? { priorityFitReference } : {}),
        });
        const target = canvasBoundsViewport(bounds, {
          canvasWidth,
          canvasHeight,
          minZoom: props.fitViewOptions?.minZoom ?? minZoom,
          maxZoom: anchored ? ANCHOR_MAX_ZOOM : (props.fitViewOptions?.maxZoom ?? maxZoom),
          padding,
          ...(!anchored && props.fitLeftInset !== undefined
            ? { leftInset: props.fitLeftInset }
            : {}),
          ...(!anchored && props.fitTopInset !== undefined
            ? { topInset: props.fitTopInset }
            : {}),
          ...(visibleFrame ? { visibleFrame } : {}),
        });
        if (!target) {
          setInitialCameraReady(true);
          return;
        }
        // Both the opening fit and every re-layout land the same way — a straight cut. The
        // re-layout one happens behind the fade, where a camera move would only be motion the
        // reader has to sit through before the new arrangement can be read.
        alignedLayout.current = props.layoutIdentity;
        appliedVisibleFrameRevision.current = visibleFrame?.revision ?? 0;
        firstCameraSettled.current = true;
        suppressProgrammaticEndUntil.current = performance.now() + 80;
        void setViewport(target);
        if (!initialCameraReady) {
          initialRevealFrame.current = requestAnimationFrame(() => {
            initialRevealFrame.current = undefined;
            setInitialCameraReady(true);
          });
        }
        return;
      }
      // Screen inventories are width-led: keep the whole group centred horizontally and anchor
      // its top edge below the canvas chrome. Vertically centring a tall inventory makes its first
      // rows appear thousands of pixels below the viewport and breaks visual continuity.
      const box = projectionContentBox(nodes);
      if (!box || box.width <= 0 || box.height <= 0 || canvasWidth <= 0 || canvasHeight <= 0) {
        setInitialCameraReady(true);
        return;
      }
      const frame = normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight);
      if (!frame) {
        setInitialCameraReady(true);
        return;
      }
      const fullBounds = { x: box.minX, y: box.minY, width: box.width, height: box.height };
      const padding = typeof props.fitViewOptions?.padding === "number" ? props.fitViewOptions.padding : 0.1;
      const target = canvasWidthViewport(fullBounds, {
        canvasWidth,
        canvasHeight,
        minZoom: props.fitViewOptions?.minZoom ?? minZoom,
        maxZoom: Math.min(1, props.fitViewOptions?.maxZoom ?? maxZoom),
        padding,
        ...(props.fitTopInset !== undefined ? { topInset: props.fitTopInset } : {}),
        visibleFrame: frame,
      });
      if (!target) {
        setInitialCameraReady(true);
        return;
      }
      alignedLayout.current = props.layoutIdentity;
      appliedVisibleFrameRevision.current = visibleFrame?.revision ?? 0;
      firstCameraSettled.current = true;
      suppressProgrammaticEndUntil.current = performance.now() + 80;
      void setViewport(target);
      if (!initialCameraReady) {
        initialRevealFrame.current = requestAnimationFrame(() => {
          initialRevealFrame.current = undefined;
          setInitialCameraReady(true);
        });
      }
    };
    if (firstFit) {
      initialFitFrame.current = requestAnimationFrame(applyFit);
      return () => {
        if (initialFitFrame.current === undefined) return;
        cancelAnimationFrame(initialFitFrame.current);
        initialFitFrame.current = undefined;
      };
    }
    applyFit();
  }, [
    canvasHeight,
    canvasWidth,
    fit,
    fitRequest,
    initialCameraReady,
    maxZoom,
    minZoom,
    nodes,
    nodesInitialized,
    restoreRequested,
    props.fitViewOptions,
    props.fitLeftInset,
    props.fitTopInset,
    props.anchorBox,
    props.layoutIdentity,
    props.nodes,
    props.priorityNodeIds,
    props.readableZoomFloor,
    priorityFitReference,
    visibleFrame,
    setViewport,
    stopFlight,
  ]);

  // Only the camera viewport changes during a focus flight. Progress follows wall time, so a
  // busy frame cannot stretch a nominally short navigation into a visibly slow zoom.
  useEffect(() => {
    const focus = props.focus;
    if (!focus) {
      // Projection/history restores intentionally have no focus target. Their camera flight may
      // overlap projection state rerenders, so focus cleanup must not cancel that other owner.
      if (flightOwner.current === "focus") stopFlight();
      return;
    }
    if (consumedFocus.current === focus.key) return;
    if (restoreFocusGuard.current) {
      consumedFocus.current = focus.key;
      return;
    }
    // A fit or a re-layout still in flight would land on top of the focus, so it waits its
    // turn: both are state, so settling them runs this again.
    if (
      !visibleFrame
      || !nodesInitialized
      || fitRequest !== undefined
      || relayout !== "idle"
      || projectionAnimating
      || projectionActive.current
    ) return;
    // Canvas size is read off the store rather than subscribed to: as a dependency it would
    // replay the whole flight on every resize.
    const { width: canvasWidth, height: canvasHeight } = storeApi.getState();
    if (canvasWidth <= 0 || canvasHeight <= 0) return;
    const node = getInternalNode(focus.nodeId);
    const width = node?.width ?? node?.measured?.width ?? 0;
    const height = node?.height ?? node?.measured?.height ?? 0;
    // A target the canvas cannot place yet leaves the request pending rather than spending it:
    // a link into a live exploration lands once the node it names turns up.
    if (!node || width <= 0 || height <= 0) return;
    consumedFocus.current = focus.key;
    stopFlight();
    stopProjectionFlight();

    // Tiles sit inside a group, so their own position is relative to it; the absolute one is
    // what the camera needs.
    const position = node.internals.positionAbsolute;
    const target = canvasBoundsViewport({
      x: position.x,
      y: position.y,
      width,
      height,
    }, {
      canvasWidth,
      canvasHeight,
      minZoom,
      maxZoom: FOCUS_MAX_ZOOM,
      padding: FOCUS_PADDING,
      ...(visibleFrame ? { visibleFrame } : {}),
    });
    if (!target) return;
    startViewportFlight(target, focus.behavior, { hideOverlays: true, owner: "focus" });
    if (!initialCameraReady) setInitialCameraReady(true);
  }, [
    fitRequest,
    getInternalNode,
    initialCameraReady,
    minZoom,
    nodesInitialized,
    props.focus,
    projectionAnimating,
    relayout,
    startViewportFlight,
    storeApi,
    stopFlight,
    stopProjectionFlight,
    visibleFrame,
  ]);

  // A desktop left-panel toggle moves the React Flow root itself by 300px in one layout commit.
  // Rebase the local camera by the inverse root delta before paint (FLIP's "invert" step). This
  // must also run while the frame provider intentionally publishes `undefined` for a new shell
  // layout; waiting for its measured frame would paint the moved root once before compensation.
  // The frame owners below can then animate from the same visually stable source.
  useLayoutEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const previous = visibleFrameCanvasOrigin.current;
    visibleFrameCanvasOrigin.current = { x: box.left, y: box.top };
    if (!previous || !firstCameraSettled.current) return;
    const dx = previous.x - box.left;
    const dy = previous.y - box.top;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    // Cancel any obsolete flight before rebasing so its next RAF cannot overwrite this new
    // screen-space source. Reduced-motion still uses this invisible coordinate correction; its
    // following Fit remains a direct cut rather than an animation.
    cancelVisibleFrameRefit();
    stopFlight();
    stopProjectionFlight();
    const viewport = getViewport();
    suppressProgrammaticEndUntil.current = performance.now() + 80;
    activeMoveSource.current = "programmatic";
    void setViewport({
      x: viewport.x + dx,
      y: viewport.y + dy,
      zoom: viewport.zoom,
    });
  }, [
    cancelVisibleFrameRefit,
    getViewport,
    setViewport,
    stopFlight,
    stopProjectionFlight,
    visibleFrame,
  ]);

  // Opening hard chrome removes canvas space immediately. Start its refit in this layout effect,
  // before the opening commit paints, so the panel and camera move as one episode. Consuming the
  // visible-frame revision here prevents the settled-frame effect below from adding a late tail.
  useLayoutEffect(() => {
    if (!visibleFrame) return;
    const root = canvasRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    // Compare viewport-space edges. Local frame width alone misclassifies a flex-panel shift
    // when another occluder disappears in the same commit (for example Flows → Screens).
    const nextBounds = {
      x: box.left + visibleFrame.x,
      y: box.top + visibleFrame.y,
      width: visibleFrame.width,
      height: visibleFrame.height,
    };
    const previous = previousVisibleFrameBounds.current;
    if (!previous) {
      previousVisibleFrameBounds.current = nextBounds;
      return;
    }
    const contracted = canvasVisibleFrameContracts(previous, nextBounds);
    if (
      !contracted
      || props.preserveViewportOnVisibleFrameChange
    ) {
      previousVisibleFrameBounds.current = nextBounds;
      return;
    }
    // Keep the previous boundary while camera/layout ownership is busy. A later commit retries
    // the same contraction instead of spending its revision and revealing a stale viewport.
    if (
      !nodesInitialized
      || fitRequest !== undefined
      || restoreRequested
      || relayout !== "idle"
      || projectionAnimating
      || projectionActive.current
    ) return;

    cancelVisibleFrameRefit();
    stopFlight();
    stopProjectionFlight();
    const currentNodes = getNodes();
    const currentFocus = latestFocus.current;
    // A camera still on its automatic fit fits the content again, in the new frame.
    if (autoCamera.current?.kind === "fit" && (!currentFocus || consumedFocus.current === currentFocus.key)) {
      if (fitProjectionCamera(currentNodes, currentNodes, true, { nodes: currentNodes, camera: "direct-fit" })) {
        previousVisibleFrameBounds.current = nextBounds;
      }
      return;
    }
    const placed = autoCamera.current;
    if (placed?.kind === "focus" && placed.nodeId !== props.selectedNodeId) {
      const target = canvasFocusViewport(currentNodes, placed.nodeId, canvasWidth, canvasHeight,
        minZoom, FOCUS_MAX_ZOOM, FOCUS_PADDING, visibleFrame);
      if (target) {
        if (currentFocus) consumedFocus.current = currentFocus.key;
        previousVisibleFrameBounds.current = nextBounds;
        startViewportFlight(target, "fly", { hideOverlays: true, owner: "focus" });
        autoCamera.current = placed;
      }
      return;
    }
    // A focus not yet flown to (a flow just chosen, whose entry screen is now selected) is the
    // camera's target; the selection does not replace it.
    if (currentFocus?.nodeId && consumedFocus.current !== currentFocus.key) {
      const target = canvasFocusViewport(currentNodes, currentFocus.nodeId, canvasWidth, canvasHeight,
        minZoom, FOCUS_MAX_ZOOM, FOCUS_PADDING, visibleFrame);
      if (target) {
        consumedFocus.current = currentFocus.key;
        previousVisibleFrameBounds.current = nextBounds;
        startViewportFlight(target, "fly", { hideOverlays: true, owner: "focus" });
        return;
      }
    }
    const selectedNodeIds = canvasSelectionNodeIds(currentNodes, props.selectedNodeId);
    if (selectionStaysInView(currentNodes, selectedNodeIds, visibleFrame)) {
      if (currentFocus) consumedFocus.current = currentFocus.key;
      previousVisibleFrameBounds.current = nextBounds;
      return;
    }
    if (selectedNodeIds.length > 0) {
      const target = canvasSelectionViewport(currentNodes, selectedNodeIds, {
        canvasWidth,
        canvasHeight,
        minZoom,
        maxZoom,
        visibleFrame,
      });
      if (target) {
        if (currentFocus) consumedFocus.current = currentFocus.key;
        previousVisibleFrameBounds.current = nextBounds;
        startViewportFlight(target, "fly", { hideOverlays: true, owner: "selection" });
        return;
      }
    }
    const focusNodeId = currentFocus?.nodeId;
    if (focusNodeId) {
      const target = canvasFocusViewport(
        currentNodes,
        focusNodeId,
        canvasWidth,
        canvasHeight,
        minZoom,
        FOCUS_MAX_ZOOM,
        FOCUS_PADDING,
        visibleFrame,
      );
      if (!target) return;
      if (currentFocus) consumedFocus.current = currentFocus.key;
      previousVisibleFrameBounds.current = nextBounds;
      startViewportFlight(target, "fly", { hideOverlays: true, owner: "focus" });
      return;
    }

    if (!fitProjectionCamera(currentNodes, currentNodes, true, {
      nodes: currentNodes,
      camera: "direct-fit",
    })) return;
    previousVisibleFrameBounds.current = nextBounds;
  }, [
    canvasHeight,
    canvasWidth,
    cancelVisibleFrameRefit,
    fitProjectionCamera,
    fitRequest,
    getNodes,
    maxZoom,
    minZoom,
    nodesInitialized,
    projectionAnimating,
    props.preserveViewportOnVisibleFrameChange,
    props.selectedNodeId,
    relayout,
    restoreRequested,
    startViewportFlight,
    stopFlight,
    stopProjectionFlight,
    visibleFrame,
  ]);

  // The provider publishes only settled geometry. Consume each revision once: a current focus
  // wins, otherwise the active projection is framed. A pointer or manual camera command cancels
  // the queued RAF and marks the generation handled, so no delayed tail can override the reader.
  useEffect(() => {
    const revision = visibleFrame?.revision ?? 0;
    if (appliedVisibleFrameRevision.current === revision) return;
    if (props.preserveViewportOnVisibleFrameChange) {
      cancelVisibleFrameRefit();
      appliedVisibleFrameRevision.current = revision;
      return;
    }
    if (
      !visibleFrame
      || !canvasContainsVisibleFrame(visibleFrame, canvasWidth, canvasHeight)
      || !nodesInitialized
      || fitRequest !== undefined
      || restoreRequested
      || relayout !== "idle"
      || projectionAnimating
      || projectionActive.current
    ) return;
    const focus = latestFocus.current;
    if (focus && consumedFocus.current !== focus.key && !props.selectedNodeId) return;
    const gestureGeneration = projectionCameraGesture.current;
    cancelVisibleFrameRefit();
    visibleFrameRefitFrame.current = requestAnimationFrame(() => {
      visibleFrameRefitFrame.current = undefined;
      if (projectionCameraGesture.current !== gestureGeneration) return;
      const currentNodes = getNodes();
      const currentFocus = latestFocus.current;
      // A camera still on its automatic fit fits the content again, in the new frame.
      if (autoCamera.current?.kind === "fit" && (!currentFocus || consumedFocus.current === currentFocus.key)) {
        if (!fitProjectionCamera(currentNodes, currentNodes, true, { nodes: currentNodes, camera: "direct-fit" })) {
          appliedVisibleFrameRevision.current = revision;
        }
        return;
      }
      // A camera still on a requested focus (a flow, a screen) aims at it again, in the new frame.
      const placed = autoCamera.current;
      if (placed?.kind === "focus" && placed.nodeId !== props.selectedNodeId) {
        const target = canvasFocusViewport(currentNodes, placed.nodeId, canvasWidth, canvasHeight,
          minZoom, FOCUS_MAX_ZOOM, FOCUS_PADDING, visibleFrame);
        if (target) {
          if (currentFocus) consumedFocus.current = currentFocus.key;
          startViewportFlight(target, "fly", { hideOverlays: true, owner: "focus" });
          autoCamera.current = placed;
        } else {
          appliedVisibleFrameRevision.current = revision;
        }
        return;
      }
      // A focus not yet flown to is the camera's target; the selection does not replace it.
      if (currentFocus?.nodeId && consumedFocus.current !== currentFocus.key) {
        const target = canvasFocusViewport(currentNodes, currentFocus.nodeId, canvasWidth, canvasHeight,
          minZoom, FOCUS_MAX_ZOOM, FOCUS_PADDING, visibleFrame);
        if (target) {
          consumedFocus.current = currentFocus.key;
          startViewportFlight(target, "fly", { hideOverlays: true, owner: "focus" });
          return;
        }
      }
      const selectedNodeIds = canvasSelectionNodeIds(currentNodes, props.selectedNodeId);
      if (selectionStaysInView(currentNodes, selectedNodeIds, visibleFrame)) {
        if (currentFocus) consumedFocus.current = currentFocus.key;
        appliedVisibleFrameRevision.current = revision;
        return;
      }
      if (selectedNodeIds.length > 0) {
        const target = canvasSelectionViewport(currentNodes, selectedNodeIds, {
          canvasWidth,
          canvasHeight,
          minZoom,
          maxZoom,
          visibleFrame,
        });
        if (target) {
          if (currentFocus) consumedFocus.current = currentFocus.key;
          startViewportFlight(target, "fly", { hideOverlays: true, owner: "selection" });
          return;
        }
      }
      const focusNodeId = currentFocus?.nodeId;
      if (focusNodeId) {
        const target = canvasFocusViewport(
          currentNodes,
          focusNodeId,
          canvasWidth,
          canvasHeight,
          minZoom,
          FOCUS_MAX_ZOOM,
          FOCUS_PADDING,
          visibleFrame,
        );
        if (!target) return;
        startViewportFlight(target, "fly", { hideOverlays: true, owner: "focus" });
        return;
      }
      // The provider has already collapsed a burst of ResizeObserver notifications into one
      // settled geometry revision. Fly once to that frame so opening or closing canvas chrome
      // reads as one continuous camera move; a pointer gesture still cancels the flight below.
      if (fitProjectionCamera(currentNodes, currentNodes, true, {
        nodes: currentNodes,
        camera: "direct-fit",
      })) return;
      appliedVisibleFrameRevision.current = revision;
    });
    return cancelVisibleFrameRefit;
  }, [
    canvasHeight,
    canvasWidth,
    cancelVisibleFrameRefit,
    fitProjectionCamera,
    fitRequest,
    getNodes,
    maxZoom,
    minZoom,
    nodesInitialized,
    projectionAnimating,
    props.preserveViewportOnVisibleFrameChange,
    props.selectedNodeId,
    relayout,
    restoreRequested,
    startViewportFlight,
    visibleFrame,
  ]);

  const projectionMotion = useMemo<CanvasProjectionMotion>(() => ({
    active: projectionAnimating,
    ...(projectionAnimating && projectionTargetZoom !== undefined
      ? { targetZoom: projectionTargetZoom }
      : {}),
  }), [projectionAnimating, projectionTargetZoom]);

  return (
    <CanvasProjectionMotionContext.Provider value={projectionMotion}>
      <ReactFlow
        ref={canvasRef}
        className={`canvas-tool-pan${initialCameraReady ? "" : " canvas-camera-initializing"}${focusAnimating ? " canvas-focus-animating" : ""}${cameraFlying ? " canvas-camera-flying" : ""}${projectionAnimating ? " canvas-projection-animating" : ""}${relayout === "idle" ? "" : ` canvas-relayout-${relayout}`}${props.className ? ` ${props.className}` : ""}`}
        nodes={nodes}
        edges={edges}
      onNodesChange={onNodesChange}
      onNodeDragStart={() => {
        dragOrigin.current = positionSnapshot(getNodes());
      }}
      onNodeDragStop={() => {
        const before = dragOrigin.current;
        dragOrigin.current = undefined;
        if (!before) return;
        const after = positionSnapshot(getNodes());
        if (!positionsChanged(before, after)) return;
        if (props.preserveViewportOnLayoutChange) {
          for (const [id, position] of Object.entries(after)) {
            projectionPositions.current.set(id, { ...position });
          }
        }
        undoStack.current.push({ before, after });
        redoStack.current = [];
      }}
      nodeTypes={props.nodeTypes}
      {...(props.edgeTypes ? { edgeTypes: props.edgeTypes } : {})}
      defaultEdgeOptions={CANVAS_EDGE_OPTIONS}
      // Layering is owned by the canvas node types. React Flow's default selected-node lift puts
      // a selected parent group at z=1000, while our screenshot children deliberately sit at the
      // fixed inventory layer; the parent surface would then paint over its own screenshots.
      // Selection remains enabled for Inspector/Fit semantics, only the automatic lift is off.
      elevateNodesOnSelect={false}
      elevateEdgesOnSelect={false}
      minZoom={minZoom}
      maxZoom={maxZoom}
      defaultViewport={restoredViewport ?? { x: 0, y: 0, zoom: minZoom }}
      {...(props.fitViewOptions ? { fitViewOptions: props.fitViewOptions } : {})}
      // A projection temporarily renders the source and destination together. Virtualizing that
      // union would unmount off-camera shared actors mid-flight, making persistent summary cards
      // disappear and reappear as the camera moves. The short transition keeps the union mounted;
      // settled large graphs still use React Flow virtualization.
      onlyRenderVisibleElements={!projectionAnimating && nodes.length > VIRTUALIZATION_THRESHOLD}
      // Screens and flow containers are navigation targets, not freeform canvas objects. Keeping
      // them non-draggable also lets a drag that starts over an object pan the canvas, while a
      // click still selects it.
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      deleteKeyCode={null}
      // Screens remain individually selectable. Only the pane-drag marquee is disabled below.
      elementsSelectable
      // Drag pans and a plain wheel scrolls the canvas like a document; Command/Control with the
      // wheel zooms.
      panOnDrag
      selectionOnDrag={false}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      autoPanOnSelection={false}
      panOnScroll
      panOnScrollMode={PanOnScrollMode.Free}
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick
      onPaneClick={() => props.onClearSelection?.()}
      onMove={handleMove}
      onMoveStart={(event) => {
        // A real pointer/wheel gesture immediately owns the camera. Programmatic setViewport
        // calls report no event and belong to the focus loop itself.
        activeMoveSource.current = event ? "gesture" : "programmatic";
        if (event) {
          panSamples.current = [];
          cancelVisibleFrameRefit();
          appliedVisibleFrameRevision.current = visibleFrame?.revision ?? 0;
          if (props.focus) consumedFocus.current = props.focus.key;
          stopFlight();
          stopProjectionFlight();
          autoCamera.current = undefined;
          projectionCameraGesture.current += 1;
        }
      }}
      onMoveEnd={(event, viewport) => {
        if (!event && performance.now() < suppressProgrammaticEndUntil.current) return;
        // A touch lifted mid-flick is gliding; its end is reported once the map settles.
        if (flightOwner.current === "glide") return;
        const source = event ? "gesture" : activeMoveSource.current ?? "programmatic";
        activeMoveSource.current = undefined;
        if (source === "gesture") {
          emitViewportChange(viewport, "gesture", "end");
        } else {
          emitViewportChange(viewport, "programmatic", "end");
        }
      }}
      proOptions={{ hideAttribution: true }}>
      <ZoomBridge
        cameraReady={initialCameraReady}
        fit={fit}
        {...(props.fitLeftInset !== undefined ? { fitLeftInset: props.fitLeftInset } : {})}
        {...(props.fitTopInset !== undefined ? { fitTopInset: props.fitTopInset } : {})}
        fitPadding={typeof props.fitViewOptions?.padding === "number"
          ? props.fitViewOptions.padding
          : 0.1}
        {...(props.fitViewOptions?.maxZoom !== undefined
          ? { fitMaxZoom: props.fitViewOptions.maxZoom }
          : {})}
        {...(props.priorityNodeIds ? { priorityNodeIds: props.priorityNodeIds } : {})}
        {...(props.readableZoomFloor !== undefined
          ? { readableZoomFloor: props.readableZoomFloor }
          : {})}
        {...(priorityFitReference
          ? { priorityFitReference }
          : {})}
        onCameraGestureStart={() => {
          cancelVisibleFrameRefit();
          appliedVisibleFrameRevision.current = visibleFrame?.revision ?? 0;
          if (props.focus) consumedFocus.current = props.focus.key;
          stopFlight();
          stopProjectionFlight();
          autoCamera.current = undefined;
          projectionCameraGesture.current += 1;
        }} />
      <CanvasMiniMap
        {...(visibleFrame ? { visibleFrame } : {})}
      />
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.15} color="var(--graph-dot)" />
      </ReactFlow>
    </CanvasProjectionMotionContext.Provider>
  );
}

export function CanvasStage(props: CanvasStageProps) {
  return (
    <div className="graph-canvas" aria-label={props.ariaLabel}>
      <ReactFlowProvider>
        <Stage {...props} />
      </ReactFlowProvider>
    </div>
  );
}
