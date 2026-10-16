import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { DecodedFrame } from "../shared/png-evidence.js";

/** How far a region's content moved from Before to After, in screenshot pixels (right and down are positive). */
export type RegionShift = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

/** The farthest a region is searched for, in screenshot pixels: layout drift, not a different screen. */
const MAX_SHIFT_X = 4;
const MAX_SHIFT_Y = 12;
/** How close to the edge of the search a best fit may land and still count. */
const EDGE = 1.5;
/**
 * The share of a region's difference one shift must explain for the region to have moved rather than changed.
 * A move of half a pixel or less re-rasterizes text rather than shifting it, so a pure shift explains only a
 * quarter to a half of it; content that changed (new text, a caret) explains under a quarter at that size, and
 * anything larger has to be explained mostly by the shift. Measured on euxy's SDK 58 upgrade (PR #161).
 */
const MIN_EXPLAINED = 0.6;
const MIN_EXPLAINED_SUBPIXEL = 0.25;
const SUBPIXEL = 0.5;
/** A smaller shift is rendering noise, not a move. */
const MIN_SHIFT = 0.25;
/** Sub-pixel step of the refining search: a third of a 1x pixel is one device pixel on a 3x screen. */
const STEP = 1 / 6;

type Luminance = { width: number; height: number; values: Float32Array };

function luminance(frame: DecodedFrame): Luminance {
  const values = new Float32Array(frame.width * frame.height);
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    values[index] = 0.299 * frame.data[offset]! + 0.587 * frame.data[offset + 1]! + 0.114 * frame.data[offset + 2]!;
  }
  return { width: frame.width, height: frame.height, values };
}

function at(image: Luminance, x: number, y: number): number {
  const cx = Math.min(image.width - 1, Math.max(0, x));
  const cy = Math.min(image.height - 1, Math.max(0, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const row0 = y0 * image.width, row1 = y1 * image.width;
  return image.values[row0 + x0]! * (1 - fx) * (1 - fy) + image.values[row0 + x1]! * fx * (1 - fy)
    + image.values[row1 + x0]! * (1 - fx) * fy + image.values[row1 + x1]! * fx * fy;
}

/** How badly After's region matches Before shifted by (sx, sy). */
function mismatch(base: Luminance, head: Luminance, rect: Rect, sx: number, sy: number): number {
  let error = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      error += Math.abs(at(base, x - sx, y - sy) - head.values[y * head.width + x]!);
    }
  }
  return error;
}

/**
 * The shift that explains one region's difference, if one does: the region's content is the same in both
 * screenshots, only moved. A region whose content changed (new text, another colour) has no shift.
 */
export function regionShift(base: Luminance, head: Luminance, region: Rect): RegionShift | undefined {
  const rect = {
    x: Math.max(0, Math.floor(region.x)), y: Math.max(0, Math.floor(region.y)),
    width: Math.min(head.width - Math.max(0, Math.floor(region.x)), Math.ceil(region.width)),
    height: Math.min(head.height - Math.max(0, Math.floor(region.y)), Math.ceil(region.height)),
  };
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const unshifted = mismatch(base, head, rect, 0, 0);
  if (unshifted === 0) return undefined;
  // Whole pixels first, then sixths of a pixel around the best of them. Every pixel counts: sampling every other
  // row aliases on thin horizontal shapes (text, hairlines) and lands on the wrong whole pixel.
  let best = { sx: 0, sy: 0, error: Infinity };
  for (let sy = -MAX_SHIFT_Y; sy <= MAX_SHIFT_Y; sy += 1) {
    for (let sx = -MAX_SHIFT_X; sx <= MAX_SHIFT_X; sx += 1) {
      const error = mismatch(base, head, rect, sx, sy);
      if (error < best.error) best = { sx, sy, error };
    }
  }
  let refined = { sx: best.sx, sy: best.sy, error: best.error };
  for (let dy = -1; dy <= 1 + 1e-9; dy += STEP) {
    for (let dx = -1; dx <= 1 + 1e-9; dx += STEP) {
      const sx = best.sx + dx, sy = best.sy + dy;
      const error = mismatch(base, head, rect, sx, sy);
      if (error < refined.error) refined = { sx, sy, error };
    }
  }
  // A best fit at the edge of the search is no answer: the real one may lie beyond it, and repeating content (list
  // rows, a text field) lines up with itself one pitch away.
  if (Math.abs(refined.sx) > MAX_SHIFT_X - EDGE || Math.abs(refined.sy) > MAX_SHIFT_Y - EDGE) return undefined;
  const distance = Math.hypot(refined.sx, refined.sy);
  const needed = distance <= SUBPIXEL ? MIN_EXPLAINED_SUBPIXEL : MIN_EXPLAINED;
  if (distance < MIN_SHIFT || 1 - refined.error / unshifted < needed) return undefined;
  const round = (value: number) => Math.round(value * 100) / 100 || 0;
  return { x: round(refined.sx), y: round(refined.sy) };
}

/** Each region's shift between two screenshots of the same size; undefined where a region's content changed. */
export function regionShifts(baseFrame: DecodedFrame, headFrame: DecodedFrame, regions: readonly Rect[]): Array<RegionShift | undefined> {
  if (baseFrame.width !== headFrame.width || baseFrame.height !== headFrame.height) return regions.map(() => undefined);
  const base = luminance(baseFrame), head = luminance(headFrame);
  return regions.map(region => regionShift(base, head, region));
}

/** Reads both PNG screenshots and measures each region's shift. */
export async function measureRegionShifts(basePath: string, headPath: string, regions: readonly Rect[]): Promise<Array<RegionShift | undefined>> {
  const { PNG } = createRequire(import.meta.url.replace(/\?.*$/, ""))("pngjs") as
    { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame } } };
  const [base, head] = await Promise.all([readFile(basePath), readFile(headPath)]);
  return regionShifts(PNG.sync.read(base, { checkCRC: false }), PNG.sync.read(head, { checkCRC: false }), regions);
}
