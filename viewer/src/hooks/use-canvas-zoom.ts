import { useSyncExternalStore } from "react";
import {
  getCanvasZoomState,
  subscribeCanvasZoom,
  type CanvasZoomState,
} from "../utils/canvas-zoom";

/** Re-renders on every camera move, so only the small zoom control should call it. */
export function useCanvasZoom(): CanvasZoomState {
  return useSyncExternalStore(subscribeCanvasZoom, getCanvasZoomState);
}
