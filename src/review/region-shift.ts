import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { DecodedFrame } from "../shared/png-evidence.js";

/** How far a region's content moved from Before to After, in screenshot pixels (right and down are positive). */
export type RegionShift = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

/**
 * The farthest a region is searched for, in screenshot pixels: layout drift, not a different screen. Drift adds up
 * down a long screen (a device pixel per text element above), so the vertical reach is the larger.
 */
const MAX_SHIFT_X = 4;
const MAX_SHIFT_Y = 20;
/** How close to the edge of the search a best fit may land and still count: the real one may lie beyond it. */
const EDGE = 1.5;
/**
 * The share of a region's difference one shift must explain for the region to have moved rather than changed.
 * A move of half a pixel or less re-rasterizes text rather than shifting it, so a pure shift explains only a
 * quarter to a half of it; content that changed (new text, a caret) explains under a quarter at that size, and
 * anything larger has to be explained mostly by the shift. Measured on euxy's SDK 58 upgrade (brentvatne/euxy#161).
 */
const MIN_EXPLAINED = 0.6;
const MIN_EXPLAINED_SUBPIXEL = 0.25;
const SUBPIXEL = 0.5;
/** A smaller shift is rendering noise, not a move. */
const MIN_SHIFT = 0.25;
/** Sixths of a pixel in the refining search: a third of a 1x pixel is one device pixel on a 3x screen. */
const STEPS_PER_PIXEL = 6;
/** Fits this close to the best are ties, which go to the smallest move (content that is the same all along one axis). */
const TIE = 1.005;
/** Another fit this close at a vertical offset two or more pixels away makes the move ambiguous (repeating content). */
const AMBIGUOUS = 1.05;
/**
 * After aligning by the move, content is the same only where every channel is within this: re-rasterized text
 * differs by at most about 125 (brentvatne/euxy#161), new content by about 200. A few pixels over it are noise; more are a change.
 */
const CHANGED_CHANNEL = 140;
const CHANGED_PIXELS = 3;

type Image = { width: number; height: number; frame: DecodedFrame; luminance: Float32Array };
type Fit = { sx: number; sy: number; error: number };

function image(frame: DecodedFrame): Image {
  const luminance = new Float32Array(frame.width * frame.height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] = 0.299 * frame.data[offset]! + 0.587 * frame.data[offset + 1]! + 0.114 * frame.data[offset + 2]!;
  }
  return { width: frame.width, height: frame.height, frame, luminance };
}

/** Bilinear sample of one plane: `channel` 0–2 of the frame, or luminance when undefined. */
function at(source: Image, x: number, y: number, channel?: number): number {
  const cx = Math.min(source.width - 1, Math.max(0, x));
  const cy = Math.min(source.height - 1, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const value = channel === undefined
    ? (px: number, py: number) => source.luminance[py * source.width + px]!
    : (px: number, py: number) => source.frame.data[(py * source.width + px) * 4 + channel]!;
  return value(x0, y0) * (1 - fx) * (1 - fy) + value(x1, y0) * fx * (1 - fy) + value(x0, y1) * (1 - fx) * fy + value(x1, y1) * fx * fy;
}

/** How badly After's region matches Before shifted by (sx, sy). */
function mismatch(base: Image, head: Image, rect: Rect, sx: number, sy: number): number {
  let error = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      error += Math.abs(at(base, x - sx, y - sy) - head.luminance[y * head.width + x]!);
    }
  }
  return error;
}

/** The best of some fits, with near-ties going to the smallest move. */
function bestOf(fits: readonly Fit[]): Fit {
  const least = Math.min(...fits.map(fit => fit.error));
  return fits.filter(fit => fit.error <= least * TIE + 1e-6)
    .sort((a, b) => Math.hypot(a.sx, a.sy) - Math.hypot(b.sx, b.sy))[0]!;
}

/** Whether, aligned by the move, some of the region still differs strongly in any channel: content that changed. */
function changedAfterMove(base: Image, head: Image, rect: Rect, sx: number, sy: number): boolean {
  let strong = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        if (Math.abs(at(base, x - sx, y - sy, channel) - head.frame.data[(y * head.width + x) * 4 + channel]!) > CHANGED_CHANNEL) {
          strong += 1;
          if (strong >= CHANGED_PIXELS) return true;
          break;
        }
      }
    }
  }
  return false;
}

/**
 * The shift that explains one region's difference, if one does: the region's content is the same in both
 * screenshots, only moved. A region whose content changed (new text, another colour) has no shift, and neither has
 * one whose content repeats so that several shifts fit.
 */
