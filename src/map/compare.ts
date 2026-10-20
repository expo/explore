import {
  BUILD_COMPARISON_CONTRACT,
  type BuildComparison,
  type BuildComparisonEntry,
  type ExploreMap,
  type Observation,
  type Screen,
} from "../types.js";
import { accessibilityFingerprintsComparable } from "./store.js";

/**
 * Cross-run screen matching for PR-style comparisons (baseline = base branch map,
 * current = head map). Signals are ordered by observed reliability:
 * route and canonical ID are deterministic when the exploring agent follows the
 * skill's ID/route discipline; an exact accessibility-fingerprint intersection
 * proves an identical rendered tree; a unique normalized title is a weak rename
 * signal. Visual fingerprints differ on every capture and are never compared.
 */
export type CompareMatchSignal = "route" | "screen-id" | "accessibility" | "title";

export type CompareReviewEntry = {
  entryId: string;
  relationship: BuildComparisonEntry["relationship"];
  status: BuildComparisonEntry["status"];
  matchedBy: CompareMatchSignal[];
  confidence: number;
  needsReview: boolean;
  notes: string[];
  /** For unmatched screens: plausible counterparts the generator refused to auto-match. */
  candidates?: { side: "baseline" | "current"; screenId: string; reason: string }[];
};

/**
 * Advisory generator diagnostics. This document is NOT part of the
 * expo.explore.build-comparison.v1 contract (whose schema forbids extra fields);
 * it rides next to the comparison for a reviewing agent or the CI comment step.
 */
export type CompareReview = {
  generatedBy: "expo-explore compare";
  baselineBuildId: string;
  currentBuildId: string;
  entries: CompareReviewEntry[];
};

export type CompareResult = {
  comparison: BuildComparison;
  review: CompareReview;
  summary: {
    entries: number;
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    needsReview: number;
  };
};

export class CompareError extends Error {}

const CONFIDENCE: Record<CompareMatchSignal, number> = {
  route: 0.9,
  "screen-id": 0.85,
  accessibility: 0.8,
  title: 0.65,
};

/** route+id together beat any single signal. */
const CONFIDENCE_ROUTE_AND_ID = 0.95;
const REVIEW_THRESHOLD = 0.8;

function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

type SideScreen = {
  screen: Screen;
  route?: string;
  title: string;
  accessibilityHashes: Set<string>;
  representative: Observation;
};

type Side = {
  buildId: string;
  screens: SideScreen[];
  byId: Map<string, SideScreen>;
  byRoute: Map<string, SideScreen[]>;
  byTitle: Map<string, SideScreen[]>;
  byAccessibility: Map<string, SideScreen[]>;
};

function representativeObservation(map: ExploreMap, screen: Screen): Observation {
  const observations = map.observations.filter((observation) => (
    observation.screenId === screen.id && observation.screenshotArtifactId
  ));
  const first = observations[0];
  if (!first) {
    throw new CompareError(
      `Screen ${screen.id} in ${map.run.build.id ?? map.run.id} has no observation with a screenshot; the comparison contract requires a representative screenshot per screen`,
    );
  }
  return first;
}

function indexSide(map: ExploreMap): Side {
  const buildId = map.run.build.id;
  if (!buildId) {
    throw new CompareError(
      "Map is missing run.build.id; initialize the run with --build-id so the catalog and comparison can reference it",
    );
  }
  const screens: SideScreen[] = map.screens.map((screen) => ({
    screen,
    ...(screen.route ? { route: normalizeRoute(screen.route) } : {}),
    title: normalizeTitle(screen.title),
    accessibilityHashes: new Set(
      map.observations
        .filter((observation) => observation.screenId === screen.id)
        .map((observation) => observation.fingerprints.accessibility)
        .filter((hash): hash is string => Boolean(hash)),
    ),
    representative: representativeObservation(map, screen),
  }));
  const byId = new Map(screens.map((entry) => [entry.screen.id, entry]));
  const byRoute = new Map<string, SideScreen[]>();
  const byTitle = new Map<string, SideScreen[]>();
  const byAccessibility = new Map<string, SideScreen[]>();
  for (const entry of screens) {
    if (entry.route) {
      byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
    }
    byTitle.set(entry.title, [...(byTitle.get(entry.title) ?? []), entry]);
    for (const hash of entry.accessibilityHashes) {
      byAccessibility.set(hash, [...(byAccessibility.get(hash) ?? []), entry]);
    }
  }
  return { buildId, screens, byId, byRoute, byTitle, byAccessibility };
}

