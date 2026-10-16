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
 * anything larger has to be explained mostly by the shift. Measured on euxy's SDK 58 upgrade (PR #161).
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
 * differs by at most about 125 (PR #161), new content by about 200. A few pixels over it are noise; more are a change.
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

/** Reads both PNG screenshots and measures each region's shift. */
export async function measureRegionShifts(basePath: string, headPath: string, regions: readonly Rect[]): Promise<Array<RegionShift | undefined>> {
  const { PNG } = createRequire(import.meta.url.replace(/\?.*$/, ""))("pngjs") as
    { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame } } };
  const [base, head] = await Promise.all([readFile(basePath), readFile(headPath)]);
  return regionShifts(PNG.sync.read(base, { checkCRC: false }), PNG.sync.read(head, { checkCRC: false }), regions);
}
