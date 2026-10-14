import type {
  ActionAttempt,
  Artifact,
  Coverage,
  ExploreMap,
  Journey,
  Observation,
  Screen,
  ScreenElement,
  ScreenVariant,
  Transition,
} from "../../../src/types";
import { staticArtifactUrl } from "./static-source";
import { embeddedArtifactUrl } from "./embedded-report";
import { LAUNCH_SURFACE_ID } from "../../../src/contracts/capture";
import { REPORT_SOURCE } from "./report-source";

export type ViewerPayload = {
  map: ExploreMap;
  coverage: Coverage;
};


export type MapIndex = {
  sourceNavigation?: ExploreMap["sourceNavigation"];
  baselineSourceNavigation?: ExploreMap["baselineSourceNavigation"];
  screens: Map<string, Screen>;
  variants: Map<string, ScreenVariant>;
  observations: Map<string, Observation>;
  artifacts: Map<string, Artifact>;
  elements: Map<string, ScreenElement>;
  attempts: Map<string, ActionAttempt>;
  transitions: Map<string, Transition>;
  outgoing: Map<string, Transition[]>;
  incoming: Map<string, Transition[]>;
  /** The run's open note about a screen (why it has no screenshot, for one), by screen id. */
  screenNotes: Map<string, string>;
  /** A black-box exploration names screens by what it saw, not by a route: show titles, never a made-up path. */
  plainTitles: boolean;
};

export function indexMap(map: ExploreMap): MapIndex {
  const outgoing = new Map<string, Transition[]>();
  const incoming = new Map<string, Transition[]>();
  for (const transition of map.transitions) {
    // Same-screen attempts describe movement between variants. They remain addressable in the
    // transition index, but are not navigation into or out of the screen: the carousel presents
    // those captured states without a misleading row that links back to itself.
    if (transition.fromScreenId === transition.toScreenId) continue;
    outgoing.set(transition.fromScreenId, [
      ...(outgoing.get(transition.fromScreenId) ?? []),
      transition,
    ]);
    incoming.set(transition.toScreenId, [
      ...(incoming.get(transition.toScreenId) ?? []),
      transition,
    ]);
  }
  return {
    ...(map.sourceNavigation ? { sourceNavigation: map.sourceNavigation } : {}),
    ...(map.baselineSourceNavigation ? { baselineSourceNavigation: map.baselineSourceNavigation } : {}),
    screens: new Map(map.screens.map((screen) => [screen.id, screen])),
    variants: new Map(map.variants.map((variant) => [variant.id, variant])),
    observations: new Map(map.observations.map((observation) => [observation.id, observation])),
    artifacts: new Map(map.artifacts.map((artifact) => [artifact.id, artifact])),
    elements: new Map(map.elements.map((element) => [element.id, element])),
    attempts: new Map(map.actionAttempts.map((attempt) => [attempt.id, attempt])),
    transitions: new Map(map.transitions.map((transition) => [transition.id, transition])),
    outgoing,
    incoming,
    plainTitles: map.run?.exploration === "black-box",
    screenNotes: new Map(
      (map.gaps ?? []).filter((gap) => gap.status === "open" && gap.screenId).reverse().map((gap) => [gap.screenId!, gap.message]),
    ),
  };
}

export function latestObservation(screen: Screen, index: MapIndex): Observation | undefined {
  return screen.observationIds
    .map((id) => index.observations.get(id))
    .filter((observation): observation is Observation => Boolean(observation))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    .find((observation) => observation.screenshotArtifactId) ??
    screen.observationIds.map((id) => index.observations.get(id)).find(Boolean);
}

/** The newest captured state for one variant, preferring an observation with a screenshot. */
export function latestObservationForVariant(
  variant: ScreenVariant,
  index: MapIndex,
): Observation | undefined {
  const observations = variant.observationIds
    .map((id) => index.observations.get(id))
    .filter((observation): observation is Observation => Boolean(observation))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id));
  return observations.find((observation) => observation.screenshotArtifactId) ?? observations[0];
}

/** Variants in the screen's authored order; dangling ids are ignored. */
export function variantsForScreen(screen: Screen, index: MapIndex): ScreenVariant[] {
  return screen.variantIds
    .map((id) => index.variants.get(id))
    .filter((variant): variant is ScreenVariant => Boolean(variant));
}

/**
 * Variants with a displayable screenshot, in authored order. An observation the explorer only read
 * the accessibility tree of has no image, so its variant is not a reviewable state; when no variant
 * has one, all of them stay so the Inspector still shows a placeholder.
 */
