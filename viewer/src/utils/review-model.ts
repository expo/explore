export type PullRequestRef = {
  ref: string;
  sha: string;
};

export type PullRequestPresentation = {
  /** "compare": two commits reviewed without a pull request; `url` is github.com's compare page and there is no number. */
  origin?: "local" | "compare";
  number?: number | undefined;
  title: string;
  url?: string | undefined;
  base: PullRequestRef;
  head: PullRequestRef;
};

export type ReviewerChangeCategory =
  | "screen"
  | "element"
  | "text"
  | "visible-text"
  | "interaction"
  | "accessibility"
  | "visual";

export type ReviewerChangeFact = {
  id: string;
  category: ReviewerChangeCategory;
  templateId: string;
  bullet?: string;
  subjectRole?: string;
  subjectLabel?: string;
  before?: string;
  after?: string;
  priority: number;
  evidenceRefs: string[];
};

export type EvidenceTone = "success" | "warning" | "danger";

export type RuntimeEvidenceEntry = {
  label: string;
  value: string;
  tone?: EvidenceTone;
  copyable?: boolean;
};

export type RuntimeEvidenceGroupId =
  | "screen"
  | "ui"
  | "interaction"
  | "capture"
  | "environment"
  | "diagnostics";

export type ReviewRuntimeEvidence = {
  id: string;
  buildId?: string;
  screenId?: string;
  observationId?: string;
  variantId?: string;
  side: "baseline" | "current";
  groups: Partial<Record<RuntimeEvidenceGroupId, RuntimeEvidenceEntry[]>>;
};

export type ReviewRuntimeEvidenceComparison = {
  baseline?: ReviewRuntimeEvidence;
  current?: ReviewRuntimeEvidence;
};

/**
 * How far an area's content moved from Before to After when it is otherwise the same: in percent of the image
 * (to place the Before outline) and in the screenshot's own units (to label it). Right and down are positive.
 */
export type RegionMove = { x: number; y: number; amount: { x: number; y: number }; unit: "pt" | "px" };

/** One area of the screenshot that differs, in percent of the image width and height (0–100). */
export type VisualDiffRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** This region's share of all differing pixels, in percent. */
  share: number;
  /** Set when the area only moved; absent when its content changed. */
  move?: RegionMove;
};

/** The CI pixel comparison of the before and after screenshots. */
export type ReviewVisualDiff = {
  mismatchPercentage?: number;
  regions: VisualDiffRegion[];
  /** Every region CI found only moved, including ones the report leaves out: nothing on the screen changed content. */
  allRegionsMoved?: true;
  /** Diff regions inside the status-bar band that CI left out of the verdict. */
  ignoredStatusBarRegions?: number;
  /** Diff regions inside the home-indicator band (iOS, bottom) that CI left out of the verdict. */
  ignoredHomeIndicatorRegions?: number;
};

/** Why a side that exists in its revision has no screenshot, as the report states it. */
export type CaptureNotes = { before?: string; after?: string };

export type ReviewSurface = {
  /** Optional explanation; deterministic verdicts and facts retain their own fields. */
  note?: string;
  visual?: ReviewVisualDiff;
  captureNotes?: CaptureNotes;
  reviewerChanges: ReviewerChangeFact[];
  runtimeEvidenceRefs: string[];
  noVisibleChange: boolean;
  /** CI compared both verified screenshots and found no pixel difference: anything that changed is in the accessibility tree. */
  pixelsUnchanged?: true;
  /** Route this surface declares instead of rendering a screen of its own. */
  redirectTo?: string;
  /** Every route the declaration can reach; more than one means app state chooses. */
  redirectTargets?: string[];
  /** The route file that declares this surface (`src/app/(tabs)/index.tsx`), when the review read the source. */
  routeFile?: string;
};

export type ViewerReviewProjection = {
  pullRequest?: PullRequestPresentation;
  surfaces: Record<string, ReviewSurface>;
  runtimeEvidence: Record<string, ReviewRuntimeEvidenceComparison>;
};

