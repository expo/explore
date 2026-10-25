import type { CanvasView } from "./navigation";

/** Matches the left-to-right order of the persistent canvas toolbar. */
export const CANVAS_VIEW_ORDER = ["map", "screens", "compare", "flows"] as const satisfies readonly CanvasView[];

export type CanvasViewTransitionDirection = "forward" | "backward";

/**
 * Peer views still have a visible order in the toolbar. Moving right advances the canvas;
 * moving left reverses it, so the same pair never contradicts itself on the way back.
 */
export function canvasViewTransitionDirection(
  from: CanvasView,
  to: CanvasView,
): CanvasViewTransitionDirection | undefined {
  const fromIndex = CANVAS_VIEW_ORDER.indexOf(from);
  const toIndex = CANVAS_VIEW_ORDER.indexOf(to);
  if (fromIndex === toIndex) return undefined;
  return toIndex > fromIndex ? "forward" : "backward";
}