type Match = {
  baseline: SideScreen;
  current: SideScreen;
  matchedBy: CompareMatchSignal[];
  confidence: number;
};

/**
 * Greedy one-to-one matching in signal-priority order. A signal only matches when it
 * is unambiguous: exactly one unclaimed screen carries the value on each side.
 * Splits and merges are never inferred automatically; their screens surface as
 * added/removed entries with review candidates for a human or agent to regroup.
 */
function matchScreens(baseline: Side, current: Side): {
  matches: Match[];
  removed: SideScreen[];
  added: SideScreen[];
} {
  const claimedBaseline = new Set<string>();
  const claimedCurrent = new Set<string>();
  const matches: Match[] = [];

  const claim = (b: SideScreen, c: SideScreen, matchedBy: CompareMatchSignal[], confidence: number) => {
    claimedBaseline.add(b.screen.id);
    claimedCurrent.add(c.screen.id);
    matches.push({ baseline: b, current: c, matchedBy, confidence });
  };

  const unclaimedOne = (
    entries: SideScreen[] | undefined,
    claimed: Set<string>,
  ): SideScreen | undefined => {
    const open = (entries ?? []).filter((entry) => !claimed.has(entry.screen.id));
    return open.length === 1 ? open[0] : undefined;
  };

  for (const entry of baseline.screens) {
    if (!entry.route || claimedBaseline.has(entry.screen.id)) continue;
    if (unclaimedOne(baseline.byRoute.get(entry.route), claimedBaseline) !== entry) continue;
    const counterpart = unclaimedOne(current.byRoute.get(entry.route), claimedCurrent);
    if (!counterpart) continue;
    const alsoId = counterpart.screen.id === entry.screen.id;
    claim(
      entry,
      counterpart,
      alsoId ? ["route", "screen-id"] : ["route"],
      alsoId ? CONFIDENCE_ROUTE_AND_ID : CONFIDENCE.route,
    );
  }

  for (const entry of baseline.screens) {
    if (claimedBaseline.has(entry.screen.id)) continue;
    const counterpart = current.byId.get(entry.screen.id);
    if (!counterpart || claimedCurrent.has(counterpart.screen.id)) continue;
    claim(entry, counterpart, ["screen-id"], CONFIDENCE["screen-id"]);
  }

  for (const entry of baseline.screens) {
    if (claimedBaseline.has(entry.screen.id)) continue;
    for (const hash of entry.accessibilityHashes) {
      if (unclaimedOne(baseline.byAccessibility.get(hash), claimedBaseline) !== entry) continue;
      const counterpart = unclaimedOne(current.byAccessibility.get(hash), claimedCurrent);
      if (!counterpart) continue;
      claim(entry, counterpart, ["accessibility"], CONFIDENCE.accessibility);
      break;
    }
  }

  for (const entry of baseline.screens) {
    if (claimedBaseline.has(entry.screen.id)) continue;
    if (unclaimedOne(baseline.byTitle.get(entry.title), claimedBaseline) !== entry) continue;
    const counterpart = unclaimedOne(current.byTitle.get(entry.title), claimedCurrent);
    if (!counterpart) continue;
    claim(entry, counterpart, ["title"], CONFIDENCE.title);
  }

  return {
    matches,
    removed: baseline.screens.filter((entry) => !claimedBaseline.has(entry.screen.id)),
    added: current.screens.filter((entry) => !claimedCurrent.has(entry.screen.id)),
  };
}

