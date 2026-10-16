import type { RegionMove, VisualDiffRegion } from "./review-model";

/** A rectangle in percent of the image width and height (0–100). */
export type PercentRect = { x: number; y: number; width: number; height: number };

/** One reviewable change: CI regions that touch or nearly touch, merged into one area. */
export type VisualChange = PercentRect & {
  /** This change's share of all differing pixels, in percent. */
  share: number;
  regionCount: number;
  /** Set when every region in it only moved, and by about the same amount: their average, placing the outline. */
  move?: RegionMove;
  /** The least and most its regions moved, in the screenshot's units, so a label can say "↓1.5–2pt". */
  moveRange?: { x: [number, number]; y: [number, number] };
};

/** Moves this close, in the screenshot's units, are one amount: measuring a move from pixels is good to about this. */
const SAME_MOVE = 0.5;
/** Areas whose moves together span at most this, the same way, moved together (rows that drift 1–2pt as a list). */
const MAX_MOVE_SPREAD = 1;

function sameMove(a: VisualChange, b: VisualChange): boolean {
  if (!a.move || !b.move) return !a.move && !b.move;
  const first = rangeOf(a), second = rangeOf(b);
  const together = (axis: "x" | "y") => {
    const low = Math.min(first[axis][0], second[axis][0]), high = Math.max(first[axis][1], second[axis][1]);
    // One direction only: content that moved up and content that moved down did not move together.
    return high - low <= MAX_MOVE_SPREAD && (low >= -0.25 || high <= 0.25);
  };
  return together("x") && together("y");
}

/** Two moves as one, weighted by each change's share of the difference. */
function mergedMove(a: VisualChange, b: VisualChange): RegionMove | undefined {
  if (!a.move || !b.move) return undefined;
  const total = a.share + b.share || 1;
  const mix = (first: number, second: number) => (first * a.share + second * b.share) / total;
  return { x: mix(a.move.x, b.move.x), y: mix(a.move.y, b.move.y), unit: a.move.unit,
    amount: { x: mix(a.move.amount.x, b.move.amount.x), y: mix(a.move.amount.y, b.move.amount.y) } };
}

/** Regions closer than this, in percent of the image height, read as one change. */
const VERTICAL_GAP = 1.5;
/** Regions closer than this, in percent of the image width, read as one change. */
const HORIZONTAL_GAP = 3;

/**
 * Areas that moved by the same amount moved together (a sheet, a card and the rows under it), so they read as one
 * across a wider gap: the content between them moved too, it just has no edges for CI to see.
 */
const MOVED_VERTICAL_GAP = 8;
const MOVED_HORIZONTAL_GAP = 10;

function near(a: VisualChange, b: VisualChange): boolean {
  const moved = Boolean(a.move && b.move);
  const horizontal = moved ? MOVED_HORIZONTAL_GAP : HORIZONTAL_GAP;
  const vertical = moved ? MOVED_VERTICAL_GAP : VERTICAL_GAP;
  return a.x <= b.x + b.width + horizontal
    && b.x <= a.x + a.width + horizontal
    && a.y <= b.y + b.height + vertical
    && b.y <= a.y + a.height + vertical;
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
    ...(mergedMove(a, b) ? { move: mergedMove(a, b)!, moveRange: {
      x: [Math.min(rangeOf(a).x[0], rangeOf(b).x[0]), Math.max(rangeOf(a).x[1], rangeOf(b).x[1])],
      y: [Math.min(rangeOf(a).y[0], rangeOf(b).y[0]), Math.max(rangeOf(a).y[1], rangeOf(b).y[1])],
    } } : {}),
  };
}

/** A change's move range: its own, or its single move's amount. */
function rangeOf(change: VisualChange): { x: [number, number]; y: [number, number] } {
  const amount = change.move?.amount ?? { x: 0, y: 0 };
  return change.moveRange ?? { x: [amount.x, amount.x], y: [amount.y, amount.y] };
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
        // A moved area and a changed one stay apart, as do areas that moved by different amounts.
        if (!near(changes[i]!, changes[j]!) || !sameMove(changes[i]!, changes[j]!)) continue;
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

/**
 * "1.5" for 1.6, "4" for 4.17: a move to the nearest half. Measuring a move from pixels is good to about half a
 * point, and half a point is all a reviewer needs to tell a nudge from a jump.
 */
function amount(value: number): string {
  return (Math.round(Math.abs(value) * 2) / 2).toString();
}

/**
 * "4" when a merged area's regions moved within half a point of each other (that much is measurement noise), the
 * range "1–2" when they moved by more.
 */
function span(low: number, high: number): string {
  const [least, most] = [Math.min(Math.abs(low), Math.abs(high)), Math.max(Math.abs(low), Math.abs(high))];
  if (most - least <= SAME_MOVE) return amount((least + most) / 2);
  const [a, b] = [amount(least), amount(most)];
  return a === b ? a : `${a}–${b}`;
}

/** A change's move as its outline labels it: "↑4pt", "↓1.5–2pt", "→2 ↓1pt". Under a quarter in either direction is left out. */
export function formatMove(change: Pick<VisualChange, "move" | "moveRange">): string {
  const move = change.move;
  if (!move) return "";
  const range = rangeOf(change as VisualChange);
  const parts = [
    ...(Math.abs(move.amount.x) >= 0.25 ? [`${move.amount.x < 0 ? "←" : "→"}${span(range.x[0], range.x[1])}`] : []),
    ...(Math.abs(move.amount.y) >= 0.25 ? [`${move.amount.y < 0 ? "↑" : "↓"}${span(range.y[0], range.y[1])}`] : []),
  ];
  return `${parts.join(" ")}${move.unit}`;
}

/**
 * What changed on a screen whose every changed area only moved: a line per direction, "2 areas moved up 4pt",
 * "3 areas moved down 1–2pt". Undefined when any area's content changed.
 */
export function layoutShiftSummary(changes: readonly VisualChange[]): string[] | undefined {
  if (changes.length === 0 || changes.some((change) => !change.move)) return undefined;
  const groups = new Map<string, number[]>();
  for (const change of changes) {
    const { x, y } = change.move!.amount;
    const vertical = Math.abs(y) >= Math.abs(x);
    const direction = vertical ? (y < 0 ? "up" : "down") : (x < 0 ? "left" : "right");
    const range = rangeOf(change);
    groups.set(direction, [...(groups.get(direction) ?? []), ...(vertical ? range.y : range.x).map(Math.abs)]);
  }
  const unit = changes[0]!.move!.unit;
  const counts = new Map<string, number>();
  for (const change of changes) {
    const { x, y } = change.move!.amount;
    const direction = Math.abs(y) >= Math.abs(x) ? (y < 0 ? "up" : "down") : (x < 0 ? "left" : "right");
    counts.set(direction, (counts.get(direction) ?? 0) + 1);
  }
  return [...groups].map(([direction, amounts]) => {
    const count = counts.get(direction) ?? 0;
    return `${count === 1 ? "1 area" : `${count} areas`} moved ${direction} ${span(Math.min(...amounts), Math.max(...amounts))}${unit}.`;
  });
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
