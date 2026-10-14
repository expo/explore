import type { ExploreMap } from "../../../src/types";
import {
  normalizeRoute,
  screenRoutesOf,
  type ScreenRouteAlias,
} from "./navigation";

const NUMERIC_CAPTURE_ROUTE = /^(.*\/)(\d+)$/;

type NumericRouteAnchor = {
  index: number;
  screenId: string;
};

/**
 * Restores source-capture URLs after reviewed canonicalisation turns a capture into a variant.
 *
 * This is intentionally conservative. We derive aliases only when the map itself proves that it
 * came from one complete, ordered numeric capture namespace: timestamps are unique, indices are
 * contiguous from zero, every authored numeric route agrees with the observation at that index,
 * and every observation/variant relationship is internally valid. A normal runtime exploration
 * will fail those guards and receive no synthetic routes.
 */
export function deriveCaptureRouteAliases(map: ExploreMap): Map<string, ScreenRouteAlias> {
  if (map.observations.length < 3) return new Map();

  const ordered = map.observations.map((observation) => ({
    observation,
    capturedAt: Date.parse(observation.capturedAt),
  }));
  if (ordered.some(({ capturedAt }) => !Number.isFinite(capturedAt))) return new Map();
  ordered.sort((left, right) => left.capturedAt - right.capturedAt);
  if (ordered.some((entry, index) => index > 0 && entry.capturedAt === ordered[index - 1]!.capturedAt)) {
    return new Map();
  }

  const screens = new Map(map.screens.map((screen) => [screen.id, screen]));
  const variants = new Map(map.variants.map((variant) => [variant.id, variant]));
  for (const { observation } of ordered) {
    const screen = screens.get(observation.screenId);
    if (!screen || !screen.observationIds.includes(observation.id)) return new Map();
    if (!observation.variantId) continue;
    const variant = variants.get(observation.variantId);
    if (!variant
      || variant.screenId !== screen.id
      || !screen.variantIds.includes(variant.id)
      || !variant.observationIds.includes(observation.id)) {
      return new Map();
    }
  }

  const routes = screenRoutesOf(map.screens);
  const anchorsByPrefix = new Map<string, NumericRouteAnchor[]>();
  const ownersByRoute = new Map<string, string[]>();
  for (const [screenId, route] of routes) {
    const owners = ownersByRoute.get(route) ?? [];
    owners.push(screenId);
    ownersByRoute.set(route, owners);
    const match = NUMERIC_CAPTURE_ROUTE.exec(route);
    if (!match) continue;
    const anchors = anchorsByPrefix.get(match[1]!) ?? [];
    anchors.push({ index: Number(match[2]), screenId });
    anchorsByPrefix.set(match[1]!, anchors);
  }

  const matchingPrefixes = [...anchorsByPrefix].filter(([, anchors]) => {
    if (anchors.length < 3) return false;
    const indices = new Set(anchors.map((anchor) => anchor.index));
    if (indices.size !== anchors.length || !indices.has(0)) return false;
    if (Math.max(...indices) !== ordered.length - 1) return false;
    return anchors.every(({ index, screenId }) => (
      index < ordered.length && ordered[index]!.observation.screenId === screenId
    ));
  });
  // More than one matching namespace would make a numeric path ambiguous.
  if (matchingPrefixes.length !== 1) return new Map();

  const [prefix] = matchingPrefixes[0]!;
  const aliases = new Map<string, ScreenRouteAlias>();
  for (let index = 0; index < ordered.length; index += 1) {
    const { observation } = ordered[index]!;
    const screenRoute = routes.get(observation.screenId);
    if (!screenRoute || !screenRoute.startsWith(prefix)) return new Map();
    const historicalRoute = normalizeRoute(`${prefix}${index}`);
    // An authored route remains authoritative; aliases only fill paths lost by grouping.
    if (ownersByRoute.has(historicalRoute)) continue;
    aliases.set(historicalRoute, {
      screenId: observation.screenId,
      ...(observation.variantId ? { variantId: observation.variantId } : {}),
    });
  }
  return aliases;
}