function candidatesFor(
  entry: SideScreen,
  otherSide: Side,
  side: "baseline" | "current",
): CompareReviewEntry["candidates"] {
  const candidates: NonNullable<CompareReviewEntry["candidates"]> = [];
  for (const other of otherSide.screens) {
    const reasons: string[] = [];
    if (entry.route && other.route) {
      if (other.route === entry.route) reasons.push("same route");
      else if (other.route.startsWith(`${entry.route}/`) || entry.route.startsWith(`${other.route}/`)) {
        reasons.push("nested route");
      }
    }
    if (other.title === entry.title) reasons.push("same title");
    if (reasons.length > 0) {
      candidates.push({ side, screenId: other.screen.id, reason: reasons.join(", ") });
    }
  }
  return candidates.length > 0 ? candidates : undefined;
}

function matchEntry(match: Match): { entry: BuildComparisonEntry; review: CompareReviewEntry } {
  // The verdict compares exactly the pair of captures the viewer shows. A looser
  // any-observation intersection would let one shared variant (a loading skeleton
  // captured on both sides) hide a real change to the primary content.
  const baselineHash = match.baseline.representative.fingerprints.accessibility;
  const currentHash = match.current.representative.fingerprints.accessibility;
  // Hashes from different fingerprint versions (an older Explore's map) say nothing about whether the trees differ.
  const verdict = baselineHash && currentHash && accessibilityFingerprintsComparable(baselineHash, currentHash)
    ? (baselineHash === currentHash ? "unchanged" : "modified")
    : "unknown";
  const unchanged = verdict === "unchanged";
  const signals = match.matchedBy.join(" and ");
  const rationale = verdict === "unchanged"
    ? `Matched by ${signals}; the representative captures share an accessibility fingerprint, so the rendered tree is unchanged.`
    : verdict === "modified"
      ? `Matched by ${signals}; the representative captures have different accessibility fingerprints, so the rendered tree changed.`
      : baselineHash && currentHash
        ? `Matched by ${signals}; the representative captures were fingerprinted by different Explore versions, so the change state could not be verified from fingerprints.`
        : `Matched by ${signals}; accessibility fingerprints are unavailable on at least one side, so the change state could not be verified from fingerprints.`;
  const entry: BuildComparisonEntry = {
    id: `match-${match.current.screen.id}`,
    relationship: "one-to-one",
    status: unchanged ? "unchanged" : "modified",
    baselineScreenIds: [match.baseline.screen.id],
    currentScreenIds: [match.current.screen.id],
    baselineRepresentativeObservationIds: [match.baseline.representative.id],
    currentRepresentativeObservationIds: [match.current.representative.id],
    representativePairs: [
      {
        baselineObservationId: match.baseline.representative.id,
        currentObservationId: match.current.representative.id,
        confidence: match.confidence,
        rationale,
      },
    ],
    confidence: match.confidence,
    rationale,
  };
  const notes: string[] = [];
  if (match.confidence < REVIEW_THRESHOLD) {
    notes.push(`Matched only by ${signals}; confirm this is the same canonical screen.`);
  }
  if (verdict === "unknown") {
    notes.push("Fingerprints could not verify the change state; compare the screenshots.");
  }
  return {
    entry,
    review: {
      entryId: entry.id,
      relationship: entry.relationship,
      status: entry.status,
      matchedBy: match.matchedBy,
      confidence: match.confidence,
      needsReview: match.confidence < REVIEW_THRESHOLD || verdict === "unknown",
      notes,
    },
  };
}

