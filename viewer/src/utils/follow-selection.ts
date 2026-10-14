import { useSyncExternalStore } from "react";
import { optionalStorage } from "./embedded-report";

const STORAGE_KEY = "expo-explore:follow-selection";
const listeners = new Set<() => void>();
let enabled = optionalStorage.getItem(STORAGE_KEY) === "true";

/**
 * Whether the camera moves to every screen the reader focuses. Off by default: a target
 * that is on screen, even in part, leaves the camera where it is, and only a target that is out
 * of view (from search, the changes menu, history or a link) brings the camera to it.
 */
export function followSelection(): boolean {
  return enabled;
}

export function setFollowSelection(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  if (next) optionalStorage.setItem(STORAGE_KEY, "true");
  else optionalStorage.removeItem(STORAGE_KEY);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFollowSelection(): boolean {
  return useSyncExternalStore(subscribe, followSelection, followSelection);
}
