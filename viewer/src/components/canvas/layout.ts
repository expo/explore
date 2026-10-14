/** Shared canvas geometry helpers. */

/** `01`, `02`, … — a stable ordinal for downloaded screenshots from one flow. */
export function stepLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}
