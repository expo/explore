import type { ReviewWorkspaceProjection } from "./contracts/review.js";
import type { NavigationGraph } from "./contracts/navigation-graph.js";

export const CONTRACT = "expo.explore.local-map.v1" as const;
export const QUERY_CONTRACT = "expo.explore.query.v1" as const;
export const BUILD_CATALOG_CONTRACT = "expo.explore.build-catalog.v1" as const;
export const BUILD_COMPARISON_CONTRACT = "expo.explore.build-comparison.v1" as const;

export type Platform = "ios" | "android";
export type Controller = "agent-device" | "argent";
export type RunStatus = "draft" | "exploring" | "complete" | "partial" | "failed";
export type ElementRole =
  | "button"
  | "link"
  | "tab"
  | "field"
  | "toggle"
  | "menu-item"
  | "text"
  | "image"
  | "other";
export type ActionKind =
  | "press"
  | "fill"
  | "swipe"
  | "back"
  | "dismiss"
  | "deep-link"
  | "key"
  | "other";
export type ActionRisk = "safe" | "unknown" | "destructive" | "external";
export type ActionOutcome =
  | "transition"
  | "same-screen"
  | "no-change"
  | "failed"
  | "blocked"
  | "external";
export type FrontierStatus = "pending" | "claimed" | "done" | "skipped" | "blocked";
export type SurfaceScope = "app" | "system" | "external";
export type GapStatus = "open" | "accepted" | "resolved";

export type RunLimits = {
  maxScreens: number;
  maxActions: number;
  maxDurationMinutes: number;
};

export type ElementBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: "points" | "pixels" | "normalized";
};

export type BuildProvenance = {
  id?: string;
  version?: string;
  number?: string;
  hash?: string;
  gitCommit?: string;
  source?: "local" | "eas" | "store" | "unknown";
};

export type RunEnvironment = {
  deviceModel?: string;
  osVersion?: string;
  locale?: string;
  orientation?: "portrait" | "landscape";
  colorScheme?: "light" | "dark" | "system";
  /** Every appearance the review captured, when more than one; screens carry their own `colorScheme`. */
  colorSchemes?: ("light" | "dark")[];
  authState?: "logged-out" | "logged-in" | "custom";
  authPersona?: string;
  launchContext?: string;
  instructions?: string;
};

export type ExploreRun = {
  id: string;
  name: string;
  platform: Platform;
  /** Every platform the review captured, when more than one; the Viewer links the sibling report. */
  platforms?: Platform[];
  controller: Controller;
  bundleId?: string;
  deviceId?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  stopReason?: string;
  build: BuildProvenance;
  environment: RunEnvironment;
  limits: RunLimits;
  /** Set only by public review projections: the app's own icon for the Viewer header. */
  appIcon?: Artifact;
  /** "black-box": the app was driven without source, so the map holds only observed screens and taps. */
  exploration?: "black-box";
};

export type Artifact = {
  id: string;
  kind: "screenshot" | "accessibility" | "controller-output" | "video" | "log";
  path: string;
  sha256: string;
  // Public review projections can omit size; recorded local artifacts still require it in schema.
  bytes?: number;
  publicUrl?: string;
  mimeType: string;
  width?: number;
  height?: number;
  createdAt: string;
};

export type InputElement = {
  id?: string;
  identifier?: string;
  role?: ElementRole;
  kind?: ElementRole;
  label?: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  bounds?: ElementBounds;
  selector?: string;
  occurrence?: number;
  actions?: ActionKind[];
  risk?: ActionRisk;
  actionable?: boolean;
};

export type ScreenElement = {
  id: string;
  screenId: string;
  identifier?: string;
  role: ElementRole;
  label: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  bounds?: ElementBounds;
  selector?: string;
  occurrence: number;
  controller: Controller;
  actions: ActionKind[];
  risk: ActionRisk;
  actionable: boolean;
  firstSeenObservationId: string;
  lastSeenObservationId: string;
  observationIds: string[];
};

export type Screen = {
  id: string;
  title: string;
  route?: string;
  /** The appearance this screen was rendered in, when the review captured more than one. */
  colorScheme?: "light" | "dark";
  state?: string;
  start: boolean;
  terminal: boolean;
  depth: number;
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
  variantIds: string[];
  observationIds: string[];
  elementIds: string[];
};

export type ScreenVariant = {
  id: string;
  screenId: string;
  key: string;
  name?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationIds: string[];
};

export type ObservationFingerprints = {
  combined: string;
  accessibility?: string;
  visual?: string;
};

export type ObservedElement = {
  elementId: string;
  identifier?: string;
  role: ElementRole;
  label: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  bounds?: ElementBounds;
  selector?: string;
  occurrence: number;
  controller: Controller;
  actions: ActionKind[];
  risk: ActionRisk;
  actionable: boolean;
};

export type Observation = {
  id: string;
  screenId: string;
  variantId: string;
  fingerprints: ObservationFingerprints;
  capturedAt: string;
  surfaceScope: SurfaceScope;
  elementIds: string[];
  elements: ObservedElement[];
  screenshotArtifactId?: string;
  accessibilityArtifactId?: string;
};

export type ActionInput = {
  value?: string;
  fixture?: string;
  redacted: boolean;
};

export type GestureSpec = {
  direction: "up" | "down" | "left" | "right";
  distance?: number;
};

export type WaitSpec = {
  strategy: "settle" | "duration" | "element";
  durationMs?: number;
  selector?: string;
};

export type ActionSpec = {
  kind: ActionKind;
  label: string;
  elementId?: string;
  selector?: string;
  input?: ActionInput;
  gesture?: GestureSpec;
  deepLink?: string;
  key?: string;
  wait?: WaitSpec;
  expected?: string;
};

