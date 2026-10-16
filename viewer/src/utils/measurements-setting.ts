import { useSyncExternalStore } from "react";
import { optionalStorage } from "./embedded-report";

const MEASUREMENTS_STORAGE_KEY = "expo-explore:compare-measurements";
const listeners = new Set<() => void>();

function stored(): boolean {
  return optionalStorage.getItem(MEASUREMENTS_STORAGE_KEY) !== "false";
}

/** Shows or hides how far each moved area moved, everywhere at once, and remembers the choice. */
export function setMeasurementsShown(shown: boolean) {
  optionalStorage.setItem(MEASUREMENTS_STORAGE_KEY, String(shown));
  for (const listener of listeners) listener();
}

/** Whether outlines label how far each moved area moved: on until a reader turns it off in What changed. */
export function useMeasurementsShown(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    stored,
    () => true,
  );
}