function regionShift(base: Image, head: Image, region: Rect): RegionShift | undefined {
  const x = Math.max(0, Math.floor(region.x)), y = Math.max(0, Math.floor(region.y));
  const rect = { x, y, width: Math.min(head.width - x, Math.ceil(region.width)), height: Math.min(head.height - y, Math.ceil(region.height)) };
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const unshifted = mismatch(base, head, rect, 0, 0);
  if (unshifted === 0) return undefined;
  // Whole pixels first, every pixel counting: sampling every other row aliases on thin shapes (text, hairlines).
  const whole: Fit[] = [];
  for (let sy = -MAX_SHIFT_Y; sy <= MAX_SHIFT_Y; sy += 1) {
    for (let sx = -MAX_SHIFT_X; sx <= MAX_SHIFT_X; sx += 1) whole.push({ sx, sy, error: mismatch(base, head, rect, sx, sy) });
  }
  const coarse = bestOf(whole);
  if (whole.some(fit => Math.abs(fit.sy - coarse.sy) >= 2 && fit.error <= coarse.error * AMBIGUOUS + 1e-6)) return undefined;
  // Then sixths of a pixel around it, from whole-number steps so a move up and a move down round alike.
  const fine: Fit[] = [];
  for (let iy = -STEPS_PER_PIXEL; iy <= STEPS_PER_PIXEL; iy += 1) {
    for (let ix = -STEPS_PER_PIXEL; ix <= STEPS_PER_PIXEL; ix += 1) {
      const sx = coarse.sx + ix / STEPS_PER_PIXEL, sy = coarse.sy + iy / STEPS_PER_PIXEL;
      fine.push({ sx, sy, error: ix === 0 && iy === 0 ? coarse.error : mismatch(base, head, rect, sx, sy) });
    }
  }
  const best = bestOf(fine);
  if (Math.abs(best.sx) > MAX_SHIFT_X - EDGE || Math.abs(best.sy) > MAX_SHIFT_Y - EDGE) return undefined;
  const distance = Math.hypot(best.sx, best.sy);
  const needed = distance <= SUBPIXEL + 1e-6 ? MIN_EXPLAINED_SUBPIXEL : MIN_EXPLAINED;
  if (distance < MIN_SHIFT - 1e-6 || 1 - best.error / unshifted < needed) return undefined;
  if (changedAfterMove(base, head, rect, best.sx, best.sy)) return undefined;
  const round = (value: number) => Math.round(value * 100) / 100 || 0;
  return { x: round(best.sx), y: round(best.sy) };
}

/** Each region's shift between two screenshots of the same size; undefined where a region's content changed. */
export function regionShifts(baseFrame: DecodedFrame, headFrame: DecodedFrame, regions: readonly Rect[]): Array<RegionShift | undefined> {
  if (baseFrame.width !== headFrame.width || baseFrame.height !== headFrame.height) return regions.map(() => undefined);
  const base = image(baseFrame), head = image(headFrame);
  return regions.map(region => regionShift(base, head, region));
}

/**
 * A move too large for the drift search: content that left one area and arrived in another, such as a card that
 * went from the left of a wide sheet to its centre. `rect` is where the moved content is in After, `shift` how far it
 * went, and `members` the regions it explains (indices into the regions measured).
 */
export type RegionMove = { rect: Rect; shift: RegionShift; members: number[] };

type Axis = "x" | "y";
/** How alike two regions' extents across the move must be to be one element's two ends: overlap and size. */
const PAIR_OVERLAP = 0.8;
const PAIR_SIZE = 0.25;
/** Rows (or columns) sampled for the brightness profiles that estimate a large move: every second one is plenty. */
const PROFILE_STEP = 2;
/** Another local best this close to the best makes a large move ambiguous: repeating content (a grid, a list). */
const AMBIGUOUS_LARGE = 1.05;
/** The share of the arrived region the move must explain, as for a small move. */
const MIN_EXPLAINED_LARGE = MIN_EXPLAINED;
/** After aligning by the move, at most this share of a region may still differ strongly (antialiased edges). */
const CHANGED_SHARE = 0.001;
/** How far across the move a large one may also drift, as layout below a moved element does. */
const ACROSS = 3;

const extent = (rect: Rect, axis: Axis) => axis === "x" ? { start: rect.x, size: rect.width } : { start: rect.y, size: rect.height };
const across = (axis: Axis): Axis => axis === "x" ? "y" : "x";
const shiftAlong = (axis: Axis, along: number, other = 0): RegionShift => axis === "x" ? { x: along, y: other } : { x: other, y: along };