function unmatchedEntry(
  screen: SideScreen,
  side: "baseline" | "current",
  otherSide: Side,
): { entry: BuildComparisonEntry; review: CompareReviewEntry } {
  const removed = side === "baseline";
  const rationale = removed
    ? "No current screen shares this screen's route, ID, accessibility fingerprint, or unique title."
    : "No baseline screen shares this screen's route, ID, accessibility fingerprint, or unique title.";
  const entry: BuildComparisonEntry = {
    id: `${removed ? "removed" : "added"}-${screen.screen.id}`,
    relationship: removed ? "removed" : "added",
    status: removed ? "removed" : "added",
    baselineScreenIds: removed ? [screen.screen.id] : [],
    currentScreenIds: removed ? [] : [screen.screen.id],
    baselineRepresentativeObservationIds: removed ? [screen.representative.id] : [],
    currentRepresentativeObservationIds: removed ? [] : [screen.representative.id],
    representativePairs: [],
    confidence: 0.7,
    rationale,
  };
  const candidates = candidatesFor(screen, otherSide, removed ? "current" : "baseline");
  return {
    entry,
    review: {
      entryId: entry.id,
      relationship: entry.relationship,
      status: entry.status,
      matchedBy: [],
      confidence: entry.confidence,
      needsReview: Boolean(candidates),
      notes: candidates
        ? ["Unmatched, but plausible counterparts exist; review for a rename, split, or merge."]
        : [],
      ...(candidates ? { candidates } : {}),
    },
  };
}

/**
 * Generate a schema-valid expo.explore.build-comparison.v1 document plus an advisory
 * review sidecar from two validated maps. Every screen on both sides receives exactly
 * one entry, which the workspace loader requires.
 */
export function generateComparison(
  baselineMap: ExploreMap,
  currentMap: ExploreMap,
): CompareResult {
  const baseline = indexSide(baselineMap);
  const current = indexSide(currentMap);
  if (baseline.buildId === current.buildId) {
    throw new CompareError(
      `Baseline and current maps have the same run.build.id (${baseline.buildId}); give each side a distinct --build-id`,
    );
  }
  if (baselineMap.screens.length === 0 || currentMap.screens.length === 0) {
    throw new CompareError("Both maps must contain at least one screen to compare");
  }

  const { matches, removed, added } = matchScreens(baseline, current);
  const results = [
    ...matches.map(matchEntry),
    ...removed.map((screen) => unmatchedEntry(screen, "baseline", current)),
    ...added.map((screen) => unmatchedEntry(screen, "current", baseline)),
  ];
  const order: Record<BuildComparisonEntry["status"], number> = {
    added: 0,
    modified: 1,
    removed: 2,
    unchanged: 3,
    "needs-review": 4,
    "source-affected": 5,
    "not-compared": 6,
    unavailable: 7,
    variant: 8,
  };
  // Code-unit comparison keeps the serialized document byte-stable across
  // locales and ICU builds; localeCompare would reorder ids per environment.
  results.sort((left, right) => (
    order[left.entry.status] - order[right.entry.status]
    || (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0)
  ));

  const entries = results.map((result) => result.entry);
  const reviewEntries = results.map((result) => result.review);
  const comparison: BuildComparison = {
    contract: BUILD_COMPARISON_CONTRACT,
    baselineBuildId: baseline.buildId,
    currentBuildId: current.buildId,
    baselineRunId: baselineMap.run.id,
    currentRunId: currentMap.run.id,
    baselineRevision: baselineMap.revision,
    currentRevision: currentMap.revision,
    entries,
  };
  return {
    comparison,
    review: {
      generatedBy: "expo-explore compare",
      baselineBuildId: baseline.buildId,
      currentBuildId: current.buildId,
      entries: reviewEntries,
    },
    summary: {
      entries: entries.length,
      added: entries.filter((entry) => entry.status === "added").length,
      removed: entries.filter((entry) => entry.status === "removed").length,
      modified: entries.filter((entry) => entry.status === "modified").length,
      unchanged: entries.filter((entry) => entry.status === "unchanged").length,
      needsReview: reviewEntries.filter((entry) => entry.needsReview).length,
    },
  };
}
