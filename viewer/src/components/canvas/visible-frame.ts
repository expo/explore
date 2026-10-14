export type CanvasFrameRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type CanvasHardOccluder = {
  side: "left" | "right";
  rect: CanvasFrameRect;
};

export type CanvasVisibleFrameGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** True when at least one edge moves inward, so old canvas content would become covered. */
export function canvasVisibleFrameContracts(
  previous: CanvasVisibleFrameGeometry,
  next: CanvasVisibleFrameGeometry,
  tolerance = 0.01,
): boolean {
  return next.x > previous.x + tolerance
    || next.y > previous.y + tolerance
    || next.x + next.width < previous.x + previous.width - tolerance
    || next.y + next.height < previous.y + previous.height - tolerance;
}

function finiteRect(rect: CanvasFrameRect) {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

/**
 * Returns the largest horizontal slice of `root` left after edge occluders are removed.
 *
 * Rects use viewport coordinates, while the result uses root-local pixels. Occluders that sit
 * immediately outside the root (the normal desktop flex-panel layout) do not intersect it and
 * therefore do not get charged twice. A floating panel can still be declared as a left or right
 * hard occluder even when it is inset from that edge.
 */
export function calculateCanvasVisibleFrame(
  root: CanvasFrameRect,
  occluders: readonly CanvasHardOccluder[],
): CanvasVisibleFrameGeometry | undefined {
  if (!finiteRect(root)) return undefined;

  let left = 0;
  let right = root.width;

  for (const occluder of occluders) {
    const rect = occluder.rect;
    if (!finiteRect(rect)) continue;

    const intersectionLeft = Math.max(root.left, rect.left);
    const intersectionRight = Math.min(root.right, rect.right);
    const intersectionTop = Math.max(root.top, rect.top);
    const intersectionBottom = Math.min(root.bottom, rect.bottom);
    if (
      intersectionRight <= intersectionLeft
      || intersectionBottom <= intersectionTop
    ) continue;

    if (occluder.side === "left") {
      left = Math.max(left, intersectionRight - root.left);
    } else {
      right = Math.min(right, intersectionLeft - root.left);
    }
  }

  left = Math.max(0, Math.min(root.width, left));
  right = Math.max(0, Math.min(root.width, right));
  if (right <= left) return undefined;

  return {
    x: left,
    y: 0,
    width: right - left,
    height: root.height,
  };
}