const CATEGORIES = new Set<ReviewerChangeCategory>([
  "screen",
  "element",
  "text",
  "visible-text",
  "interaction",
  "accessibility",
  "visual",
]);
const GROUPS = new Set<RuntimeEvidenceGroupId>([
  "screen",
  "ui",
  "interaction",
  "capture",
  "environment",
  "diagnostics",
]);
const TONES = new Set<EvidenceTone>(["success", "warning", "danger"]);
const DIAGNOSTIC_KEYS = new Set(["code", "title", "value", "origin"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const string = nonEmptyString(entry);
    return string ? [string] : [];
  });
}

function pullRequestRef(value: unknown): PullRequestRef | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const ref = nonEmptyString(candidate.ref);
  const sha = nonEmptyString(candidate.sha);
  return ref && sha ? { ref, sha } : undefined;
}

/** github.com's two-dot compare page for exactly these two commits, or nothing. */
function githubCompareUrl(value: unknown, baseSha: string, headSha: string): string | undefined {
  const string = nonEmptyString(value);
  if (!string) return undefined;
  try {
    const url = new URL(string);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash
      || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/compare\/[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(url.pathname)
      || !url.pathname.endsWith(`/compare/${baseSha}..${headSha}`)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function githubPullRequestUrl(value: unknown, number: number): string | undefined {
  const string = nonEmptyString(value);
  if (!string) return undefined;
  try {
    const url = new URL(string);
    const normalizedPath = url.pathname.replace(/\/$/, "");
    if (
      url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.username
      || url.password
      || url.search
      || url.hash
      || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(normalizedPath)
      || !normalizedPath.endsWith(`/pull/${number}`)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function pullRequest(value: unknown): PullRequestPresentation | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  if (candidate.origin === "compare") {
    const title = nonEmptyString(candidate.title);
    const base = pullRequestRef(candidate.base);
    const head = pullRequestRef(candidate.head);
    const url = base && head ? githubCompareUrl(candidate.url, base.sha, head.sha) : undefined;
    return title && base && head && url ? { origin: "compare", title, url, base, head } : undefined;
  }
  const number = candidate.number;
  if (!Number.isSafeInteger(number) || (number as number) <= 0) return undefined;
  const title = nonEmptyString(candidate.title);
  const base = pullRequestRef(candidate.base);
  const head = pullRequestRef(candidate.head);
  const url = githubPullRequestUrl(candidate.url, number as number);
  return title && base && head && url
    ? { number: number as number, title, url, base, head }
    : undefined;
}

function reviewerChange(value: unknown, position: number): ReviewerChangeFact | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const category = nonEmptyString(candidate.category) as ReviewerChangeCategory | undefined;
  const templateId = nonEmptyString(candidate.templateId);
  if (!category || !CATEGORIES.has(category) || !templateId) return undefined;
  const id = nonEmptyString(candidate.id) ?? `${category}:${templateId}:${position}`;
  const priority = typeof candidate.priority === "number" && Number.isFinite(candidate.priority)
    ? candidate.priority
    : 0;
  const bullet = nonEmptyString(candidate.bullet);
  const subjectRole = nonEmptyString(candidate.subjectRole);
  const subjectLabel = nonEmptyString(candidate.subjectLabel);
  const before = nonEmptyString(candidate.before);
  const after = nonEmptyString(candidate.after);
  return {
    id,
    category,
    templateId,
    priority,
    evidenceRefs: stringArray(candidate.evidenceRefs),
    ...(bullet ? { bullet } : {}),
    ...(subjectRole ? { subjectRole } : {}),
    ...(subjectLabel ? { subjectLabel } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

const MAX_VISUAL_REGIONS = 64;

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function visualDiffRegion(value: unknown): VisualDiffRegion | undefined {
  const candidate = record(value);
  const [x, y, width, height, share] = ["x", "y", "width", "height", "share"].map((key) => percent(candidate?.[key]));
  if (x === undefined || y === undefined || width === undefined || height === undefined || share === undefined) return undefined;
  if (width <= 0 || height <= 0 || x + width > 100.01 || y + height > 100.01) return undefined;
  const move = regionMove(candidate?.move);
  return { x, y, width, height, share, ...(move ? { move } : {}) };
}

function regionMove(value: unknown): RegionMove | undefined {
  const candidate = record(value);
  const amount = record(candidate?.amount);
  const finite = (entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 100;
  if (!candidate || !amount || !finite(candidate.x) || !finite(candidate.y) || !finite(amount.x) || !finite(amount.y)
    || (candidate.unit !== "pt" && candidate.unit !== "px")) return undefined;
  return { x: candidate.x, y: candidate.y, amount: { x: amount.x, y: amount.y }, unit: candidate.unit };
}

export function visualDiff(value: unknown): ReviewVisualDiff | undefined {
  const candidate = record(value);
  if (!candidate || !Array.isArray(candidate.regions)) return undefined;
  const regions = candidate.regions.slice(0, MAX_VISUAL_REGIONS).flatMap((entry) => {
    const region = visualDiffRegion(entry);
    return region ? [region] : [];
  });
  const mismatchPercentage = percent(candidate.mismatchPercentage);
  const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
  const ignoredStatusBarRegions = count(candidate.ignoredStatusBarRegions);
  const ignoredHomeIndicatorRegions = count(candidate.ignoredHomeIndicatorRegions);
  return {
    regions,
    ...(candidate.allRegionsMoved === true && regions.length > 0 && regions.every((region) => region.move) ? { allRegionsMoved: true as const } : {}),
    ...(mismatchPercentage !== undefined ? { mismatchPercentage } : {}),
    ...(ignoredStatusBarRegions !== undefined ? { ignoredStatusBarRegions } : {}),
    ...(ignoredHomeIndicatorRegions !== undefined ? { ignoredHomeIndicatorRegions } : {}),
  };
}

const MAX_CAPTURE_NOTE_LENGTH = 200;

export function captureNotes(value: unknown): CaptureNotes | undefined {
  const candidate = record(value);
  const note = (key: "before" | "after") => {
    const text = nonEmptyString(candidate?.[key]);
    return text && text.length <= MAX_CAPTURE_NOTE_LENGTH ? text : undefined;
  };
  const before = note("before");
  const after = note("after");
  return before || after ? { ...(before ? { before } : {}), ...(after ? { after } : {}) } : undefined;
}

function reviewSurface(value: unknown): ReviewSurface | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const whatChanged = record(candidate.whatChanged);
  const facts = whatChanged?.facts ?? candidate.reviewerChanges;
  const reviewerChanges = Array.isArray(facts)
    ? facts.flatMap((entry, index) => {
      const change = reviewerChange(entry, index);
      return change ? [change] : [];
    })
    : [];
  const runtimeEvidenceRef = nonEmptyString(candidate.runtimeEvidenceRef);
  const note = nonEmptyString(candidate.note);
  const visual = visualDiff(candidate.visual);
  const notes = captureNotes(candidate.captureNotes);
  return {
    ...(note ? { note } : {}),
    ...(visual ? { visual } : {}),
    ...(notes ? { captureNotes: notes } : {}),
    reviewerChanges,
    runtimeEvidenceRefs: runtimeEvidenceRef
      ? [runtimeEvidenceRef]
      : stringArray(candidate.runtimeEvidenceRefs),
    noVisibleChange: whatChanged?.noVisibleChange === true,
    ...(nonEmptyString(candidate.redirectTo) ? { redirectTo: nonEmptyString(candidate.redirectTo)! } : {}),
    ...(stringArray(candidate.redirectTargets).length ? { redirectTargets: stringArray(candidate.redirectTargets) } : {}),
  };
}

function evidenceEntry(value: unknown): RuntimeEvidenceEntry | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const label = nonEmptyString(candidate.label);
  const entryValue = nonEmptyString(candidate.value);
  if (!label || !entryValue) return undefined;
  const tone = nonEmptyString(candidate.tone) as EvidenceTone | undefined;
  return {
    label,
    value: entryValue,
    ...(tone && TONES.has(tone) ? { tone } : {}),
    ...(candidate.copyable === true ? { copyable: true } : {}),
  };
}

/**
 * Diagnostics are authoritative only in this closed, runtime-derived vocabulary. The viewer
 * intentionally does not render generic evidence rows here: that would turn a hosted review
 * document into a raw-log, URL, credential, or arbitrary-prose display channel.
 */
function diagnosticEvidenceEntry(value: unknown): RuntimeEvidenceEntry | undefined {
  const candidate = record(value);
  if (
    !candidate
    || Object.keys(candidate).length !== DIAGNOSTIC_KEYS.size
    || Object.keys(candidate).some((key) => !DIAGNOSTIC_KEYS.has(key))
  ) return undefined;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const title = typeof candidate.title === "string" ? candidate.title : undefined;
  const entryValue = typeof candidate.value === "string" ? candidate.value : undefined;
  const origin = typeof candidate.origin === "string" ? candidate.origin : undefined;
  if (!code || !title || !entryValue || !origin) return undefined;

  const presented = (
    expectedTitle: string,
    expectedValue: string,
    expectedOrigin: string,
    displayValue: string,
    tone: EvidenceTone = "warning",
  ): RuntimeEvidenceEntry | undefined => (
    title === expectedTitle && entryValue === expectedValue && origin === expectedOrigin
      ? { label: title, value: `${displayValue} · ${origin}`, tone }
      : undefined
  );

  switch (code) {
    case "capture.sample-plan":
      if (entryValue === "single") {
        return presented("Capture sample plan", "single", "capture-context", "Single sample");
      }
      if (entryValue === "triple") {
        return presented("Capture sample plan", "triple", "capture-context", "Three samples");
      }
      return undefined;
    case "capture.sample-shortfall":
      return presented("Capture sample anomaly", "shortfall", "derived", "Shortfall");
    case "capture.stability-unstable":
      return presented("Capture stability anomaly", "unstable", "derived", "Unstable");
    case "ui.accessibility-truncated":
      return presented(
        "Accessibility snapshot truncated",
        "truncated",
        "eas-agent-device",
        "Truncated",
      );
    case "ui.accessibility-empty":
      return presented("Accessibility snapshot empty", "empty", "derived", "Empty");
    case "interaction.failed":
      return presented(
        "Interaction failed",
        "failed",
        "eas-agent-device",
        "Failed",
        "danger",
      );
    case "interaction.blocked":
      return presented("Interaction blocked", "blocked", "eas-agent-device", "Blocked");
    default:
      return undefined;
  }
}

function flattenedRuntimeEvidence(value: unknown): ReviewRuntimeEvidence | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const id = nonEmptyString(candidate.id);
  const buildId = nonEmptyString(candidate.buildId);
  const screenId = nonEmptyString(candidate.screenId);
  const side = candidate.side === "baseline" || candidate.side === "current"
    ? candidate.side
    : undefined;
  if (!id || !buildId || !screenId || !side) return undefined;
  const rawGroups = record(candidate.groups) ?? {};
  const groups: ReviewRuntimeEvidence["groups"] = {};
  for (const [groupId, entries] of Object.entries(rawGroups)) {
    if (!GROUPS.has(groupId as RuntimeEvidenceGroupId) || !Array.isArray(entries)) continue;
    groups[groupId as RuntimeEvidenceGroupId] = entries.flatMap((entry) => {
      const parsed = groupId === "diagnostics"
        ? diagnosticEvidenceEntry(entry)
        : evidenceEntry(entry);
      return parsed ? [parsed] : [];
    });
    if (groupId === "diagnostics" && groups.diagnostics?.length === 0) {
      delete groups.diagnostics;
    }
  }
  const observationId = nonEmptyString(candidate.observationId);
  const variantId = nonEmptyString(candidate.variantId);
  return {
    id,
    buildId,
    screenId,
    side,
    groups,
    ...(observationId ? { observationId } : {}),
    ...(variantId ? { variantId } : {}),
  };
}

function evidenceFieldValue(value: unknown, key: string): unknown {
  return record(record(value)?.[key])?.value;
}

function numberValue(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function booleanText(value: unknown): string | undefined {
  return typeof value === "boolean" ? (value ? "Yes" : "No") : undefined;
}

function labeledValues(value: unknown, labelKey: string, valueKey: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value.flatMap((entry) => {
    const candidate = record(entry);
    const label = nonEmptyString(candidate?.[labelKey]);
    const count = numberValue(candidate?.[valueKey]);
    return label && count ? [`${label} ${count}`] : [];
  });
  return labels.length > 0 ? labels.join(" · ") : "None recorded";
}

function authoritativeRuntimeEvidence(
  ref: string,
  value: unknown,
  side: "baseline" | "current",
): ReviewRuntimeEvidence | undefined {
  const candidate = record(value);
  const rawGroups = record(candidate?.groups);
  const screen = record(rawGroups?.screen);
  const ui = record(rawGroups?.ui);
  const interaction = record(rawGroups?.interaction);
  const capture = record(rawGroups?.capture);
  const environment = record(rawGroups?.environment);
  if (!candidate || !rawGroups || !screen || !ui || !interaction || !capture || !environment) {
    return undefined;
  }

  const logicalBuild = nonEmptyString(evidenceFieldValue(screen, "logicalBuild"));
  const surfaceId = nonEmptyString(evidenceFieldValue(screen, "surfaceId"));
  const observationId = nonEmptyString(evidenceFieldValue(screen, "observationId"));
  const variantId = nonEmptyString(evidenceFieldValue(screen, "variantId"));
  const groups: ReviewRuntimeEvidence["groups"] = {};

  const screenEntries: RuntimeEvidenceEntry[] = [];
  for (const [label, key, copyable] of [
    ["Route", "route", true],
    ["Surface", "surfaceId", true],
    ["State", "state", false],
    ["Variant", "variantId", true],
    ["Observation", "observationId", true],
    ["Surface scope", "surfaceScope", false],
    ["Captured", "capturedAt", false],
    ["Logical build", "logicalBuild", true],
  ] as const) {
    const entryValue = nonEmptyString(evidenceFieldValue(screen, key));
    if (entryValue) screenEntries.push({ label, value: entryValue, ...(copyable ? { copyable: true } : {}) });
  }
  groups.screen = screenEntries;

  const roleCounts = labeledValues(evidenceFieldValue(ui, "roleCounts"), "role", "count");
  const landmarkValues = evidenceFieldValue(ui, "landmarks");
  const landmarks = Array.isArray(landmarkValues)
    ? landmarkValues.flatMap((entry) => {
      const label = nonEmptyString(record(entry)?.label);
      return label ? [label] : [];
    }).join(" · ") || "None recorded"
    : undefined;
  const uiEntries: RuntimeEvidenceEntry[] = [];
  const elementCount = numberValue(evidenceFieldValue(ui, "elementCount"));
  const actionableCount = numberValue(evidenceFieldValue(ui, "actionableCount"));
  const snapshotQuality = nonEmptyString(evidenceFieldValue(ui, "snapshotQuality"));
  const truncated = booleanText(evidenceFieldValue(ui, "truncated"));
  if (elementCount) uiEntries.push({ label: "Elements", value: elementCount });
  if (actionableCount) uiEntries.push({ label: "Actionable", value: actionableCount });
  if (roleCounts) uiEntries.push({ label: "Roles", value: roleCounts });
  if (landmarks) uiEntries.push({ label: "Landmarks", value: landmarks });
  if (snapshotQuality) uiEntries.push({ label: "Snapshot quality", value: snapshotQuality });
  if (truncated) uiEntries.push({ label: "Truncated", value: truncated });
  groups.ui = uiEntries;

  const attemptValues = evidenceFieldValue(interaction, "attempts");
  const attempts = Array.isArray(attemptValues) ? attemptValues : [];
  const interactionEntries: RuntimeEvidenceEntry[] = [
    { label: "Attempts", value: String(attempts.length) },
  ];
  attempts.forEach((entry, index) => {
    const attempt = record(entry);
    const label = nonEmptyString(attempt?.label) ?? nonEmptyString(attempt?.action) ?? "Action";
    const outcome = nonEmptyString(attempt?.outcome) ?? "outcome not recorded";
    const target = nonEmptyString(record(attempt?.target)?.route);
    const duration = numberValue(attempt?.durationMs);
    interactionEntries.push({
      label: `Attempt ${index + 1}`,
      value: `${label} · ${outcome}${target ? ` → ${target}` : ""}${duration ? ` · ${duration}ms` : ""}`,
    });
  });
  const transitionCount = numberValue(evidenceFieldValue(interaction, "transitionCount"));
  if (transitionCount) interactionEntries.push({ label: "Transitions", value: transitionCount });
  groups.interaction = interactionEntries;

  const sampleValues = evidenceFieldValue(capture, "samples");
  const samples = Array.isArray(sampleValues) ? sampleValues : [];
  const captureEntries: RuntimeEvidenceEntry[] = [];
  const sampleCount = numberValue(evidenceFieldValue(capture, "sampleCount"));
  const stability = nonEmptyString(evidenceFieldValue(capture, "stability"));
  const dimensionsValue = evidenceFieldValue(capture, "dimensions");
  const dimensions = Array.isArray(dimensionsValue)
    ? dimensionsValue.flatMap((entry) => {
      const width = numberValue(record(entry)?.widthPixels);
      const height = numberValue(record(entry)?.heightPixels);
      return width && height ? [`${width} × ${height}px`] : [];
    })
    : [];
  const densitiesValue = evidenceFieldValue(capture, "pixelDensities");
  const densities = Array.isArray(densitiesValue)
    ? densitiesValue.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];
  const coverage = record(evidenceFieldValue(capture, "coverage"));
  if (sampleCount) captureEntries.push({ label: "Samples", value: sampleCount });
  if (stability) captureEntries.push({ label: "Stability", value: stability });
  if (dimensions.length > 0) captureEntries.push({ label: "Dimensions", value: [...new Set(dimensions)].join(" · ") });
  if (densities.length > 0) captureEntries.push({ label: "Pixel density", value: [...new Set(densities)].join(" · ") });
  const expected = numberValue(coverage?.expected);
  const captured = numberValue(coverage?.captured);
  if (expected && captured) captureEntries.push({ label: "Coverage", value: `${captured} / ${expected}` });
  const representative = record(samples[0]);
  const fingerprints = record(representative?.fingerprints);
  const combined = nonEmptyString(fingerprints?.combined);
  const visual = nonEmptyString(fingerprints?.visual);
  const accessibility = nonEmptyString(fingerprints?.accessibility);
  if (combined) captureEntries.push({ label: "Combined fingerprint", value: combined, copyable: true });
  if (visual) captureEntries.push({ label: "Visual fingerprint", value: visual, copyable: true });
  if (accessibility) captureEntries.push({ label: "Accessibility fingerprint", value: accessibility, copyable: true });
  groups.capture = captureEntries;

  const environmentEntries: RuntimeEvidenceEntry[] = [];
  for (const [label, key] of [
    ["Profile", "profile"],
    ["Fixture persona", "fixturePersona"],
    ["Provider", "provider"],
    ["Controller", "controller"],
    ["Platform", "platform"],
    ["Device", "deviceModel"],
    ["OS", "osVersion"],
    ["Locale", "locale"],
    ["Orientation", "orientation"],
    ["Color scheme", "colorScheme"],
    ["Session lifecycle", "sessionLifecycle"],
  ] as const) {
    const entryValue = nonEmptyString(evidenceFieldValue(environment, key));
    if (entryValue) environmentEntries.push({ label, value: entryValue });
  }
  groups.environment = environmentEntries;

  const diagnostics = record(rawGroups.diagnostics);
  const diagnosticsEntries = diagnostics?.entries;
  if (Array.isArray(diagnosticsEntries) && diagnosticsEntries.length > 0) {
    groups.diagnostics = diagnosticsEntries.flatMap((entry) => {
      const parsed = diagnosticEvidenceEntry(entry);
      return parsed ? [parsed] : [];
    });
    if (groups.diagnostics.length === 0) delete groups.diagnostics;
  }

  return {
    id: `${ref}:${side}`,
    side,
    groups,
    ...(logicalBuild ? { buildId: logicalBuild } : {}),
    ...(surfaceId ? { screenId: surfaceId } : {}),
    ...(observationId ? { observationId } : {}),
    ...(variantId ? { variantId } : {}),
  };
}

function runtimeEvidenceComparison(
  key: string,
  value: unknown,
): ReviewRuntimeEvidenceComparison | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const contract = nonEmptyString(candidate.contract);
  if (contract === "expo.explore.runtime-evidence-comparison.v0") {
    const baseline = candidate.base
      ? authoritativeRuntimeEvidence(key, candidate.base, "baseline")
      : undefined;
    const current = candidate.head
      ? authoritativeRuntimeEvidence(key, candidate.head, "current")
      : undefined;
    if (!baseline && !current) return undefined;
    return {
      ...(baseline ? { baseline } : {}),
      ...(current ? { current } : {}),
    };
  }
  const flattened = flattenedRuntimeEvidence(value);
  return flattened ? { [flattened.side]: flattened } : undefined;
}

/**
 * The review projection is an optional, sanitized workspace extension. Treat it as untrusted
 * input even when it came from the authenticated host: malformed metadata must disappear rather
 * than becoming a convincing fake PR or evidence row.
 */
export function reviewProjectionFromWorkspace(workspace: unknown): ViewerReviewProjection | undefined {
  const rawReview = record(record(workspace)?.review);
  if (!rawReview) return undefined;
  const rawSurfaces = record(rawReview.surfaces) ?? {};
  const surfaces = Object.fromEntries(Object.entries(rawSurfaces).flatMap(([id, value]) => {
    const surface = reviewSurface(value);
    return surface ? [[id, surface]] : [];
  }));
  const rawEvidence = record(rawReview.runtimeEvidence) ?? {};
  const normalizedEvidence = Object.fromEntries(Object.entries(rawEvidence).flatMap(([key, value]) => {
    const evidence = runtimeEvidenceComparison(key, value);
    return evidence ? [[key, evidence]] : [];
  }));
  const normalizedPullRequest = pullRequest(rawReview.pullRequest);
  return {
    surfaces,
    runtimeEvidence: normalizedEvidence,
    ...(normalizedPullRequest ? { pullRequest: normalizedPullRequest } : {}),
  };
}

export function reviewSurfaceFor(
  review: ViewerReviewProjection | undefined,
  ids: readonly (string | undefined)[],
): ReviewSurface | undefined {
  if (!review) return undefined;
  for (const id of ids) {
    if (id && review.surfaces[id]) return review.surfaces[id];
  }
  return undefined;
}

const CATEGORY_ORDER: Record<ReviewerChangeCategory, number> = {
  screen: 0,
  element: 1,
  text: 2,
  "visible-text": 2,
  interaction: 3,
  accessibility: 4,
  visual: 5,
};

export function sortReviewerChanges(changes: readonly ReviewerChangeFact[]): ReviewerChangeFact[] {
  return [...changes].sort((left, right) => (
    left.priority - right.priority
    || CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    || left.id.localeCompare(right.id)
  ));
}

function quote(value: string): string {
  return `"${value.replaceAll("\"", "\\\"")}"`;
}

function subject(fact: ReviewerChangeFact, fallback: string): string {
  return fact.subjectLabel ? quote(fact.subjectLabel) : fallback;
}

function normalizedTemplateId(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replaceAll("_", ".").replaceAll("-", ".");
}

/** Deterministic reviewer copy. Unknown or incomplete templates fail closed. */
export function formatReviewerChange(fact: ReviewerChangeFact): string | undefined {
  if (fact.bullet) return fact.bullet;
  const template = normalizedTemplateId(fact.templateId);
  if (template === "screen.added") {
    return `Added screen ${subject(fact, "screen")}.`;
  }
  if (template === "screen.removed") {
    return `Removed screen ${subject(fact, "screen")}.`;
  }
  if (template === "element.added") {
    return `Added ${fact.subjectRole ?? "element"} ${subject(fact, "element")}.`;
  }
  if (template === "element.removed") {
    return `Removed ${fact.subjectRole ?? "element"} ${subject(fact, "element")}.`;
  }
  if (template === "text.changed" && fact.before && fact.after) {
    const kind = fact.subjectRole === "button"
      ? "button title"
      : fact.subjectRole === "heading"
        ? "heading"
        : fact.subjectRole === "tab"
          ? "tab title"
          : "text";
    return `Changed ${kind} from ${quote(fact.before)} to ${quote(fact.after)}.`;
  }
  if (template === "body.updated") {
    return `Updated body copy in ${subject(fact, "this screen")}.`;
  }
  if (template === "interaction.target.changed" && fact.after) {
    return `Changed ${subject(fact, "this action")} action to open ${quote(fact.after)}.`;
  }
  if (template === "interaction.removed") {
    return `Removed the action that opened ${subject(fact, "the previous destination")}.`;
  }
  if (template === "accessibility.label.changed" && fact.before && fact.after) {
    return `Changed accessibility label from ${quote(fact.before)} to ${quote(fact.after)}.`;
  }
  if (template === "accessibility.role.changed" && fact.before && fact.after) {
    return `Changed ${subject(fact, "this element")} from a ${fact.before} to a ${fact.after}.`;
  }
  if (template === "visual.updated") {
    return `Updated the visual appearance of ${subject(fact, "this screen")}.`;
  }
  if (template === "visual.region.updated") {
    return `Updated visual styling in ${subject(fact, "the main content area")}.`;
  }
  return undefined;
}