export type ActionAttempt = {
  id: string;
  frontierId?: string;
  sourceScreenId: string;
  sourceObservationId: string;
  targetScreenId?: string;
  targetObservationId?: string;
  action: ActionSpec;
  outcome: ActionOutcome;
  risk: ActionRisk;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  reason?: string;
  error?: string;
};

export type Transition = {
  id: string;
  fromScreenId: string;
  toScreenId: string;
  actionKind: ActionKind;
  elementId?: string;
  selector?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  attemptIds: string[];
};

export type FrontierClaim = {
  owner: string;
  claimedAt: string;
  expiresAt: string;
};

export type FrontierItem = {
  id: string;
  screenId: string;
  elementId?: string;
  label: string;
  selector?: string;
  actionKind: ActionKind;
  risk: ActionRisk;
  depth: number;
  priority: number;
  status: FrontierStatus;
  createdAt: string;
  completedAt?: string;
  lastAttemptId?: string;
  reason?: string;
  claim?: FrontierClaim;
};

export type CoverageGap = {
  id: string;
  kind:
    | "controller-parse"
    | "missing-target"
    | "authentication"
    | "unsupported-ui"
    | "connection"
    | "coverage"
    | "other";
  status: GapStatus;
  message: string;
  screenId?: string;
  observationId?: string;
  createdAt: string;
  resolvedAt?: string;
  reason?: string;
};

export type Journey = {
  id: string;
  title: string;
  screenIds: string[];
  transitionIds: string[];
  attemptIds: string[];
  /** A source-derived inventory group, not a journey observed on a simulator. */
  source?: { kind: "structural"; flowId: string; revision: "current" | "baseline" };
};

export type ExploreMap = {
  contract: typeof CONTRACT;
  revision: number;
  run: ExploreRun;
  artifacts: Artifact[];
  screens: Screen[];
  variants: ScreenVariant[];
  observations: Observation[];
  elements: ScreenElement[];
  actionAttempts: ActionAttempt[];
  transitions: Transition[];
  /** Declared routes stay separate from transitions confirmed by exploration. */
  sourceNavigation?: NavigationGraph;
  /** Selected baseline graph, remapped only for the Viewer comparison projection. */
  baselineSourceNavigation?: NavigationGraph;
  journeys: Journey[];
  frontier: FrontierItem[];
  gaps: CoverageGap[];
};

export type Coverage = {
  screens: number;
  variants: number;
  observations: number;
  elements: number;
  transitions: number;
  actions: {
    attempted: number;
    succeeded: number;
    noChange: number;
    failed: number;
    blocked: number;
  };
  frontier: {
    pending: number;
    claimed: number;
    done: number;
    skipped: number;
    blocked: number;
  };
  gaps: {
    open: number;
    accepted: number;
    resolved: number;
  };
  completion: {
    eligible: boolean;
    blockers: string[];
  };
  limits: RunLimits;
  limitReached?: "screens" | "actions" | "duration";
};

/** A viewer-facing build label and the local-map bundle that supplies its evidence. */
export type BuildCatalogBuild = {
  id: string;
  kind: "build";
  version: string;
  mapDir: string;
};

/** A reviewed comparison available between two builds in the catalog. */
export type BuildCatalogComparison = {
  baselineBuildId: string;
  currentBuildId: string;
  path: string;
};

/**
 * A catalog composes independently valid local-map v1 bundles without changing their contract.
 * Build versions here and in each map run are comparison labels. The imported app release remains
 * separate source-inventory/README provenance for static-reference maps.
 */
export type BuildCatalog = {
  contract: typeof BUILD_CATALOG_CONTRACT;
  name: string;
  currentBuildId: string;
  defaultBaselineBuildId: string;
  builds: BuildCatalogBuild[];
  comparisons: BuildCatalogComparison[];
};

export type BuildComparisonRelationship =
  | "one-to-one"
  | "split"
  | "merge"
  | "added"
  | "removed";

export type BuildComparisonStatus = "added" | "modified" | "removed" | "unchanged" | "needs-review" | "source-affected" | "not-compared" | "unavailable" | "variant";

/** One manually reviewed before/after observation pair used as visual comparison evidence. */
export type BuildComparisonRepresentativePair = {
  baselineObservationId: string;
  currentObservationId: string;
  confidence: number;
  rationale: string;
};

/**
 * A cross-build canonical correspondence. Arrays preserve real screen splits and merges while
 * representative observation IDs select the exact captures shown by the viewer.
 */
export type BuildComparisonEntry = {
  id: string;
  relationship: BuildComparisonRelationship;
  status: BuildComparisonStatus;
  /** Concise, user-facing explanation of the material visual or structural change. */
  changeSummary?: string;
  baselineScreenIds: string[];
  currentScreenIds: string[];
  baselineRepresentativeObservationIds: string[];
  currentRepresentativeObservationIds: string[];
  representativePairs: BuildComparisonRepresentativePair[];
  confidence: number;
  rationale: string;
};

export type BuildComparison = {
  contract: typeof BUILD_COMPARISON_CONTRACT;
  baselineBuildId: string;
  currentBuildId: string;
  baselineRunId: string;
  currentRunId: string;
  baselineRevision: number;
  currentRevision: number;
  entries: BuildComparisonEntry[];
};

/** Serializable API representation of a loaded build workspace. */
export type BuildWorkspacePayload = {
  catalog: BuildCatalog;
  builds: Record<string, { map: ExploreMap; coverage: Coverage }>;
  comparison: BuildComparison;
  /** Sanitized, reviewer-facing projection. Raw CI and source-analysis data never belongs here. */
  review?: ReviewWorkspaceProjection;
};
