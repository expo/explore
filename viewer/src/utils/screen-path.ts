import type { MapIndex, Screen } from "./model";

const MOBBIN_CAPTURE_ROUTE = /^\/mobbin(?:\/[^/]+)?\/screens\/\d+\/?$/i;
const STATE_SUFFIX = /\s+[—–]\s+/;

function slugifyPathSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Prefer a captured Expo Router route. Mobbin imports only know their capture inventory URL,
 * so those screens receive a stable, readable prototype path from the title before its state
 * suffix (`Home — Empty` and `Home — Loaded` both become `/home`).
 */
/** The heading for a screen: its route, or its title when the run never knew routes (a black-box exploration). */
export function screenLabel(screen: Pick<Screen, "route" | "title">, index: Pick<MapIndex, "plainTitles">): string {
  return index.plainTitles ? screen.title : displayPathForScreen(screen);
}

export function displayPathForScreen(screen: Pick<Screen, "route" | "title">): string {
  const route = screen.route?.trim();
  if (route && !MOBBIN_CAPTURE_ROUTE.test(route)) {
    return route.startsWith("/") ? route : `/${route}`;
  }

  const pageTitle = screen.title.split(STATE_SUFFIX, 1)[0]?.trim() || screen.title.trim();
  const slug = slugifyPathSegment(pageTitle);
  return slug ? `/${slug}` : "/";
}
