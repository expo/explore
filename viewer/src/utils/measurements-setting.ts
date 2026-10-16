import { useSyncExternalStore } from "react";
import { optionalStorage } from "./embedded-report";

const MEASUREMENTS_STORAGE_KEY = "expo-explore:compare-measurements";
const listeners = new Set<() => void>();
/** The choice made this visit: storage can be denied (a private window), and the switch must still work. */
let chosen: boolean | undefined;

function stored(): boolean {
  return chosen ?? optionalStorage.getItem(MEASUREMENTS_STORAGE_KEY) !== "false";
}

/** Shows or hides how far each moved area moved, everywhere at once, and remembers the choice where it can. */
export function setMeasurementsShown(shown: boolean) {
  chosen = shown;
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
