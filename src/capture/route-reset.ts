/**
 * What puts the app in a known state before each route's app link.
 *
 * `root-link` (default) opens the app's own root link (`scheme://`) and lets it settle first, so
 * every route link starts from the app's home rather than from whatever the previous route left
 * on screen: a sheet still presented, a modal half dismissed, or a list the last link mutated.
 * Measured on euxy (iOS 26.5 and Android 14 simulators, 16 routes × 2 appearances): without it the
 * two share-link sheets missed in dark on iOS in every pass; with it every pass captured 32/32 at
 * no net cost, since the ~2 s reset per route replaced the ~45 s a missed link costs.
 * Relaunching per route is not offered: a cold launch per route broke settle detection on iOS.
 */
export type RouteResetSetting = "root-link" | "none";

export const ROUTE_RESET_SETTINGS: readonly RouteResetSetting[] = ["root-link", "none"];

export function parseRouteResetSetting(value: unknown, path: string): RouteResetSetting {
  if (value === undefined) return "root-link";
  if (typeof value === "string" && (ROUTE_RESET_SETTINGS as readonly string[]).includes(value)) return value as RouteResetSetting;
  throw new Error(`${path} must be "root-link" or "none".`);
}
