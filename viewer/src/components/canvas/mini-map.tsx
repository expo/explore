import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
} from "react";
import {
  MiniMap,
  useReactFlow,
  useStore,
  type Node,
  type ReactFlowState,
} from "@xyflow/react";
import { normalizeCanvasVisibleFrame, type CanvasVisibleFrame } from "./camera";
import "./mini-map.css";

const MINIMAP_WIDTH = 168;
const MINIMAP_HEIGHT = 112;
const NARROW_MINIMAP_WIDTH = 128;
const NARROW_MINIMAP_HEIGHT = 84;
const MINIMAP_GAP = 12;
// The minimap and bottom toolbar sit on one canvas baseline, matching the other floating chrome.
const CANVAS_TOOLBAR_BOTTOM = 14;
// --icon-btn-lg (36px) plus 6px padding and a 1px border on each side.
const CANVAS_TOOLBAR_HEIGHT = 50;
const CANVAS_TOOLBAR_WIDTH = 190;
const MINIMAP_OFFSET_SCALE = 5;
const MINIMAP_MINIMUM_FRAME_WIDTH = 220;
const NARROW_MINIMAP_QUERY = "(max-width: 899px)";

function subscribeNarrowMinimap(onStoreChange: () => void) {
  const query = window.matchMedia(NARROW_MINIMAP_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function narrowMinimapSnapshot() {
  return window.matchMedia(NARROW_MINIMAP_QUERY).matches;
}

type CanvasMiniMapProps = {
  visibleFrame?: CanvasVisibleFrame;
  ariaLabel?: string;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MiniMapStoreGeometry = {
  canvasWidth: number;
  canvasHeight: number;
  translateX: number;
  translateY: number;
  zoom: number;
  hasVisibleNodes: boolean;
  nodesMinX: number;
  nodesMinY: number;
  nodesMaxX: number;
  nodesMaxY: number;
};

type MiniMapMaskGeometry = {
  viewBox: Rect;
  outer: Rect;
  visibleWorld: Rect;
  viewScale: number;
};

const EMPTY_NODE_BOUNDS = {
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
} as const;

function selectMiniMapGeometry(state: ReactFlowState): MiniMapStoreGeometry {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasVisibleNodes = false;

  state.nodeLookup.forEach((node) => {
    if (node.hidden) return;
    const width = node.measured.width ?? node.width ?? node.initialWidth ?? 0;
    const height = node.measured.height ?? node.height ?? node.initialHeight ?? 0;
    const { x, y } = node.internals.positionAbsolute;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
    hasVisibleNodes = true;
  });

  const nodeBounds = hasVisibleNodes
    ? { minX, minY, maxX, maxY }
    : EMPTY_NODE_BOUNDS;

  return {
    canvasWidth: state.width,
    canvasHeight: state.height,
    translateX: state.transform[0],
    translateY: state.transform[1],
    zoom: state.transform[2],
    hasVisibleNodes,
    nodesMinX: nodeBounds.minX,
    nodesMinY: nodeBounds.minY,
    nodesMaxX: nodeBounds.maxX,
    nodesMaxY: nodeBounds.maxY,
  };
}

function sameMiniMapGeometry(a: MiniMapStoreGeometry, b: MiniMapStoreGeometry) {
  return a.canvasWidth === b.canvasWidth
    && a.canvasHeight === b.canvasHeight
    && a.translateX === b.translateX
    && a.translateY === b.translateY
    && a.zoom === b.zoom
    && a.hasVisibleNodes === b.hasVisibleNodes
    && a.nodesMinX === b.nodesMinX
    && a.nodesMinY === b.nodesMinY
    && a.nodesMaxX === b.nodesMaxX
    && a.nodesMaxY === b.nodesMaxY;
}

function unionRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function miniMapMaskGeometry(
  geometry: MiniMapStoreGeometry,
  visibleFrame: CanvasVisibleFrame | undefined,
  minimapWidth: number,
  minimapHeight: number,
): MiniMapMaskGeometry | undefined {
  if (
    geometry.canvasWidth <= 0
    || geometry.canvasHeight <= 0
    || geometry.zoom <= 0
  ) return undefined;

  const frame = normalizeCanvasVisibleFrame(
    visibleFrame,
    geometry.canvasWidth,
    geometry.canvasHeight,
  );
  if (!frame) return undefined;

  const fullViewport: Rect = {
    x: -geometry.translateX / geometry.zoom,
    y: -geometry.translateY / geometry.zoom,
    width: geometry.canvasWidth / geometry.zoom,
    height: geometry.canvasHeight / geometry.zoom,
  };
  const nodeBounds: Rect = {
    x: geometry.nodesMinX,
    y: geometry.nodesMinY,
    width: geometry.nodesMaxX - geometry.nodesMinX,
    height: geometry.nodesMaxY - geometry.nodesMinY,
  };
  const bounds = geometry.hasVisibleNodes
    ? unionRects(fullViewport, nodeBounds)
    : fullViewport;

  // Mirror React Flow's MiniMap viewBox calculation so this mask remains pixel-aligned with the
  // built-in nodes while replacing only its full-pane viewport hole.
  const scaledWidth = bounds.width / minimapWidth;
  const scaledHeight = bounds.height / minimapHeight;
  const viewScale = Math.max(scaledWidth, scaledHeight, Number.EPSILON);
  const viewWidth = viewScale * minimapWidth;
  const viewHeight = viewScale * minimapHeight;
  const offset = MINIMAP_OFFSET_SCALE * viewScale;
  const viewBox: Rect = {
    x: bounds.x - (viewWidth - bounds.width) / 2 - offset,
    y: bounds.y - (viewHeight - bounds.height) / 2 - offset,
    width: viewWidth + offset * 2,
    height: viewHeight + offset * 2,
  };

  return {
    viewBox,
    outer: {
      x: viewBox.x - offset,
      y: viewBox.y - offset,
      width: viewBox.width + offset * 2,
      height: viewBox.height + offset * 2,
    },
    visibleWorld: {
      x: (frame.x - geometry.translateX) / geometry.zoom,
      y: (frame.y - geometry.translateY) / geometry.zoom,
      width: frame.width / geometry.zoom,
      height: frame.height / geometry.zoom,
    },
    viewScale,
  };
}

function rectPath(rect: Rect) {
  return `M${rect.x},${rect.y}h${rect.width}v${rect.height}h${-rect.width}z`;
}

function parentNode(node: Node) {
  return node.type === "canvasGroup" || node.type === "group";
}

function miniMapNodeClassName(node: Node) {
  return parentNode(node)
    ? "canvas-minimap-node canvas-minimap-node--group"
    : "canvas-minimap-node canvas-minimap-node--item";
}

function miniMapNodeColor(node: Node) {
  if (parentNode(node)) return "var(--canvas-minimap-group-fill)";
  return node.selected ? "var(--accent)" : "var(--canvas-minimap-node-fill)";
}

function miniMapNodeStrokeColor(node: Node) {
  if (node.selected) return "var(--accent)";
  return parentNode(node)
    ? "var(--canvas-minimap-group-stroke)"
    : "var(--canvas-minimap-node-stroke)";
}

function VisibleCanvasMiniMap({
  visibleFrame,
  ariaLabel = "Canvas overview",
}: CanvasMiniMapProps) {
  const narrow = useSyncExternalStore(
    subscribeNarrowMinimap,
    narrowMinimapSnapshot,
    () => false,
  );
  const minimapWidth = narrow ? NARROW_MINIMAP_WIDTH : MINIMAP_WIDTH;
  const minimapHeight = narrow ? NARROW_MINIMAP_HEIGHT : MINIMAP_HEIGHT;
  const minimapStyle = useMemo<CSSProperties>(
    () => ({ width: minimapWidth, height: minimapHeight }),
    [minimapHeight, minimapWidth],
  );
  const { setViewport } = useReactFlow();
  const geometry = useStore(selectMiniMapGeometry, sameMiniMapGeometry);
  const mask = useMemo(
    () => miniMapMaskGeometry(
      geometry,
      visibleFrame,
      minimapWidth,
      minimapHeight,
    ),
    [
      geometry,
      minimapHeight,
      minimapWidth,
      visibleFrame?.x,
      visibleFrame?.y,
      visibleFrame?.width,
      visibleFrame?.height,
    ],
  );
  const normalizedFrame = normalizeCanvasVisibleFrame(
    visibleFrame,
    geometry.canvasWidth,
    geometry.canvasHeight,
  );
  const panToMiniMapPosition = useCallback<NonNullable<
    ComponentProps<typeof MiniMap>["onClick"]
  >>((_event, position) => {
    if (!normalizedFrame || geometry.zoom <= 0) return;
    void setViewport({
      x: normalizedFrame.x + normalizedFrame.width / 2 - position.x * geometry.zoom,
      y: normalizedFrame.y + normalizedFrame.height / 2 - position.y * geometry.zoom,
      zoom: geometry.zoom,
    });
  }, [
    geometry.zoom,
    normalizedFrame?.height,
    normalizedFrame?.width,
    normalizedFrame?.x,
    normalizedFrame?.y,
    setViewport,
  ]);
  // The toolbar is fixed at the window's centre, not the visible frame's, so the minimap shares
  // its baseline only when its own span clears the toolbar's. The canvas starts at the window's
  // left edge (the app pill floats over it), so window and canvas x share an origin.
  const frameRight = (normalizedFrame?.x ?? 0) + (normalizedFrame?.width ?? geometry.canvasWidth);
  const minimapLeft = frameRight - MINIMAP_GAP - minimapWidth;
  // Large windows scale the floating chrome (--ui-scale); the bar's measured width wins when it is
  // mounted, since Compare's pager widens it.
  const uiScale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
  const toolbarWidth = document.querySelector(".canvas-toolbar")?.getBoundingClientRect().width
    ?? CANVAS_TOOLBAR_WIDTH * uiScale;
  const toolbarRight = (document.documentElement.clientWidth + toolbarWidth) / 2;
  const bottomClearance = minimapLeft >= toolbarRight + MINIMAP_GAP
    ? CANVAS_TOOLBAR_BOTTOM * uiScale
    : (CANVAS_TOOLBAR_BOTTOM + CANVAS_TOOLBAR_HEIGHT) * uiScale + MINIMAP_GAP;
  const shellStyle = useMemo<CSSProperties>(() => ({
    right: Math.max(
      MINIMAP_GAP,
      geometry.canvasWidth
        - ((normalizedFrame?.x ?? 0) + (normalizedFrame?.width ?? geometry.canvasWidth))
        + MINIMAP_GAP,
    ),
    bottom: Math.max(
      bottomClearance,
      geometry.canvasHeight
        - ((normalizedFrame?.y ?? 0) + (normalizedFrame?.height ?? geometry.canvasHeight))
        + bottomClearance,
    ),
  }), [
    bottomClearance,
    geometry.canvasHeight,
    geometry.canvasWidth,
    normalizedFrame?.height,
    normalizedFrame?.width,
    normalizedFrame?.x,
    normalizedFrame?.y,
  ]);

  // Fixed responsive panels can leave a sliver narrower than the specified 128px minimap. Do
  // not paint over those hard occluders; the preference remains on and the minimap returns when
  // the panel closes or the frame grows.
  if (
    normalizedFrame
    && (
      normalizedFrame.width < minimapWidth + MINIMAP_GAP * 2
      || normalizedFrame.height < minimapHeight + bottomClearance + MINIMAP_GAP
    )
  ) return null;

  return (
    <div
      className="canvas-minimap-shell"
      data-testid="canvas-minimap"
      style={shellStyle}
    >
      <MiniMap
        className="canvas-minimap"
        ariaLabel={ariaLabel}
        pannable
        zoomable={false}
        onClick={panToMiniMapPosition}
        offsetScale={MINIMAP_OFFSET_SCALE}
        nodeBorderRadius={4}
        nodeStrokeWidth={1}
        nodeClassName={miniMapNodeClassName}
        nodeColor={miniMapNodeColor}
        nodeStrokeColor={miniMapNodeStrokeColor}
        bgColor="var(--canvas-minimap-background)"
        maskColor="transparent"
        maskStrokeColor="transparent"
        style={minimapStyle}
      />
      {mask ? (
        <svg
          aria-hidden="true"
          className="canvas-minimap-visible-mask"
          viewBox={`${mask.viewBox.x} ${mask.viewBox.y} ${mask.viewBox.width} ${mask.viewBox.height}`}
        >
          <path
            d={`${rectPath(mask.outer)} ${rectPath(mask.visibleWorld)}`}
            fillRule="evenodd"
          />
          <rect
            className="canvas-minimap-visible-viewport"
            x={mask.visibleWorld.x}
            y={mask.visibleWorld.y}
            width={mask.visibleWorld.width}
            height={mask.visibleWorld.height}
            strokeWidth={mask.viewScale * 1.5}
          />
        </svg>
      ) : null}
    </div>
  );
}

/** Shared React Flow minimap. Responsive frame guards keep it off hard occluders. */
export function CanvasMiniMap({ visibleFrame, ariaLabel }: CanvasMiniMapProps) {
  // Below the canvas toolbar's readability boundary the minimap dominates the remaining map.
  // Keep the preference enabled and mount it again as soon as the unobscured frame grows.
  if (visibleFrame && visibleFrame.width < MINIMAP_MINIMUM_FRAME_WIDTH) return null;
  return (
    <VisibleCanvasMiniMap
      {...(visibleFrame ? { visibleFrame } : {})}
      {...(ariaLabel ? { ariaLabel } : {})}
    />
  );
}

export type { CanvasMiniMapProps };
