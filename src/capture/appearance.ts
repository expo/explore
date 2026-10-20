import type { CaptureBundle, CaptureOutcome } from "../contracts/capture.js";

export type ColorScheme = "light" | "dark";
/** `auto` follows the app's `userInterfaceStyle`; a list captures exactly those schemes, first one primary. */
export type AppearanceSetting = "auto" | readonly ColorScheme[];

export const COLOR_SCHEMES: readonly ColorScheme[] = ["light", "dark"];

/** Which appearances one capture renders. `auto` reads what the app declares: `automatic` supports both. */
export function resolveColorSchemes(appearance: AppearanceSetting, appConfig: Record<string, unknown> | undefined, platform: string): ColorScheme[] {
  if (appearance !== "auto") return [...new Set(appearance)];
  const platformConfig = appConfig?.[platform];
  const declared = (platformConfig && typeof platformConfig === "object" ? (platformConfig as Record<string, unknown>).userInterfaceStyle : undefined)
    ?? appConfig?.userInterfaceStyle;
  if (declared === "automatic") return ["light", "dark"];
  if (declared === "dark") return ["dark"];
  // Expo renders light when the app config declares no style.
  return ["light"];
}

/**
 * What an Argent capture renders: one pass, since Argent cannot switch the device's appearance yet
 * (software-mansion/argent#1509). An app that forces a style renders it on any device; any other app renders as the
 * fresh simulator starts, light. Requested schemes that pass cannot show are reported as skipped.
 */
export function argentColorSchemes(requested: readonly ColorScheme[], appConfig: Record<string, unknown> | undefined, platform: string): { schemes: ColorScheme[]; skipped: ColorScheme[] } {
  const platformConfig = appConfig?.[platform];
  const declared = (platformConfig && typeof platformConfig === "object" ? (platformConfig as Record<string, unknown>).userInterfaceStyle : undefined)
    ?? appConfig?.userInterfaceStyle;
  const scheme: ColorScheme = declared === "dark" ? "dark" : "light";
  return { schemes: [scheme], skipped: requested.filter(item => item !== scheme) };
}

export function parseAppearance(value: unknown, path: string): AppearanceSetting {
  if (value === undefined || value === "auto") return "auto";
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some(entry => !COLOR_SCHEMES.includes(entry as ColorScheme))) {
    throw new Error(`${path} must be "auto", "dark", "light", or a list of those.`);
  }
  return [...new Set(list as ColorScheme[])];
}

/** The primary scheme keeps the route's screen id, so single-appearance captures and their caches are unchanged. */
export function schemeScreenId(routeId: string, scheme: ColorScheme | undefined): string {
  return scheme ? `${routeId}@${scheme}` : routeId;
}

export function routeIdOfScreen(screenId: string): { routeId: string; scheme?: ColorScheme } {
  const match = /^(.*)@(light|dark)$/.exec(screenId);
  return match ? { routeId: match[1]!, scheme: match[2] as ColorScheme } : { routeId: screenId };
}

export function appearanceArgs(scheme: ColorScheme): string[] {
  return ["settings", "appearance", scheme];
}

/**
 * Route outcomes across appearance passes. The primary pass owns the route's outcome; a secondary pass that did not
 * capture a route records its failure under `<route>@<scheme>`, so the primary frame stays reported and only that
 * appearance is unavailable. `schemes` names each pass, primary first.
 */
function demoteUnattributed(outcome: CaptureOutcome): CaptureOutcome {
  const { screenshotSha256: _sha, observed, ...rest } = outcome;
  const code = observed?.reason === "observer-not-ready" ? "CAPTURE_OBSERVER_NOT_READY" : "ROUTE_LANDING_MISMATCH";
  return { ...rest, status: "failed", landing: "unverified", error: { code, stage: "capture", retryable: true,
    message: outcome.reason ?? "The app showed another screen for this route's link.",
    nextAction: "Check the app's handling of this route's link, then rerun capture." } };
}

