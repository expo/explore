import { useSyncExternalStore } from "react";
import { optionalStorage } from "./embedded-report";

const INSPECTOR_WIDTH_STORAGE_KEY = "expo-explore:inspector-width";
/** Below this the Before/After pair no longer reads; above the maximum the canvas is the one squeezed. */
export const INSPECTOR_WIDTH_MIN = 320;
export const INSPECTOR_WIDTH_MAX = 800;
/** How far one arrow key press moves the panel's edge. */
export const INSPECTOR_WIDTH_STEP = 16;

const listeners = new Set<() => void>();
/** The choice made this visit: storage can be denied (a private window), and the drag must still hold. `null` is a reset. */
let chosen: number | null | undefined;

function parseWidth(value: string | null): number | undefined {
  if (value === null) return undefined;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

function stored(): number | undefined {
  if (chosen !== undefined) return chosen ?? undefined;
  return parseWidth(optionalStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY));
}

/** Sets the Inspector's width in unscaled CSS pixels, or `undefined` to return to the default, and remembers it where it can. */
export function setInspectorWidth(width: number | undefined) {
  chosen = width ?? null;
  if (width === undefined) optionalStorage.removeItem(INSPECTOR_WIDTH_STORAGE_KEY);
  else optionalStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(width));
  for (const listener of listeners) listener();
}

/** The reader's Inspector width, or `undefined` while the panel keeps its default width. */
export function useInspectorWidth(): number | undefined {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    stored,
    () => undefined,
  );
}

/** The room the bottom bar needs beside the Inspector, in window pixels: its measured width and a gap either side. */
let toolbarRoom = 0;
const toolbarListeners = new Set<() => void>();

/** The bottom bar reports the room it needs whenever its measured width changes (with `--ui-scale` too). */
export function setToolbarRoom(room: number) {
  if (room === toolbarRoom) return;
  toolbarRoom = room;
  for (const listener of toolbarListeners) listener();
}

export function getToolbarRoom(): number {
  return toolbarRoom;
}

export function subscribeToToolbarRoom(onChange: () => void): () => void {
  toolbarListeners.add(onChange);
  return () => toolbarListeners.delete(onChange);
}

export type InspectorWidthBounds = { min: number; max: number };

/**
 * The widths the panel may take in a window `windowWidth` wide: at most half of it, so the canvas
 * keeps the other half, and never so wide that the canvas beside it loses the `toolbarRoom` the
 * bottom bar needs (window pixels), in the panel's own (unscaled) pixels when the chrome is zoomed
 * by `scale`. Neither cap goes below the minimum.
 */
export function inspectorWidthBounds(windowWidth: number, scale = 1, room = 0): InspectorWidthBounds {
  const zoom = scale > 0 ? scale : 1;
  const half = Math.floor(windowWidth / 2 / zoom);
  const besideBar = Math.floor((windowWidth - room) / zoom);
  return { min: INSPECTOR_WIDTH_MIN, max: Math.max(INSPECTOR_WIDTH_MIN, Math.min(INSPECTOR_WIDTH_MAX, half, besideBar)) };
}

export function clampInspectorWidth(width: number, bounds: InspectorWidthBounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}
