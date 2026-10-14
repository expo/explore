/**
 * Runtime profile of this example app.
 *
 * The `explore` EAS build profile sets EXPO_PUBLIC_EXPLORE_MODE=true. In that profile the app
 * uses a fixed clock and static progress indicators so that two captures of the same screen are
 * comparable; everything else (accounts, balances, transfers) behaves exactly as in a normal build.
 */
export const isExploreProfile = process.env.EXPO_PUBLIC_EXPLORE_MODE === 'true';

/** Fixed "now" in the explore profile: Tuesday, 1 September 2026, 10:00 UTC. */
export const FIXTURE_NOW = Date.parse('2026-09-01T10:00:00.000Z');

export const now = (): number => (isExploreProfile ? FIXTURE_NOW : Date.now());

/** Simulated network latency for transfers, top-ups, purchases and account deletion. */
export const PROCESSING_DELAY_MS = 1200;
export const SHORT_DELAY_MS = 800;

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