export function mergeSchemeOutcomes(passes: readonly Record<string, CaptureOutcome>[], schemes: readonly ColorScheme[] = []): Record<string, CaptureOutcome> {
  const merged: Record<string, CaptureOutcome> = {};
  const verified = (value: CaptureOutcome) => value.status === "captured" && value.landing === "verified";
  for (const id of new Set(passes.flatMap(pass => Object.keys(pass)))) {
    const primary = passes[0]?.[id];
    const outcomes = passes.map(pass => pass[id]).filter((value): value is CaptureOutcome => value !== undefined);
    if (primary) merged[id] = { ...primary, attempts: Math.max(...outcomes.map(value => value.attempts)) };
    for (const [index, pass] of passes.entries()) {
      const outcome = pass[id];
      if (index === 0 || !outcome) continue;
      const scheme = schemes[index];
      // A verified secondary frame is published under `<id>@<scheme>` when its own pass failed to land the primary
      // frame too: the review then shows that appearance and marks the primary one unavailable, instead of nothing.
      if (verified(outcome)) {
        if (scheme && !(primary && primary.status === "captured")) merged[schemeScreenId(id, scheme)] = outcome;
        // Its note (setup that did not complete in that appearance) stays with the route the frame is published under.
        else if (outcome.reason && merged[id]) merged[id] = { ...merged[id], reason: [merged[id].reason, scheme ? `In ${scheme}: ${outcome.reason}` : outcome.reason].filter(Boolean).join(" ") };
        continue;
      }
      if (scheme && primary && primary.status === "captured") merged[schemeScreenId(id, scheme)] = outcome;
      // Without a primary frame the route has no slot for a secondary frame: an unattributed one is reported as the miss it records.
      else merged[id] = outcome.status === "captured" ? demoteUnattributed(outcome) : outcome;
    }
  }
  return merged;
}

/** The appearances a bundle rendered, primary first; one when its runtime profile names none. */
export function bundleColorSchemes(bundle: { runtimeProfile?: { colorScheme?: string; colorSchemes?: string } | null }): ColorScheme[] {
  const listed = bundle.runtimeProfile?.colorSchemes?.split(",").filter((entry): entry is ColorScheme => COLOR_SCHEMES.includes(entry as ColorScheme)) ?? [];
  if (listed.length > 0) return [...new Set(listed)];
  const single = bundle.runtimeProfile?.colorScheme;
  return [single === "dark" ? "dark" : "light"];
}

/** The surface ids one route contributes to a review: itself, then one `<id>@<scheme>` per secondary appearance. */
export function appearanceSurfaceIds(routeId: string, schemes: readonly ColorScheme[]): { id: string; scheme: ColorScheme }[] {
  return schemes.map((scheme, index) => ({ id: schemeScreenId(routeId, index === 0 ? undefined : scheme), scheme }));
}

/**
 * Like-for-like pairing of one route's head appearances with the base capture: a head frame compares against the base
 * frame of the same scheme (whichever slot the base rendered it in), and a scheme the base never rendered has no pair.
 */
export function appearancePairs(routeId: string, headSchemes: readonly ColorScheme[], baseSchemes: readonly ColorScheme[]):
  { id: string; scheme: ColorScheme; baseId: string | null }[] {
  return appearanceSurfaceIds(routeId, headSchemes).map(({ id, scheme }) => ({
    id, scheme,
    baseId: baseSchemes.includes(scheme) ? schemeScreenId(routeId, scheme === baseSchemes[0] ? undefined : scheme) : null,
  }));
}

/** A `<id>@<scheme>` outcome recording that its whole appearance pass failed (`sessionFailures`), whatever the primary did. */
export function failedPassOutcome(bundle: Pick<CaptureBundle, "outcomes" | "sessionFailures">, id: string): boolean {
  const { scheme } = routeIdOfScreen(id);
  const own = bundle.outcomes[id];
  return scheme !== undefined && own?.status === "failed" && (bundle.sessionFailures ?? []).some(failure => failure.scheme === scheme
    && failure.error.code === own.error?.code && failure.error.message === own.error?.message);
}
