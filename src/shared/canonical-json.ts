/** Canonical JSON object keys; array order remains meaningful (for example setup actions). */
export function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, normalize(child)])) : entry;
  return JSON.stringify(normalize(value));
}