/** Whether two regions could be one element's two ends of a move along `axis`: side by side, alike across it. */
function pairAlong(a: Rect, b: Rect, axis: Axis): boolean {
  const ea = extent(a, axis), eb = extent(b, axis), ca = extent(a, across(axis)), cb = extent(b, across(axis));
  const separate = ea.start + ea.size <= eb.start || eb.start + eb.size <= ea.start;
  const overlap = Math.min(ca.start + ca.size, cb.start + cb.size) - Math.max(ca.start, cb.start);
  const alike = Math.abs(ea.size - eb.size) <= PAIR_SIZE * Math.max(ea.size, eb.size);
  return separate && alike && overlap >= PAIR_OVERLAP * Math.min(ca.size, cb.size);
}

/** Mean luminance along `axis` of a band across it: one value per column (axis x) or row (axis y). */
function profile(source: Image, axis: Axis, bandStart: number, bandEnd: number): Float32Array {
  const length = axis === "x" ? source.width : source.height;
  const values = new Float32Array(length);
  for (let position = 0; position < length; position += 1) {
    let sum = 0, count = 0;
    for (let other = bandStart; other < bandEnd; other += PROFILE_STEP) {
      sum += axis === "x" ? source.luminance[other * source.width + position]! : source.luminance[position * source.width + other]!;
      count += 1;
    }
    values[position] = count ? sum / count : 0;
  }
  return values;
}

/** Whether, aligned by an integer move, more than a sliver of the region still differs strongly: a change, not a move. */
function changedAfterLargeMove(base: Image, head: Image, rect: Rect, sx: number, sy: number): boolean {
  const allowed = Math.max(CHANGED_PIXELS, rect.width * rect.height * CHANGED_SHARE);
  let strong = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const by = y - sy;
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const bx = x - sx;
      if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) { strong += 1; continue; }
      const h = (y * head.width + x) * 4, b = (by * base.width + bx) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        if (Math.abs(base.frame.data[b + channel]! - head.frame.data[h + channel]!) > CHANGED_CHANNEL) { strong += 1; break; }
      }
      if (strong > allowed) return true;
    }
  }
  return false;
}

/** How much of a region's difference an integer move explains: 1 is all of it, 0 none. */
function explained(base: Image, head: Image, rect: Rect, shift: RegionShift): number {
  const unshifted = mismatch(base, head, rect, 0, 0);
  return unshifted === 0 ? 0 : 1 - mismatch(base, head, rect, shift.x, shift.y) / unshifted;
}

