// The zoom control lives in the right panel, outside the canvas' React Flow provider, so the
// two talk through this module: a bridge inside the provider publishes the live zoom and
// registers the camera actions, and the control reads both from here (via hooks/use-canvas-zoom).

/** React Flow expresses 100% as 1, so 256 permits a 25,600% inspection zoom. */
export const CANVAS_MAX_ZOOM = 256;

export type CanvasZoomApi = {
  zoomIn: () => void;
  zoomOut: () => void;
  zoomTo: (level: number) => void;
  zoomToFit: (maxZoom?: number, duration?: number) => void;
  /** Centers all visible canvas content without changing the current zoom level. */
  recenter: () => void;
  zoomToSelection: () => void;
  /** False when nothing is selected on the canvas, so the menu can disable that row. */
  hasSelection: () => boolean;
};

export type CanvasZoomCommand = "in" | "out" | "100" | "fit" | "recenter" | "selection";

export type CanvasZoomState = { zoom: number; api?: CanvasZoomApi };

let state: CanvasZoomState = { zoom: 1 };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeCanvasZoom(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCanvasZoomState(): CanvasZoomState {
  return state;
}

export function publishZoom(zoom: number) {
  if (state.zoom === zoom) return;
  state = { ...state, zoom };
  emit();
}

export function registerZoomApi(api: CanvasZoomApi | undefined) {
  state = api ? { ...state, api } : { zoom: state.zoom };
  emit();
}

/** Zoom commands only move the camera; Map content scope is an independent explicit choice. */
export function runCanvasZoomCommand(command: CanvasZoomCommand): void {
  const api = state.api;
  if (!api) return;
  if (command === "in") api.zoomIn();
  else if (command === "out") api.zoomOut();
  else if (command === "100") api.zoomTo(1);
  else if (command === "fit") api.zoomToFit();
  else if (command === "recenter") api.recenter();
  else api.zoomToSelection();
}
