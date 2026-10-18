import { useSyncExternalStore } from "react";
import { optionalStorage } from "./embedded-report";

/**
 * PROTOTYPE: how Split shows the changed areas over Before and After. Picked from a floating panel in
 * Compare or with `?outlines=<id>` in the URL; remembered in storage.
 */
export type OutlineVariant = "both" | "after" | "hover" | "gutter" | "pixels";

export const OUTLINE_VARIANTS: { id: OutlineVariant; label: string; detail: string }[] = [
  { id: "both", label: "Both sides (current)", detail: "The same boxes on Before and on After." },
  { id: "after", label: "After only, linked", detail: "Boxes on After; hover one and it lights up on Before." },
  { id: "hover", label: "On hover", detail: "Clean screenshots; the boxes show while the pointer is over a frame." },
  { id: "gutter", label: "Gutter marks", detail: "No boxes. Ticks between the frames mark each change; hover or click one." },
  { id: "pixels", label: "Changed pixels", detail: "Exactly what changed, tinted on After. Before stays clean. No boxes." },
];

const STORAGE_KEY = "expo-explore:compare-outline-variant";
const listeners = new Set<() => void>();
let chosen: OutlineVariant | undefined;

function fromQuery(): OutlineVariant | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("outlines");
  return OUTLINE_VARIANTS.find((variant) => variant.id === value)?.id;
}

function stored(): OutlineVariant {
  const value = chosen ?? fromQuery() ?? optionalStorage.getItem(STORAGE_KEY);
  return OUTLINE_VARIANTS.find((variant) => variant.id === value)?.id ?? "both";
}

export function setOutlineVariant(variant: OutlineVariant) {
  chosen = variant;
  optionalStorage.setItem(STORAGE_KEY, variant);
  for (const listener of listeners) listener();
}

export function useOutlineVariant(): OutlineVariant {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    stored,
    () => "both",
  );
}