function clip(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  return { x, y, width: Math.max(0, Math.min(width, Math.ceil(rect.x + rect.width)) - x), height: Math.max(0, Math.min(height, Math.ceil(rect.y + rect.height)) - y) };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * The large move a pair of regions shows, if one does: `left` is where content was (it differs because the content
 * left), `arrived` where it is now. The pair only names the axis and how far to look; the distance is where After's
 * brightness profile across the arrived region best matches Before's, and the pixels must agree once aligned.
 */
function pairMove(base: Image, head: Image, left: Rect, arrived: Rect, axis: Axis): RegionShift | undefined {
  const a = extent(arrived, axis), l = extent(left, axis), band = extent(arrived, across(axis)), lb = extent(left, across(axis));
  const bandStart = Math.max(band.start, lb.start), bandEnd = Math.min(band.start + band.size, lb.start + lb.size);
  const baseProfile = profile(base, axis, bandStart, bandEnd), headProfile = profile(head, axis, bandStart, bandEnd);
  const length = baseProfile.length;
  // Content moving toward the arrived region: the distance is positive when it lies after the region it left.
  const sign = a.start > l.start ? 1 : -1;
  const farthest = Math.abs(a.start + a.size - l.start) + Math.abs(l.start + l.size - a.start);
  const errors: Array<{ distance: number; error: number }> = [];
  for (let distance = (axis === "x" ? MAX_SHIFT_X : MAX_SHIFT_Y) + 1; distance <= farthest; distance += 1) {
    const move = sign * distance;
    let sum = 0, count = 0;
    for (let position = a.start; position < a.start + a.size; position += 1) {
      const from = position - move;
      if (from < 0 || from >= length) continue;
      sum += Math.abs(headProfile[position]! - baseProfile[from]!);
      count += 1;
    }
    if (count >= a.size / 2) errors.push({ distance: move, error: sum / count });
  }
  if (errors.length < 3) return undefined;
  const minima = errors.filter((fit, index) => index > 0 && index < errors.length - 1
    && fit.error <= errors[index - 1]!.error && fit.error <= errors[index + 1]!.error);
  if (!minima.length) return undefined;
  const best = minima.reduce((least, fit) => (fit.error < least.error ? fit : least));
  if (minima.some(fit => fit !== best && Math.abs(fit.distance - best.distance) > 2 && fit.error <= best.error * AMBIGUOUS_LARGE + 1e-6)) return undefined;
  // The pixels decide: across the move it may also drift a little, as content below a moved element does.
  const rect = clip(arrived, head.width, head.height);
  let chosen: RegionShift | undefined, fit = -Infinity;
  for (let other = -ACROSS; other <= ACROSS; other += 1) {
    const shift = shiftAlong(axis, best.distance, other);
    const share = explained(base, head, rect, shift);
    if (share > fit) { fit = share; chosen = shift; }
  }
  if (!chosen || fit < MIN_EXPLAINED_LARGE || changedAfterLargeMove(base, head, rect, chosen.x, chosen.y)) return undefined;
  return chosen;
}

/**
 * Moves too large for the drift search, among the regions it left unexplained: two regions alike across an axis
 * and side by side along it, one darker and one brighter, are the two ends of something that moved. A move that
 * checks out also takes in any other unexplained region it explains (fragments of the same element where its old
 * and new places overlap), and its outline is the moved content in After.
 */
export function regionMoves(baseFrame: DecodedFrame, headFrame: DecodedFrame,
  regions: ReadonlyArray<Rect & { dominantChange?: string }>, shifts: ReadonlyArray<RegionShift | undefined>): RegionMove[] {
  if (baseFrame.width !== headFrame.width || baseFrame.height !== headFrame.height) return [];
  const base = image(baseFrame), head = image(headFrame);
  const open = new Set(regions.map((_, index) => index).filter(index => !shifts[index]));
  const moves: RegionMove[] = [];
  // Largest first: the element that moved the most content is the one a reader is looking at.
  const order = [...open].sort((left, right) => regions[right]!.width * regions[right]!.height - regions[left]!.width * regions[left]!.height);
  for (const i of order) {
    for (const j of order) {
      if (i === j || !open.has(i) || !open.has(j)) continue;
      const a = regions[i]!, b = regions[j]!;
      const opposite = new Set([a.dominantChange, b.dominantChange]);
      if (!(opposite.has("brighter") && opposite.has("darker"))) continue;
      for (const axis of ["x", "y"] as const) {
        if (!pairAlong(a, b, axis)) continue;
        // Either could be where the content arrived; the pixels decide which.
        const forward = pairMove(base, head, a, b, axis);
        const shift = forward ?? pairMove(base, head, b, a, axis);
        if (!shift) continue;
        const [left, arrived] = forward ? [a, b] : [b, a];
        let rect = clip(union(arrived, { ...left, x: left.x + shift.x, y: left.y + shift.y }), head.width, head.height);
        const members = [i, j];
        open.delete(i); open.delete(j);
        // Fragments of the same element inside its new place, where the old and new overlap.
        for (const k of [...open]) {
          const fragment = clip(regions[k]!, head.width, head.height);
          const inside = fragment.x >= rect.x && fragment.y >= rect.y && fragment.x + fragment.width <= rect.x + rect.width && fragment.y + fragment.height <= rect.y + rect.height;
          if (!inside || explained(base, head, fragment, shift) < MIN_EXPLAINED_LARGE || changedAfterLargeMove(base, head, fragment, shift.x, shift.y)) continue;
          members.push(k); open.delete(k); rect = union(rect, fragment);
        }
        moves.push({ rect, shift, members });
        break;
      }
    }
  }
  return moves;
}

/** Reads both PNG screenshots and measures each region's shift. */
export async function measureRegionShifts(basePath: string, headPath: string, regions: readonly Rect[]): Promise<Array<RegionShift | undefined>> {
  const [base, head] = await readFrames(basePath, headPath);
  return regionShifts(base, head, regions);
}

/** Reads both PNG screenshots once and measures each region's shift, then the large moves the rest show. */
export async function measureRegionMoves(basePath: string, headPath: string, regions: ReadonlyArray<Rect & { dominantChange?: string }>):
  Promise<{ shifts: Array<RegionShift | undefined>; moves: RegionMove[]; width: number; height: number }> {
  const [base, head] = await readFrames(basePath, headPath);
  const shifts = regionShifts(base, head, regions);
  return { shifts, moves: regionMoves(base, head, regions, shifts), width: head.width, height: head.height };
}

async function readFrames(basePath: string, headPath: string): Promise<[DecodedFrame, DecodedFrame]> {
  const { PNG } = createRequire(import.meta.url.replace(/\?.*$/, ""))("pngjs") as
    { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame } } };
  const [base, head] = await Promise.all([readFile(basePath), readFile(headPath)]);
  return [PNG.sync.read(base, { checkCRC: false }), PNG.sync.read(head, { checkCRC: false })];
}