export function reviewableVariantsForScreen(screen: Screen, index: MapIndex): ScreenVariant[] {
  const all = variantsForScreen(screen, index);
  const withScreenshot = all.filter((variant) => artifactUrl(screenshotForVariant(variant, index)));
  return withScreenshot.length > 0 ? withScreenshot : all;
}

export function screenshotForVariant(
  variant: ScreenVariant,
  index: MapIndex,
): Artifact | undefined {
  const observation = latestObservationForVariant(variant, index);
  return observation?.screenshotArtifactId
    ? index.artifacts.get(observation.screenshotArtifactId)
    : undefined;
}

export function screenshotForScreen(screen: Screen, index: MapIndex): Artifact | undefined {
  const observation = latestObservation(screen, index);
  return observation?.screenshotArtifactId
    ? index.artifacts.get(observation.screenshotArtifactId)
    : undefined;
}

/** The app launch per appearance (`launch:splash`, `launch:splash@dark`): shown with the screens, outside the route graph. */
export function isLaunchScreen(screen: Pick<Screen, "id">): boolean {
  return screen.id === LAUNCH_SURFACE_ID || screen.id.startsWith(`${LAUNCH_SURFACE_ID}@`);
}

/** The order of the Screens canvas and list: the launch first, then by depth, then by title. */
export function screensInListOrder<T extends Pick<Screen, "id" | "depth" | "title">>(screens: readonly T[]): T[] {
  return [...screens].sort(
    (a, b) => Number(isLaunchScreen(b)) - Number(isLaunchScreen(a)) || a.depth - b.depth || a.title.localeCompare(b.title),
  );
}

export function artifactUrl(
  artifact: Artifact | undefined,
  buildId?: string | undefined,
): string | undefined {
  if (!artifact) return undefined;
  if (REPORT_SOURCE.data) return embeddedArtifactUrl(artifact.sha256);
  if (artifact.publicUrl) {
    try {
      const url = new URL(artifact.publicUrl);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
    } catch {
      return undefined;
    }
  }
  const scopedBuildId = buildId
    ?? (artifact as Artifact & { viewerBuildId?: string }).viewerBuildId;
  // Static workspaces publish immutable evidence files next to the workspace payload. Local
  // viewer mode keeps using its authenticated API routes below.
  const staticUrl = staticArtifactUrl(
    artifact.path,
    artifact.sha256,
    scopedBuildId ?? "current",
  );
  if (staticUrl) return staticUrl;
  const path = artifact.path.split("/").map(encodeURIComponent).join("/");
  const endpoint = scopedBuildId
    ? `/api/builds/${encodeURIComponent(scopedBuildId)}/artifacts/${path}`
    : `/api/artifacts/${path}`;
  // Artifact routes are immutable, so the content hash must participate in the URL. A later
  // map revision may legitimately reuse the same relative path for different screenshot bytes.
  return `${endpoint}?sha256=${encodeURIComponent(artifact.sha256)}`;
}

/**
 * Icon-font glyphs live in the Private Use Area, so a tab bar labelled by react-native-vector-icons
 * reads "\ue01d, 排行榜"; the glyph is shown as a box or nothing, so it goes, with the empty slot
 * it leaves in the list.
 */
export function cleanControlLabel(label: string): string {
  return label
    .replace(/[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u3000]|\ufe0e|\ufe0f/gu, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

export function transitionLabel(transition: Transition, index: MapIndex): string {
  const attempt = [...transition.attemptIds]
    .reverse()
    .map((id) => index.attempts.get(id))
    .find(Boolean);
  const action = attempt?.action.label;
  // An action aimed at an identifier (a testID) is named by the control's visible label when the screen recorded one.
  const byId = attempt?.action.elementId ? index.elements.get(attempt.action.elementId) : undefined;
  const element = byId ?? (action
    ? [...index.elements.values()].find((candidate) => candidate.screenId === transition.fromScreenId && candidate.identifier === action)
    : undefined);
  const label = element && action === element.identifier && element.label ? element.label : action;
  return cleanControlLabel(label || transition.selector || "") || transition.actionKind;
}


/**
 * Cover resolved source links without enumerating every combination through branches. Reuse
 * shortest prefixes/suffixes to show complete paths when they fit; each trail stops after 12
 * screens or a cycle closes. Every trail covers a new edge, so repeated context stays bounded
 * by graph size. Isolated context screens remain visible as singletons.
 */
export type {
  ActionAttempt,
  Artifact,
  Coverage,
  ExploreMap,
  Journey,
  Observation,
  Screen,
  ScreenElement,
  ScreenVariant,
  Transition,
};
