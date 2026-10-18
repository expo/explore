import { useEffect, useRef } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { publishZoom, registerZoomApi, runCanvasZoomCommand } from "../../utils/canvas-zoom";
import { isTyping, matchesShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { useCanvasVisibleFrame } from "./visible-frame-provider";
import { createKeyHold, glideWhileHeld, type KeyHold } from "../../utils/key-hold";
import {
  canvasBoundsViewport,
  canvasPriorityProjectionBounds,
  canvasRecenterViewport,
  canvasSelectionNodeIds,
  canvasSelectionViewport,
  canvasWidthViewport,
  normalizeCanvasVisibleFrame,
  type CanvasPriorityFitReference,
} from "./camera";

const DURATION = 160;
/** React Flow's zoomIn/zoomOut step, which a tap of + or − takes. */
const KEY_ZOOM_STEP = 1.2;
const PIXEL_WHEEL_ZOOM_RATE = 0.002;
const LINE_WHEEL_ZOOM_RATE = 0.05;
const PAGE_WHEEL_ZOOM_RATE = 1;

type PendingWheelZoom = {
  exponent: number;
  clientX: number;
  clientY: number;
};

function canvasOwnsKeyboardEvent(event: KeyboardEvent, canvas: HTMLElement): boolean {
  const target = event.target;
  const focusOwned = (
    target instanceof HTMLElement
    && target !== document.body
    && target !== document.documentElement
    && canvas.contains(target)
  );
  return focusOwned || canvas.matches(":hover");
}

function plainZoomDirection(event: KeyboardEvent): 1 | -1 | undefined {
  if (event.key === "+" || event.key === "=") return 1;
  if (event.key === "-" || event.key === "_") return -1;
  return undefined;
}

function modifiedZoomCommand(event: KeyboardEvent): "in" | "out" | "100" | undefined {
  if (event.code === "Equal" || event.code === "NumpadAdd") return "in";
  if (event.code === "Minus" || event.code === "NumpadSubtract") return "out";
  if (event.code === "Digit0" || event.code === "Numpad0") return "100";
  return undefined;
}

/**
 * Renders nothing: it sits inside the canvas' provider and hands the camera to the zoom
 * control in the right panel, which cannot reach React Flow's context from where it lives.
 */
export function ZoomBridge(props: {
  cameraReady?: boolean;
  fit?: "bounds" | "width";
  fitLeftInset?: number;
  fitTopInset?: number;
  onCameraGestureStart?: () => void;
  priorityNodeIds?: readonly string[];
  readableZoomFloor?: number;
  priorityFitReference?: CanvasPriorityFitReference;
  fitPadding?: number;
  fitMaxZoom?: number;
}) {
  const { visibleFrame } = useCanvasVisibleFrame();
  // Outlives the effect below, which re-runs as the camera moves: a held key must not end just
  // because its own zoom step re-registered the listeners.
  const holdRef = useRef<KeyHold>(undefined);
  holdRef.current ??= createKeyHold();
  const hold = holdRef.current;
  useEffect(() => () => hold.end(), [hold]);
  const {
    zoomIn,
    zoomOut,
    zoomTo,
    getNodes,
    getNodesBounds,
    getViewport,
    setViewport,
  } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const canvas = useStore((state) => state.domNode);
  const selectionKey = useStore((state) => state.nodes
    .flatMap((node) => (node.selected ? [node.id] : []))
    .join("\u0000"));
  const wheelFrame = useRef<number | undefined>(undefined);
  const pendingWheel = useRef<PendingWheelZoom | undefined>(undefined);
  const onCameraGestureStart = useRef(props.onCameraGestureStart);
  onCameraGestureStart.current = props.onCameraGestureStart;

  // A newly mounted canvas starts at a provisional min-zoom and applies its opening camera on the
  // next frame. Publishing those throwaway values makes the percentage rapidly count through
  // several numbers during a peer-view transition. Keep the previous document's readout until
  // the incoming camera has actually settled, then publish its final value once.
  useEffect(() => {
    if (props.cameraReady === false) return;
    publishZoom(Math.round(zoom * 100) / 100);
  }, [props.cameraReady, zoom]);

  useEffect(() => {
    // Re-registering after selection changes publishes the new capability to the zoom menu.
    // Reading through getNodes keeps the commands themselves on the latest canvas snapshot.
    void selectionKey;
    const fitNodes = (
      nodes: ReturnType<typeof getNodes>,
      padding: number,
      fitMaxZoom: number,
      duration: number,
      usePriorityFallback = false,
    ) => {
      if (nodes.length === 0) return;
      const fullBounds = getNodesBounds(nodes);
      const frame = normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight);
      const bounds = props.fit !== "width" && usePriorityFallback
        ? canvasPriorityProjectionBounds(nodes, fullBounds, {
            canvasWidth,
            canvasHeight,
            padding,
            ...(frame ? { visibleFrame: frame } : {}),
            ...(props.priorityNodeIds ? { priorityNodeIds: props.priorityNodeIds } : {}),
            ...(props.readableZoomFloor !== undefined
              ? { readableZoomFloor: props.readableZoomFloor }
              : {}),
            ...(props.priorityFitReference ? {
              priorityFitReference: props.priorityFitReference,
            } : {}),
          })
        : fullBounds;
      // Overview Fit follows the canvas' inventory mode; a selected node always uses a centred
      // bounds fit so a tall card cannot be cropped by the Screens width-only strategy.
      const target = (usePriorityFallback && props.fit === "width"
        ? canvasWidthViewport
        : canvasBoundsViewport)(bounds, {
        canvasWidth,
        canvasHeight,
        minZoom,
        maxZoom: Math.min(maxZoom, fitMaxZoom),
        padding,
        ...(usePriorityFallback && props.fitLeftInset !== undefined
          ? { leftInset: props.fitLeftInset }
          : {}),
        ...(usePriorityFallback && props.fitTopInset !== undefined
          ? { topInset: props.fitTopInset }
          : {}),
        ...(visibleFrame ? { visibleFrame } : {}),
      });
      if (!target) return;
      onCameraGestureStart.current?.();
      void setViewport(target, { duration });
    };
    const api = {
      zoomIn: () => {
        onCameraGestureStart.current?.();
        void zoomIn({ duration: DURATION });
      },
      zoomOut: () => {
        onCameraGestureStart.current?.();
        void zoomOut({ duration: DURATION });
      },
      zoomTo: (level: number) => {
        onCameraGestureStart.current?.();
        void zoomTo(level, { duration: DURATION });
      },
      zoomToFit: (requestedMaxZoom = props.fitMaxZoom ?? maxZoom, duration = DURATION) => {
        fitNodes(
          getNodes().filter((node) => !node.hidden),
          props.fitPadding ?? 0.12,
          Math.min(requestedMaxZoom, props.fitMaxZoom ?? maxZoom),
          duration,
          true,
        );
      },
      recenter: () => {
        const nodes = getNodes().filter((node) => !node.hidden);
        if (nodes.length === 0) return;
        const bounds = getNodesBounds(nodes);
        const viewport = getViewport();
        const target = canvasRecenterViewport(bounds, viewport.zoom, {
          canvasWidth,
          canvasHeight,
          ...(visibleFrame ? { visibleFrame } : {}),
        });
        if (!target) return;
        onCameraGestureStart.current?.();
        void setViewport(target, { duration: DURATION });
      },
      zoomToSelection: () => {
        const nodes = getNodes();
        const selectedNodeIds = canvasSelectionNodeIds(nodes);
        const target = canvasSelectionViewport(
          nodes,
          selectedNodeIds,
          {
            canvasWidth,
            canvasHeight,
            minZoom,
            maxZoom,
            ...(visibleFrame ? { visibleFrame } : {}),
          },
        );
        if (!target) return;
        onCameraGestureStart.current?.();
        void setViewport(target, { duration: DURATION });
      },
      hasSelection: () => canvasSelectionNodeIds(getNodes()).length > 0,
    };
    registerZoomApi(api);

    // A tap of + or − takes one eased step. Held, the OS key repeat is ignored (each repeat
    // restarting the easing made holding slower than tapping); once the tap's step has landed the
    // camera glides instead, frame by frame about the pane's centre, as zoomIn does, until the key
    // is released, the hold is interrupted, or the zoom reaches its limit.
    const zoomStep = (direction: 1 | -1): boolean => {
      const viewport = getViewport();
      const next = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * KEY_ZOOM_STEP ** direction));
      if (next === viewport.zoom) return false;
      if (direction === 1) void zoomIn({ duration: DURATION });
      else void zoomOut({ duration: DURATION });
      return true;
    };
    const zoomGlide = (direction: 1 | -1) => (steps: number): boolean => {
      const viewport = getViewport();
      const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * KEY_ZOOM_STEP ** (direction * steps)));
      if (zoom === viewport.zoom) return false;
      const scale = zoom / viewport.zoom;
      const centerX = canvasWidth / 2;
      const centerY = canvasHeight / 2;
      void setViewport({ zoom, x: centerX - (centerX - viewport.x) * scale, y: centerY - (centerY - viewport.y) * scale });
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      hold.interrupt(event);
      // Typing comes first: a held key's repeats belong to a field that took focus mid-hold.
      if (isTyping(event.target)) return;
      if (event.repeat && hold.holding(event.code)) {
        event.preventDefault();
        return;
      }

      // Browser zoom and canvas zoom use the same familiar chord. The pointer/focus boundary
      // decides who owns it: canvas-owned events reset its camera; a focused panel or field keeps
      // the browser's native accessibility zoom untouched.
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const command = modifiedZoomCommand(event);
        if (!command || !canvas || !canvasOwnsKeyboardEvent(event, canvas)) return;
        runCanvasZoomCommand(command);
        event.preventDefault();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.shiftKey) {
        if (matchesShortcut(event, SHORTCUTS.camera.zoom100)) runCanvasZoomCommand("100");
        // The key does what the Fit button beside the zoom does: the selection first, then the canvas.
        else if (matchesShortcut(event, SHORTCUTS.camera.fit)) runCanvasZoomCommand(api.hasSelection() ? "selection" : "fit");
        else if (matchesShortcut(event, SHORTCUTS.camera.center)) runCanvasZoomCommand("recenter");
        else return;
        event.preventDefault();
        return;
      }
      const direction = plainZoomDirection(event);
      if (!direction) return;
      event.preventDefault();
      onCameraGestureStart.current?.();
      if (!zoomStep(direction)) return;
      // The hold only tracks the key (released, interrupted, a field or dialog taking over); the
      // glide reads it every frame and stops with it.
      hold.begin(event.code, () => true);
      glideWhileHeld(hold, event.code, DURATION, zoomGlide(direction));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (hold.holding(event.code)) hold.end();
    };

    const onModifierWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTyping(event.target)) return;
      // React Flow's non-passive wheel handler performs the pinch zoom. Capturing the browser
      // boundary here guarantees the same gesture never escapes into page zoom first.
      event.preventDefault();
      if (event.metaKey && !event.ctrlKey && event.deltaY !== 0) {
        // React Flow recognises trackpad pinch as Ctrl+wheel. Command-wheel uses Meta instead, so
        // keep it inside the same boundary without also letting the underlying pan handler run.
        // Wheel events arrive at very different rates on a mouse, trackpad and display refresh
        // cadence. Accumulate their real delta for one paint instead of restarting a fixed 160ms
        // 1.2x transition for every event; restarting that easing made dense input dramatically
        // slower than sparse input.
        event.stopPropagation();
        const rate = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_WHEEL_ZOOM_RATE
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? PAGE_WHEEL_ZOOM_RATE
            : PIXEL_WHEEL_ZOOM_RATE;
        const current = pendingWheel.current;
        pendingWheel.current = {
          exponent: (current?.exponent ?? 0) - event.deltaY * rate,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        if (wheelFrame.current !== undefined) return;
        onCameraGestureStart.current?.();
        wheelFrame.current = requestAnimationFrame(() => {
          wheelFrame.current = undefined;
          const pending = pendingWheel.current;
          pendingWheel.current = undefined;
          if (!pending || !canvas) return;
          const viewport = getViewport();
          const nextZoom = Math.min(
            maxZoom,
            Math.max(minZoom, viewport.zoom * (2 ** pending.exponent)),
          );
          if (nextZoom === viewport.zoom) return;
          const bounds = canvas.getBoundingClientRect();
          const pointerInside = pending.clientX >= bounds.left
            && pending.clientX <= bounds.right
            && pending.clientY >= bounds.top
            && pending.clientY <= bounds.bottom;
          const frame = normalizeCanvasVisibleFrame(visibleFrame, canvasWidth, canvasHeight);
          const screenX = pointerInside
            ? pending.clientX - bounds.left
            : (frame?.x ?? 0) + (frame?.width ?? bounds.width) / 2;
          const screenY = pointerInside
            ? pending.clientY - bounds.top
            : (frame?.y ?? 0) + (frame?.height ?? bounds.height) / 2;
          const worldX = (screenX - viewport.x) / viewport.zoom;
          const worldY = (screenY - viewport.y) / viewport.zoom;
          void setViewport({
            zoom: nextZoom,
            x: screenX - worldX * nextZoom,
            y: screenY - worldY * nextZoom,
          });
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hold.end);
    canvas?.addEventListener("wheel", onModifierWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hold.end);
      canvas?.removeEventListener("wheel", onModifierWheel, { capture: true });
      if (wheelFrame.current !== undefined) cancelAnimationFrame(wheelFrame.current);
      wheelFrame.current = undefined;
      pendingWheel.current = undefined;
      registerZoomApi(undefined);
    };
  }, [
    canvas,
    canvasHeight,
    canvasWidth,
    getNodes,
    getNodesBounds,
    getViewport,
    hold,
    maxZoom,
    minZoom,
    props.fitPadding,
    props.fitMaxZoom,
    props.fit,
    props.fitLeftInset,
    props.fitTopInset,
    props.priorityNodeIds,
    props.priorityFitReference,
    props.readableZoomFloor,
    selectionKey,
    setViewport,
    visibleFrame,
    zoomIn,
    zoomOut,
    zoomTo,
  ]);

  return null;
}
