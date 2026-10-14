import { ATM_CITIES, type Atm, type AtmCity, type Coordinates } from '@/fixtures/atms';

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceBetween(from: Coordinates, to: Coordinates): number {
  const dLatitude = toRadians(to.latitude - from.latitude);
  const dLongitude = toRadians(to.longitude - from.longitude);
  const a = Math.sin(dLatitude / 2) ** 2
    + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Beyond this, the closest partner ATM is too far to call nearby. */
export const NEARBY_RADIUS_M = 50_000;

export type AtmNearby = Atm & { distance: number };
export type NearbyAtms = { city: AtmCity; atms: AtmNearby[]; nearby: boolean };

/** The partner city closest to `position`, with its ATMs from nearest to farthest. */
export function nearbyAtms(position: Coordinates): NearbyAtms {
  let city = ATM_CITIES[0]!;
  let best = Infinity;
  for (const candidate of ATM_CITIES) {
    const distance = distanceBetween(position, candidate);
    if (distance < best) { best = distance; city = candidate; }
  }
  const atms = city.atms.map((atm) => ({ ...atm, distance: distanceBetween(position, atm) })).sort((a, b) => a.distance - b.distance);
  return { city, atms, nearby: atms[0]!.distance <= NEARBY_RADIUS_M };
}

const wholeKilometres = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "350 m", "1.2 km" or "344 km". */
export function formatDistance(metres: number): string {
  if (metres < 1_000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  if (metres < 10_000) return `${(metres / 1_000).toFixed(1)} km`;
  return `${wholeKilometres.format(metres / 1_000)} km`;
}

/** Walking time at about 5 km/h, for distances worth walking; null beyond that. */
export function walkingTime(metres: number): string | null {
  if (metres > 3_000) return null;
  return `${Math.max(1, Math.round(metres / 80))} min walk`;
}
