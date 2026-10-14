import type { VisualDiffRegion } from "./review-model";

/** A rectangle in percent of the image width and height (0–100). */
export type PercentRect = { x: number; y: number; width: number; height: number };

/** One reviewable change: CI regions that touch or nearly touch, merged into one area. */
export type VisualChange = PercentRect & {
  /** This change's share of all differing pixels, in percent. */
  share: number;
  regionCount: number;
};

/** Regions closer than this, in percent of the image height, read as one change. */
const VERTICAL_GAP = 1.5;
/** Regions closer than this, in percent of the image width, read as one change. */
const HORIZONTAL_GAP = 3;

function near(a: PercentRect, b: PercentRect): boolean {
  return a.x <= b.x + b.width + HORIZONTAL_GAP
    && b.x <= a.x + a.width + HORIZONTAL_GAP
    && a.y <= b.y + b.height + VERTICAL_GAP
    && b.y <= a.y + a.height + VERTICAL_GAP;
}

function union(a: VisualChange, b: VisualChange): VisualChange {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    share: a.share + b.share,
    regionCount: a.regionCount + b.regionCount,
  };
}

/**
 * CI reports many small regions for one visible change (a card that grew reports its text rows,
 * its badge and its border). Merge regions that touch or nearly touch until none do, then order
 * the changes top to bottom, the way a reader scans the screen.
 *
 * CI regions can overlap, so their shares can add up to more than 100%. The changes' shares are
 * scaled to add up to 100%, so "60% of the difference" means what it says.
 */
export function groupVisualRegions(regions: readonly VisualDiffRegion[]): VisualChange[] {
  let changes: VisualChange[] = regions.map((region) => ({ ...region, regionCount: 1 }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < changes.length; i += 1) {
      for (let j = i + 1; j < changes.length; j += 1) {
        if (!near(changes[i]!, changes[j]!)) continue;
        const next = changes.filter((_, index) => index !== i && index !== j);
        next.push(union(changes[i]!, changes[j]!));
        changes = next;
        merged = true;
        break outer;
      }
    }
  }
  const total = changes.reduce((sum, change) => sum + change.share, 0);
  if (total > 0) changes = changes.map((change) => ({ ...change, share: (change.share * 100) / total }));
  return changes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Room around a change's outline, in percent of the image width and height, so it frames text. */
const OUTLINE_PAD_X = 1.5;
const OUTLINE_PAD_Y = 0.7;

/** The outline drawn around a change: the CI area plus a little room, inside the image. */
export function outlineRect(change: PercentRect): PercentRect {
  const x = Math.max(0, change.x - OUTLINE_PAD_X);
  const y = Math.max(0, change.y - OUTLINE_PAD_Y);
  return {
    x,
    y,
    width: Math.min(100, change.x + change.width + OUTLINE_PAD_X) - x,
    height: Math.min(100, change.y + change.height + OUTLINE_PAD_Y) - y,
  };
}

/** Widest crop, as width over height in pixels, before the crop grows taller to stay readable. */
const MAX_CROP_ASPECT = 4;
/** Context around a change, in percent of the image width. */
const CROP_MARGIN = 3;
/**
 * Narrowest crop, in percent of the image width. Captures are often 1x, so a small change shown
 * at the list's full width would be enlarged into a blur; a wider crop also keeps its context.
 */
const MIN_CROP_WIDTH = 60;

/**
 * The area to show for a change in a Before and After crop: the change plus some context,
 * at least a quarter as tall as it is wide, and inside the image. `imageAspect` is the image
 * width over its height.
 */
export function cropFor(change: PercentRect, imageAspect: number): PercentRect {
  const marginY = CROP_MARGIN * imageAspect;
  const width = Math.min(100, Math.max(change.width + CROP_MARGIN * 2, MIN_CROP_WIDTH));
  // Height in percent that keeps width:height (in pixels) at or under MAX_CROP_ASPECT.
  const minHeight = (width * imageAspect) / MAX_CROP_ASPECT;
  const height = Math.min(100, Math.max(change.height + marginY * 2, minHeight));
  // Centre the crop on the change, then shift it inside the image rather than cutting it.
  const x = Math.min(Math.max(0, change.x + change.width / 2 - width / 2), 100 - width);
  const y = Math.min(Math.max(0, change.y + change.height / 2 - height / 2), 100 - height);
  return { x, y, width, height };
}

/**
 * Styles that place a full screenshot inside a box so only `crop` shows. The box needs the
 * crop's aspect ratio, which is `(crop.width / crop.height) * imageAspect`.
 */
export function cropImageStyle(crop: PercentRect): Record<"width" | "height" | "left" | "top", string> {
  return {
    width: `${(100 * 100) / crop.width}%`,
    height: `${(100 * 100) / crop.height}%`,
    left: `${(-100 * crop.x) / crop.width}%`,
    top: `${(-100 * crop.y) / crop.height}%`,
  };
}

export function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${Number(value.toFixed(1))}%`;
}
