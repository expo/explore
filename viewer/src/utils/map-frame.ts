import { DEFAULT_SCREENSHOT_RATIO, DEFAULT_SCREENSHOT_SIZE } from "../components/shared/screenshot-image";
import type { ScreenshotSize } from "./screen-images";

// The map is an inspection surface, not a thumbnail cloud. A card is a phone-shaped screenshot
// under its route heading, with enough vertical room for a wrapped title.
export const MAP_SCREEN_WIDTH = 184;
export const MAP_SCREEN_HEIGHT = 420;
// The route heading (20px) and the gap under it (14px) sit above the screenshot slot.
const MAP_HEADING_HEIGHT = 34;
// A phone screenshot fills the slot at its default proportions; a screen of another shape keeps that area.
const MAP_SLOT_AREA = (MAP_SCREEN_HEIGHT - MAP_HEADING_HEIGHT) ** 2 * DEFAULT_SCREENSHOT_RATIO;

/** A map card's size, and the screenshot size a card frames when its own is not known (or missing). */
export type MapFrame = { width: number; height: number; screen: { width: number; height: number } };

/**
 * Cards take the shape of the run's screenshots, so a screenshot fills its slot and the connection ports
 * on the slot's edges sit on the screenshot's border. Phones within a tenth of the default proportions keep
 * the default card; a wider screen, such as a foldable's, gets a card of the same screen area in its shape.
 */
export function mapFrame(size: ScreenshotSize | undefined): MapFrame {
  const screen = placeholderScreen(size);
  if (phoneShaped(size)) return { width: MAP_SCREEN_WIDTH, height: MAP_SCREEN_HEIGHT, screen };
  const ratio = screen.width / screen.height;
  const slotWidth = Math.round(Math.sqrt(MAP_SLOT_AREA * ratio));
  return { width: slotWidth, height: Math.round(slotWidth / ratio) + MAP_HEADING_HEIGHT, screen };
}

function phoneShaped(size: ScreenshotSize | undefined): boolean {
  return !size || Math.abs(size.imageWidth / size.imageHeight / DEFAULT_SCREENSHOT_RATIO - 1) <= 0.1;
}

/**
 * The frame of a screen without a screenshot, given its run's typical screenshot size: the default phone
 * frame in a phone-shaped run, as before, so it lines up with phone screenshots of any exact size; the run's
 * own shape otherwise.
 */
export function placeholderScreen(size: ScreenshotSize | undefined): { width: number; height: number } {
  return size && !phoneShaped(size) ? { width: size.imageWidth, height: size.imageHeight } : { ...DEFAULT_SCREENSHOT_SIZE };
}
