import type {
  ReviewerChangeInput,
  ReviewerSubjectRole,
  SupportedReviewerChange,
  VisualReviewerChange,
} from "./reviewer-changes.js";
import {
  RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
  type RuntimeEvidence,
  type RuntimeEvidenceComparison,
} from "./runtime-evidence.js";
import type {
  ActionAttempt,
  ElementRole,
  ExploreMap,
  Observation,
  ObservedElement,
  Screen,
} from "../types.js";
import type { VisualDiffRegion, VisualEvidenceAssessment } from "./visual-evidence.js";
import { CAPTURE_OBSERVER_IDENTIFIER, parseCaptureDestination } from "../capture/observer.js";

export type StableReviewerElementAnnotation = {
  identifier: string;
  role: ElementRole;
  textSource: "visible-title";
  subjectLabel?: string;
};

export type MatchedSurfaceSide = {
  map: ExploreMap;
  observationId: string;
  runtimeEvidence: RuntimeEvidence;
  reviewerAnnotations?: readonly StableReviewerElementAnnotation[];
  /**
   * The controller backend that produced this capture's accessibility snapshot, when known.
   * agent-device 0.21.x serves some snapshots from its host AX bridge and others from XCTest,
   * and the two describe the same screen with different containers and text roles.
   */
  snapshotBackend?: string;
};

/** Source selection context for the observed screen pair. */
export type ComparatorSurfaceImpact = {
  id: string;
  route: string;
  presence: "base-only" | "head-only" | "both";
  reasons: string[];
  baseSamples: 0 | 1 | 3;
  headSamples: 0 | 1 | 3;
};

type ImpactWithPresence<Presence extends ComparatorSurfaceImpact["presence"]> =
  Omit<ComparatorSurfaceImpact, "presence"> & { presence: Presence };

export type AddedSurfaceComparatorInput = {
  impact: ImpactWithPresence<"head-only">;
  head: MatchedSurfaceSide;
};

export type RemovedSurfaceComparatorInput = {
  impact: ImpactWithPresence<"base-only">;
  base: MatchedSurfaceSide;
};

export type CommonSurfaceComparatorInput = {
  impact: ImpactWithPresence<"both">;
  base: MatchedSurfaceSide;
  head: MatchedSurfaceSide;
  visualAssessment: VisualEvidenceAssessment;
  /** Explicit stable runtime scope; semantic meaning is never inferred from diff pixels. */
  visualScope?: VisualReviewerChange["scope"];
  /**
   * The screen's other appearances, captured and verified on both builds. A label that varies between each build's own
   * captures, in the words that differ between the builds, is runtime state, and its difference is reported as such.
   */
  siblings?: readonly { base: MatchedSurfaceSide; head: MatchedSurfaceSide }[];
};

export type EvidenceComparatorInput =
  | AddedSurfaceComparatorInput
  | RemovedSurfaceComparatorInput
  | CommonSurfaceComparatorInput;

export type CanonicalSurfaceStatus = "added" | "removed" | "modified" | "unchanged";

export type EvidenceComparatorResult = {
  surfaceId: string;
  status: CanonicalSurfaceStatus;
  needsReview: boolean;
  reviewReasons: string[];
  runtimeEvidence: RuntimeEvidenceComparison;
  visualAssessment?: VisualEvidenceAssessment;
  /** Feed directly to summarizeReviewerChanges. */
  reviewerChanges: ReviewerChangeInput[];
};

type SupportedInput = Extract<ReviewerChangeInput, { assessment: "supported" }>;
type IssueInput = Exclude<ReviewerChangeInput, SupportedInput>;

type ResolvedSide = {
  side: "base" | "head";
  snapshotBackend?: string;
  map: ExploreMap;
  screen: Screen;
  observation: Observation;
  runtimeEvidence: RuntimeEvidence;
  elements: ObservedElement[];
  annotationsByElementId: Map<string, StableReviewerElementAnnotation>;
  issues: IssueInput[];
};

type SideResolution =
  | { kind: "resolved"; side: ResolvedSide }
  | { kind: "missing"; issues: IssueInput[] };

type ElementPair = {
  base: ObservedElement;
  head: ObservedElement;
  method: "identifier" | "selector-occurrence" | "role-label";
};

type ElementPairing = {
  pairs: ElementPair[];
  removed: ObservedElement[];
  added: ObservedElement[];
  issues: IssueInput[];
};

type ActionTarget = {
  route: string;
  display: string;
  evidenceRefs: string[];
};

type ActionTargetAssessment =
  | { kind: "none"; evidenceRefs: string[] }
  | { kind: "target"; target: ActionTarget }
  | { kind: "inconclusive"; issue: IssueInput };

const CHANGE_PRIORITY: Record<SupportedReviewerChange["kind"], number> = {
  "screen-added": 10,
  "screen-removed": 10,
  "element-added": 20,
  "element-removed": 20,
  "visible-text-changed": 30,
  "unstable-text": 35,
  "action-target-changed": 40,
  "accessibility-label-changed": 50,
  "accessibility-role-changed": 50,
  "visual-changed": 60,
  "no-visible-change": 70,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function evidenceRef(side: "base" | "head", kind: string, id: string): string {
  return `${side}:${kind}:${id}`;
}

function observationRef(side: "base" | "head", observation: Observation): string {
  return evidenceRef(side, "observation", observation.id);
}

function elementRef(side: "base" | "head", element: ObservedElement): string {
  return evidenceRef(side, "element", element.elementId);
}

function captureRef(side: "base" | "head", observation: Observation): string {
  return evidenceRef(side, "capture", observation.id);
}

function visualRef(surfaceId: string, assessment: VisualEvidenceAssessment): string {
  return `visual:${surfaceId}:${assessment.reason}`;
}

function supported(
  change: SupportedReviewerChange,
  evidenceRefs: readonly string[],
): SupportedInput {
  return {
    assessment: "supported",
    change,
    evidenceRefs: [...new Set(evidenceRefs)].sort(compareText),
  };
}

function inconclusive(reason: string, evidenceRefs: readonly string[] = []): IssueInput {
  return {
    assessment: "inconclusive",
    reason,
    ...(evidenceRefs.length === 0
      ? {}
      : { evidenceRefs: [...new Set(evidenceRefs)].sort(compareText) }),
  };
}

function factKey(input: SupportedInput): string {
  return JSON.stringify(input.change);
}

function issueKey(input: IssueInput): string {
  return JSON.stringify([
    input.assessment,
    compact(input.reason),
    [...(input.evidenceRefs ?? [])].sort(compareText),
  ]);
}

function normalizeResults(
  facts: readonly SupportedInput[],
  issues: readonly IssueInput[],
): ReviewerChangeInput[] {
  const factsByKey = new Map<string, SupportedInput>();
  for (const fact of facts) {
    const key = factKey(fact);
    const previous = factsByKey.get(key);
    factsByKey.set(key, previous
      ? supported(fact.change, [...previous.evidenceRefs, ...fact.evidenceRefs])
      : fact);
  }
  const issuesByKey = new Map(issues.map((issue) => [issueKey(issue), issue]));
  return [
    ...[...factsByKey.values()].sort((left, right) => (
      CHANGE_PRIORITY[left.change.kind] - CHANGE_PRIORITY[right.change.kind]
      || compareText(factKey(left), factKey(right))
    )),
    ...[...issuesByKey.values()].sort((left, right) => compareText(issueKey(left), issueKey(right))),
  ];
}

/** Capture verification metadata is excluded from both UI and runtime projections. */
const CAPTURE_METADATA_IDENTIFIERS = new Set(["expo-explore-route", CAPTURE_OBSERVER_IDENTIFIER]);

/** A node the controller named after its own kind, such as an image labelled "image", carries
    no reviewer-facing name, and platforms expose such nodes inconsistently between captures. */
function roleEcho(element: ObservedElement): boolean {
  const label = compact(element.label).toLowerCase();
  return label === "" || label === element.role || label === element.role.replace(/-/g, " ");
}

/** XCTest also exposes the route observer's wrapper: no identifier, but the observer's label. */
function observerWrapper(element: ObservedElement): boolean {
  return !element.identifier && element.label.startsWith("{") && parseCaptureDestination(element.label) !== null;
}

function visibleElements(observation: Observation): ObservedElement[] {
  return observation.elements
    .filter((element) => element.visible !== false)
    .filter((element) => !CAPTURE_METADATA_IDENTIFIERS.has(element.identifier ?? "") && !observerWrapper(element))
    .filter((element) => !roleEcho(element) || Boolean(compact(element.identifier ?? "")))
    .sort((left, right) => compareText(left.elementId, right.elementId));
}

function roleCounts(elements: readonly ObservedElement[]): Map<ElementRole, number> {
  const counts = new Map<ElementRole, number>();
  for (const element of elements) counts.set(element.role, (counts.get(element.role) ?? 0) + 1);
  return counts;
}

function validateRuntimeProjection(
  side: "base" | "head",
  elements: readonly ObservedElement[],
  runtimeEvidence: RuntimeEvidence,
  observation: Observation,
): IssueInput[] {
  const issues: IssueInput[] = [];
  const refs = [observationRef(side, observation)];
  if (runtimeEvidence.groups.ui.elementCount.value !== elements.length) {
    issues.push(inconclusive(
      `${side} UI element count does not match the selected observation.`,
      refs,
    ));
  }
  const expectedRoles = roleCounts(elements);
  const actualRoles = new Map(
    runtimeEvidence.groups.ui.roleCounts.value.map((entry) => [entry.role, entry.count]),
  );
  const roles = new Set([...expectedRoles.keys(), ...actualRoles.keys()]);
  if ([...roles].some((role) => expectedRoles.get(role) !== actualRoles.get(role))) {
    issues.push(inconclusive(
      `${side} UI role counts do not match the selected observation.`,
      refs,
    ));
  }
  return issues;
}

function indexAnnotations(
  side: "base" | "head",
  elements: readonly ObservedElement[],
  annotations: readonly StableReviewerElementAnnotation[],
): { annotations: Map<string, StableReviewerElementAnnotation>; issues: IssueInput[] } {
  const result = new Map<string, StableReviewerElementAnnotation>();
  const issues: IssueInput[] = [];
  const identifiers = new Set<string>();
  for (const annotation of [...annotations].sort((left, right) => (
    compareText(left.identifier, right.identifier) || compareText(left.role, right.role)
  ))) {
    const identifier = compact(annotation.identifier);
    if (!identifier || annotation.textSource !== "visible-title") {
      issues.push(inconclusive(`${side} reviewer element annotation is invalid.`));
      continue;
    }
    if (identifiers.has(identifier)) {
      issues.push(inconclusive(`${side} reviewer element annotation identifier is ambiguous.`));
      continue;
    }
    identifiers.add(identifier);
    const matches = elements.filter((element) => (
      compact(element.identifier ?? "") === identifier && element.role === annotation.role
    ));
    if (matches.length !== 1) {
      issues.push(inconclusive(
        `${side} reviewer element annotation does not resolve to exactly one runtime element.`,
      ));
      continue;
    }
    if (annotation.subjectLabel !== undefined && !compact(annotation.subjectLabel)) {
      issues.push(inconclusive(`${side} reviewer element annotation has an empty subject label.`));
      continue;
    }
    const match = matches[0];
    if (match) result.set(match.elementId, annotation);
  }
  return { annotations: result, issues };
}

function resolveSide(
  side: "base" | "head",
  input: MatchedSurfaceSide,
  impact: ComparatorSurfaceImpact,
  requiredSamples: 1 | 3,
): SideResolution {
  const observation = input.map.observations.find((candidate) => candidate.id === input.observationId);
  if (!observation) {
    return { kind: "missing", issues: [inconclusive(`${side} observation is missing from its map.`)] };
  }
  const screen = input.map.screens.find((candidate) => candidate.id === observation.screenId);
  if (!screen) {
    return {
      kind: "missing",
      issues: [inconclusive(
        `${side} observation references a missing screen.`,
        [observationRef(side, observation)],
      )],
    };
  }
  const issues: IssueInput[] = [];
  const runtime = input.runtimeEvidence;
  const screenEvidence = runtime.groups.screen;
  const refs = [observationRef(side, observation)];
  if (screen.id !== impact.id) {
    issues.push(inconclusive(`${side} observation is scoped to a different surface.`, refs));
  }
  if (screenEvidence.side.value !== side) {
    issues.push(inconclusive(`${side} runtime evidence has the wrong branch side.`, refs));
  }
  if (screenEvidence.observationId.value !== observation.id) {
    issues.push(inconclusive(`${side} runtime evidence has the wrong observation scope.`, refs));
  }
  if (screenEvidence.variantId.value !== observation.variantId) {
    issues.push(inconclusive(`${side} runtime evidence has the wrong variant scope.`, refs));
  }
  if (screenEvidence.surfaceId.value !== screen.id) {
    issues.push(inconclusive(`${side} runtime evidence has the wrong surface scope.`, refs));
  }
  if (screen.route !== undefined && screenEvidence.route.value !== screen.route) {
    issues.push(inconclusive(`${side} runtime route does not match the selected screen.`, refs));
  }
  const capture = runtime.groups.capture;
  if (
    capture.coverage.value.expected !== requiredSamples
    || capture.sampleCount.value !== capture.samples.value.length
    || capture.coverage.value.captured !== capture.sampleCount.value
  ) {
    issues.push(inconclusive(
      `${side} sample assessment does not match the planned capture policy.`,
      [captureRef(side, observation)],
    ));
  }
  if (!capture.coverage.value.complete || capture.sampleCount.value < requiredSamples) {
    issues.push(inconclusive(
      `${side} capture coverage is incomplete.`,
      [captureRef(side, observation)],
    ));
  }
  if (
    capture.stability.value === "unstable"
    || (requiredSamples === 3 && capture.stability.value !== "stable")
  ) {
    issues.push(inconclusive(
      `${side} capture samples are not stable.`,
      [captureRef(side, observation)],
    ));
  }
  // Match the runtime adapter's app element set, excluding capture verification metadata.
  const allElements = observation.elements
    .filter((element) => !CAPTURE_METADATA_IDENTIFIERS.has(element.identifier ?? ""))
    .sort((left, right) => compareText(left.elementId, right.elementId));
  issues.push(...validateRuntimeProjection(side, allElements, runtime, observation));
  const elements = visibleElements(observation);
  const annotationIndex = indexAnnotations(
    side,
    elements,
    input.reviewerAnnotations ?? [],
  );
  issues.push(...annotationIndex.issues);
  return {
    kind: "resolved",
    side: {
      side,
      ...(input.snapshotBackend ? { snapshotBackend: input.snapshotBackend } : {}),
      map: input.map,
      screen,
      observation,
      runtimeEvidence: runtime,
      elements,
      annotationsByElementId: annotationIndex.annotations,
      issues,
    },
  };
}

function bucketBy(
  elements: readonly ObservedElement[],
  available: ReadonlySet<string>,
  keyFor: (element: ObservedElement) => string | undefined,
): Map<string, ObservedElement[]> {
  const buckets = new Map<string, ObservedElement[]>();
  for (const element of elements) {
    if (!available.has(element.elementId)) continue;
    const key = keyFor(element);
    if (key === undefined) continue;
    const bucket = buckets.get(key) ?? [];
    bucket.push(element);
    buckets.set(key, bucket);
  }
  return buckets;
}

function matchElements(base: ResolvedSide, head: ResolvedSide): ElementPairing {
  const availableBase = new Set(base.elements.map((element) => element.elementId));
  const availableHead = new Set(head.elements.map((element) => element.elementId));
  const blockedBase = new Set<string>();
  const blockedHead = new Set<string>();
  const pairs: ElementPair[] = [];
  const issues: IssueInput[] = [];

  function matchTier(
    method: ElementPair["method"],
    keyFor: (element: ObservedElement) => string | undefined,
  ): void {
    const baseBuckets = bucketBy(base.elements, availableBase, keyFor);
    const headBuckets = bucketBy(head.elements, availableHead, keyFor);
    const keys = [...new Set([...baseBuckets.keys(), ...headBuckets.keys()])].sort(compareText);
    for (const key of keys) {
      const baseCandidates = baseBuckets.get(key) ?? [];
      const headCandidates = headBuckets.get(key) ?? [];
      if (baseCandidates.length === 1 && headCandidates.length === 1) {
        const baseElement = baseCandidates[0];
        const headElement = headCandidates[0];
        if (!baseElement || !headElement) continue;
        pairs.push({ base: baseElement, head: headElement, method });
        availableBase.delete(baseElement.elementId);
        availableHead.delete(headElement.elementId);
        continue;
      }
      if (method !== "role-label" && (baseCandidates.length > 1 || headCandidates.length > 1)) {
        // Occurrence numbers are assigned per role, so a container and its control that share
        // one label (other/button "Go back") collide here; pair them by role when that is exact.
        const byRole = (candidates: ObservedElement[]): Map<string, ObservedElement[]> => {
          const buckets = new Map<string, ObservedElement[]>();
          for (const candidate of candidates) {
            const bucket = buckets.get(candidate.role) ?? [];
            bucket.push(candidate);
            buckets.set(candidate.role, bucket);
          }
          return buckets;
        };
        const baseByRole = byRole(baseCandidates);
        const headByRole = byRole(headCandidates);
        const roles = new Set([...baseByRole.keys(), ...headByRole.keys()]);
        const exact = [...roles].every((role) => (
          (baseByRole.get(role)?.length ?? 0) === 1 && (headByRole.get(role)?.length ?? 0) === 1
        ));
        if (exact) {
          for (const role of [...roles].sort(compareText)) {
            const baseElement = baseByRole.get(role)![0]!;
            const headElement = headByRole.get(role)![0]!;
            pairs.push({ base: baseElement, head: headElement, method });
            availableBase.delete(baseElement.elementId);
            availableHead.delete(headElement.elementId);
          }
          continue;
        }
      }
      // Equal-sized duplicate groups pair in capture order: nothing was added or removed among
      // them, and the visual comparison still guards any change such repeats could hide.
      if (baseCandidates.length === headCandidates.length && baseCandidates.length > 1) {
        const ordered = (candidates: ObservedElement[]): ObservedElement[] => [...candidates].sort((left, right) => (
          left.occurrence - right.occurrence || compareText(left.elementId, right.elementId)
        ));
        const orderedHead = ordered(headCandidates);
        for (const [index, baseElement] of ordered(baseCandidates).entries()) {
          const headElement = orderedHead[index]!;
          pairs.push({ base: baseElement, head: headElement, method });
          availableBase.delete(baseElement.elementId);
          availableHead.delete(headElement.elementId);
        }
        continue;
      }
      // A key seen on one side only is a plain addition or removal; it stays available for the
      // later tiers and the added/removed lists instead of being called ambiguous.
      const duplicateStableKey = method !== "role-label"
        && baseCandidates.length > 0 && headCandidates.length > 0
        && (baseCandidates.length > 1 || headCandidates.length > 1);
      const ambiguousFallback = method === "role-label"
        && baseCandidates.length > 0
        && headCandidates.length > 0
        && (baseCandidates.length !== 1 || headCandidates.length !== 1);
      if (!duplicateStableKey && !ambiguousFallback) continue;
      issues.push(inconclusive(
        `Element matching by ${method} is ambiguous.`,
        [
          ...baseCandidates.map((element) => elementRef("base", element)),
          ...headCandidates.map((element) => elementRef("head", element)),
        ],
      ));
      for (const element of baseCandidates) {
        blockedBase.add(element.elementId);
        availableBase.delete(element.elementId);
      }
      for (const element of headCandidates) {
        blockedHead.add(element.elementId);
        availableHead.delete(element.elementId);
      }
    }
  }

  matchTier("identifier", (element) => compact(element.identifier ?? "") || undefined);
  matchTier("selector-occurrence", (element) => {
    const selector = compact(element.selector ?? "");
    return selector ? `${selector}\u0000${element.occurrence}` : undefined;
  });
  matchTier("role-label", (element) => {
    const label = compact(element.label);
    return label ? `${element.role}\u0000${label}` : undefined;
  });

  return {
    pairs: pairs.sort((left, right) => (
      compareText(left.base.elementId, right.base.elementId)
      || compareText(left.head.elementId, right.head.elementId)
    )),
    removed: base.elements.filter((element) => (
      availableBase.has(element.elementId) && !blockedBase.has(element.elementId)
    )),
    added: head.elements.filter((element) => (
      availableHead.has(element.elementId) && !blockedHead.has(element.elementId)
    )),
    issues,
  };
}

function reviewerRole(role: ElementRole): ReviewerSubjectRole {
  return role;
}

// iOS repeats a control's label on the containers around it. One appearance or removal of a
// label is one reviewer-facing change, reported through its most specific role.
const ROLE_SPECIFICITY: Record<ElementRole, number> = {
  button: 0, link: 0, tab: 0, field: 0, toggle: 0, "menu-item": 0, image: 1, text: 2, other: 3,
};

type ElementBounds = { x: number; y: number; width: number; height: number };

function boundsOf(element: ObservedElement): ElementBounds | undefined {
  const bounds = element.bounds;
  return bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    : undefined;
}

function encloses(outer: ElementBounds, inner: ElementBounds | undefined): boolean {
  return !!inner && outer.x <= inner.x && outer.y <= inner.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function childrenOf(container: ObservedElement, elements: readonly ObservedElement[]): ObservedElement[] {
  const outer = boundsOf(container);
  return outer ? elements.filter(element => element !== container && encloses(outer, boundsOf(element))) : [];
}

/** One card leaving a list is one change, not one per label inside it: keep the enclosing element. */
function outermost(elements: readonly ObservedElement[]): ObservedElement[] {
  return elements.filter(element => {
    const inner = boundsOf(element);
    if (!inner) return true;
    return !elements.some(other => {
      const outer = other === element ? undefined : boundsOf(other);
      if (!outer || !encloses(outer, inner)) return false;
      // A strictly larger box encloses; identical boxes are the same control seen through layers,
      // where the most specific role names it, and equal roles fall back to a stable order.
      return outer.width > inner.width || outer.height > inner.height
        || ROLE_SPECIFICITY[other.role] < ROLE_SPECIFICITY[element.role]
        || (ROLE_SPECIFICITY[other.role] === ROLE_SPECIFICITY[element.role]
          && compareText(other.elementId, element.elementId) < 0);
    });
  });
}

function specificByLabel(elements: readonly ObservedElement[]): ObservedElement[] {
  const byLabel = new Map<string, ObservedElement>();
  const unlabelled: ObservedElement[] = [];
  for (const element of elements) {
    const label = compact(element.label);
    if (!label) { unlabelled.push(element); continue; }
    const previous = byLabel.get(label);
    if (!previous || ROLE_SPECIFICITY[element.role] < ROLE_SPECIFICITY[previous.role]) byLabel.set(label, element);
  }
  return [...byLabel.values(), ...unlabelled].sort((left, right) => compareText(left.elementId, right.elementId));
}

function humanizeIdentifier(identifier: string): string {
  const value = compact(identifier).replace(/[-_.:/]+/g, " ");
  return value
    ? value.replace(/\b\w/g, (character) => character.toUpperCase())
    : "Element";
}

function visibleTextSubject(
  pair: ElementPair,
  baseAnnotation: StableReviewerElementAnnotation,
  headAnnotation: StableReviewerElementAnnotation,
): { subjectLabel: string; subjectRole: ReviewerSubjectRole } | IssueInput {
  const baseSubject = compact(baseAnnotation.subjectLabel ?? "");
  const headSubject = compact(headAnnotation.subjectLabel ?? "");
  if (baseSubject && headSubject && baseSubject !== headSubject) {
    return inconclusive("Visible-title annotations disagree on the reviewer-facing subject.", [
      elementRef("base", pair.base),
      elementRef("head", pair.head),
    ]);
  }
  return {
    subjectLabel: headSubject || baseSubject || humanizeIdentifier(
      pair.head.identifier ?? pair.base.identifier ?? "element",
    ),
    subjectRole: reviewerRole(pair.head.role),
  };
}

function relevantSafeAttempts(side: ResolvedSide, element: ObservedElement): ActionAttempt[] {
  return side.map.actionAttempts.filter((attempt) => {
    if (attempt.sourceObservationId !== side.observation.id || attempt.risk !== "safe") return false;
    if (attempt.action.elementId !== undefined) return attempt.action.elementId === element.elementId;
    return attempt.action.selector !== undefined
      && element.selector !== undefined
      && attempt.action.selector === element.selector;
  });
}

function isSafeCanonicalRoute(route: string): boolean {
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("#") || route.includes("\\")) {
    return false;
  }
  const [pathname = "", query = ""] = route.split("?", 2);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decodedPathname.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  for (const key of new URLSearchParams(query).keys()) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["token", "secret", "key", "password", "auth", "cookie"]
      .some((credential) => normalized.includes(credential))) {
      return false;
    }
  }
  return true;
}

function runtimeAttemptSupports(
  side: ResolvedSide,
  attempt: ActionAttempt,
  target: Screen | undefined,
): boolean {
  const observed = side.runtimeEvidence.groups.interaction.attempts.value
    .find((candidate) => candidate.id === attempt.id);
  if (
    !observed
    || observed.observationId !== side.observation.id
    || observed.action !== attempt.action.kind
    || compact(observed.label) !== compact(attempt.action.label)
    || observed.outcome !== attempt.outcome
  ) return false;
  if (attempt.outcome !== "transition") return observed.target === undefined;
  return target !== undefined
    && observed.target?.surfaceId === target.id
    && observed.target.route === target.route;
}

function actionTarget(side: ResolvedSide, element: ObservedElement): ActionTargetAssessment {
  const attempts = relevantSafeAttempts(side, element);
  if (attempts.length === 0) return { kind: "none", evidenceRefs: [] };
  const transitions = attempts.filter((attempt) => attempt.outcome === "transition");
  if (transitions.length > 0 && transitions.length !== attempts.length) {
    return {
      kind: "inconclusive",
      issue: inconclusive(
        `${side.side} safe action outcomes are inconsistent.`,
        attempts.map((attempt) => evidenceRef(side.side, "attempt", attempt.id)),
      ),
    };
  }
  if (transitions.length === 0) {
    return {
      kind: "none",
      evidenceRefs: attempts.map((attempt) => evidenceRef(side.side, "attempt", attempt.id)),
    };
  }
  const targets = new Map<string, ActionTarget>();
  for (const attempt of transitions) {
    const target = attempt.targetScreenId === undefined
      ? undefined
      : side.map.screens.find((screen) => screen.id === attempt.targetScreenId);
    const route = compact(target?.route ?? "");
    const reference = evidenceRef(side.side, "attempt", attempt.id);
    if (!runtimeAttemptSupports(side, attempt, target)) {
      return {
        kind: "inconclusive",
        issue: inconclusive(
          `${side.side} map transition is not supported by scoped Runtime Evidence.`,
          [reference],
        ),
      };
    }
    if (!target || !isSafeCanonicalRoute(route)) {
      return {
        kind: "inconclusive",
        issue: inconclusive(
          `${side.side} safe transition is missing its canonical target route.`,
          [reference],
        ),
      };
    }
    const previous = targets.get(route);
    targets.set(route, {
      route,
      display: compact(target.title) || route,
      evidenceRefs: [
        ...(previous?.evidenceRefs ?? []),
        reference,
      ].sort(compareText),
    });
  }
  if (targets.size !== 1) {
    return {
      kind: "inconclusive",
      issue: inconclusive(
        `${side.side} safe action resolves to multiple target routes.`,
        transitions.map((attempt) => evidenceRef(side.side, "attempt", attempt.id)),
      ),
    };
  }
  const target = [...targets.values()][0];
  return target ? { kind: "target", target } : { kind: "none", evidenceRefs: [] };
}

type ResolvedSibling = { base: ResolvedSide; head: ResolvedSide };

function resolveSiblings(input: CommonSurfaceComparatorInput, requiredSamples: 1 | 3): ResolvedSibling[] {
  const resolve = (side: "base" | "head", sibling: MatchedSurfaceSide) => {
    const screenId = sibling.map.observations.find((candidate) => candidate.id === sibling.observationId)?.screenId;
    const resolution = screenId === undefined ? undefined : resolveSide(side, sibling, { ...input.impact, id: screenId }, requiredSamples);
    // A sibling is evidence only when it resolves as cleanly as a comparison would.
    return resolution?.kind === "resolved" && resolution.side.issues.length === 0 ? resolution.side : undefined;
  };
  return (input.siblings ?? []).flatMap((sibling) => {
    const base = resolve("base", sibling.base);
    const head = resolve("head", sibling.head);
    return base && head ? [{ base, head }] : [];
  });
}

function sameBounds(left: ElementBounds | undefined, right: ElementBounds | undefined): boolean {
  return !!left && !!right && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/** The element at the same place in another capture: the one of its role with its identifier or, without one, its bounds. */
function counterpart(element: ObservedElement, other: ResolvedSide): ObservedElement | undefined {
  const identifier = compact(element.identifier ?? "");
  const bounds = boundsOf(element);
  const candidates = other.elements.filter((candidate) => candidate.role === element.role && (identifier
    ? compact(candidate.identifier ?? "") === identifier
    : !compact(candidate.identifier ?? "") && sameBounds(bounds, boundsOf(candidate))));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The word positions at which two labels differ, or undefined when they have different numbers of words. */
function changedWords(left: string, right: string): number[] | undefined {
  const leftWords = left.split(" ");
  const rightWords = right.split(" ");
  return leftWords.length === rightWords.length
    ? leftWords.flatMap((word, index) => word === rightWords[index] ? [] : [index])
    : undefined;
}

/**
 * What the head showed in its other appearance, when a label's difference between the builds is runtime state: each
 * build shows the label differently in its own two appearances, the other appearance differs between the builds too,
 * and every word that differs between the builds is one that varies within a build. A label that follows the
 * appearance ("Switch to dark mode") does not vary within a build that broke it, or keeps a word that changed, so
 * its change is still a change.
 */
function unstableWithin(base: ObservedElement, head: ObservedElement, siblings: readonly ResolvedSibling[]): string | undefined {
  const baseLabel = compact(base.label);
  const headLabel = compact(head.label);
  for (const sibling of siblings) {
    const baseOther = compact(counterpart(base, sibling.base)?.label ?? "");
    const headOther = compact(counterpart(head, sibling.head)?.label ?? "");
    if (!baseLabel || !headLabel || !baseOther || !headOther) continue;
    const withinBase = changedWords(baseLabel, baseOther);
    const withinHead = changedWords(headLabel, headOther);
    const across = changedWords(baseLabel, headLabel);
    const acrossOther = changedWords(baseOther, headOther);
    if (!withinBase?.length || !withinHead?.length || !across?.length || !acrossOther?.length) continue;
    const varying = new Set([...withinBase, ...withinHead]);
    if ([...across, ...acrossOther].every((index) => varying.has(index))) return headOther;
  }
  return undefined;
}

function comparePair(
  pair: ElementPair,
  base: ResolvedSide,
  head: ResolvedSide,
  /** What the head showed in its other appearance when this element's label is runtime state. */
  within?: string,
): { facts: SupportedInput[]; issues: IssueInput[] } {
  const facts: SupportedInput[] = [];
  const issues: IssueInput[] = [];
  const refs = [elementRef("base", pair.base), elementRef("head", pair.head)];
  const baseLabel = compact(pair.base.label);
  const headLabel = compact(pair.head.label);
  const baseAnnotation = base.annotationsByElementId.get(pair.base.elementId);
  const headAnnotation = head.annotationsByElementId.get(pair.head.elementId);
  // Runtime state replaces a label change only where the label comparison itself holds: provenance still decides first.
  const labelChange = (change: SupportedReviewerChange): SupportedReviewerChange => within
    ? { kind: "unstable-text", subjectRole: reviewerRole(pair.head.role), before: baseLabel, after: headLabel, within }
    : change;

  if (baseLabel !== headLabel) {
    if (baseAnnotation && headAnnotation) {
      const subject = visibleTextSubject(pair, baseAnnotation, headAnnotation);
      if ("assessment" in subject) {
        issues.push(subject);
      } else if (!baseLabel || !headLabel) {
        issues.push(inconclusive("Visible-title comparison is missing before or after text.", refs));
      } else {
        facts.push(supported(labelChange({
          kind: "visible-text-changed",
          subjectRole: subject.subjectRole,
          subjectLabel: subject.subjectLabel,
          textKind: pair.head.role === "button" ? "title" : "label",
          before: baseLabel,
          after: headLabel,
        }), refs));
      }
    } else if (baseAnnotation || headAnnotation) {
      issues.push(inconclusive(
        "Visible-title provenance is present on only one side of the element comparison.",
        refs,
      ));
    } else if (!baseLabel || !headLabel) {
      issues.push(inconclusive("Accessibility label comparison is missing before or after text.", refs));
    } else {
      facts.push(supported(labelChange({
        kind: "accessibility-label-changed",
        subjectRole: reviewerRole(pair.head.role),
        before: baseLabel,
        after: headLabel,
      }), refs));
    }
  }
  if (pair.base.role !== pair.head.role) {
    facts.push(supported({
      kind: "accessibility-role-changed",
      subjectLabel: headLabel || baseLabel || humanizeIdentifier(
        pair.head.identifier ?? pair.base.identifier ?? "element",
      ),
      beforeRole: reviewerRole(pair.base.role),
      afterRole: reviewerRole(pair.head.role),
    }, refs));
  }

  const baseTarget = actionTarget(base, pair.base);
  const headTarget = actionTarget(head, pair.head);
  if (baseTarget.kind === "inconclusive") issues.push(baseTarget.issue);
  if (headTarget.kind === "inconclusive") issues.push(headTarget.issue);
  if (baseTarget.kind === "target" && headTarget.kind === "target") {
    if (baseTarget.target.route !== headTarget.target.route) {
      facts.push(supported({
        kind: "action-target-changed",
        subjectRole: reviewerRole(pair.head.role),
        subjectLabel: headLabel || baseLabel || humanizeIdentifier(
          pair.head.identifier ?? pair.base.identifier ?? "element",
        ),
        beforeTarget: baseTarget.target.display,
        afterTarget: headTarget.target.display,
      }, [
        ...refs,
        ...baseTarget.target.evidenceRefs,
        ...headTarget.target.evidenceRefs,
      ]));
    }
  } else if (
    (baseTarget.kind === "target" && headTarget.kind === "none")
    || (baseTarget.kind === "none" && headTarget.kind === "target")
  ) {
    issues.push(inconclusive(
      "Safe action transition evidence exists on only one side.",
      [
        ...refs,
        ...(baseTarget.kind === "target"
          ? baseTarget.target.evidenceRefs
          : baseTarget.evidenceRefs),
        ...(headTarget.kind === "target"
          ? headTarget.target.evidenceRefs
          : headTarget.evidenceRefs),
      ],
    ));
  }
  return { facts, issues };
}

function screenTitle(side: ResolvedSide): string {
  return compact(side.screen.title) || compact(side.screen.route ?? "") || side.screen.id;
}

function validateVisualAssessment(
  impact: ComparatorSurfaceImpact,
  base: ResolvedSide,
  head: ResolvedSide,
  assessment: VisualEvidenceAssessment,
): IssueInput[] {
  const issues: IssueInput[] = [];
  const refs = [visualRef(impact.id, assessment)];
  const baseCount = base.runtimeEvidence.groups.capture.sampleCount.value;
  const headCount = head.runtimeEvidence.groups.capture.sampleCount.value;
  if (
    assessment.requiredSamples !== impact.baseSamples
    || assessment.requiredSamples !== impact.headSamples
    || assessment.baselineSamples !== baseCount
    || assessment.currentSamples !== headCount
  ) {
    issues.push(inconclusive("Visual assessment does not match the scoped capture samples.", refs));
  }
  if (assessment.status === "needs-review") {
    issues.push(inconclusive(`Visual evidence needs review: ${assessment.reason}.`, refs));
  }
  return issues;
}

function visualFact(
  input: CommonSurfaceComparatorInput,
  base: ResolvedSide,
  head: ResolvedSide,
): { fact?: SupportedInput; issue?: IssueInput } {
  if (input.visualAssessment.status !== "modified") return {};
  const refs = [visualRef(input.impact.id, input.visualAssessment)];
  const scope: VisualReviewerChange["scope"] = input.visualScope ?? { kind: "main-content" };
  if (scope.kind === "landmark") {
    const label = compact(scope.label);
    const baseLandmarks = base.runtimeEvidence.groups.ui.landmarks.value;
    const headLandmarks = head.runtimeEvidence.groups.ui.landmarks.value;
    if (
      !label
      || !baseLandmarks.some((landmark) => compact(landmark.label) === label)
      || !headLandmarks.some((landmark) => compact(landmark.label) === label)
    ) {
      return {
        issue: inconclusive(
          "Visual landmark scope is not supported by both runtime snapshots.",
          refs,
        ),
      };
    }
    return {
      fact: supported({ kind: "visual-changed", scope: { kind: "landmark", label } }, refs),
    };
  }
  const near = nearEdge(input.visualAssessment.representative?.regions ?? []);
  return {
    fact: supported({ kind: "visual-changed", scope: { kind: "main-content", ...(near ? { near } : {}) } }, refs),
  };
}

/** Which edge every diff region hugs, when all of them sit in the outer 12 % of the frame: not "the main content". */
function nearEdge(regions: readonly VisualDiffRegion[]): "top" | "bottom" | undefined {
  if (regions.length === 0) return undefined;
  if (regions.every((region) => region.normalizedRect.y + region.normalizedRect.height <= 12)) return "top";
  if (regions.every((region) => region.normalizedRect.y >= 88)) return "bottom";
  return undefined;
}

function comparisonForAdded(head: RuntimeEvidence): RuntimeEvidenceComparison {
  return {
    contract: RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
    status: "added",
    head,
  };
}

function comparisonForRemoved(base: RuntimeEvidence): RuntimeEvidenceComparison {
  return {
    contract: RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
    status: "removed",
    base,
  };
}

function comparisonForCommon(
  status: "modified" | "unchanged",
  base: RuntimeEvidence,
  head: RuntimeEvidence,
): RuntimeEvidenceComparison {
  return {
    contract: RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
    status,
    base,
    head,
  };
}

function reviewReasons(changes: readonly ReviewerChangeInput[]): string[] {
  return [...new Set(changes.flatMap((change) => (
    change.assessment === "supported" ? [] : [compact(change.reason)]
  )))].filter(Boolean).sort(compareText);
}

function addedResult(input: AddedSurfaceComparatorInput): EvidenceComparatorResult {
  if (input.impact.headSamples !== 1 && input.impact.headSamples !== 3) {
    throw new Error("A head-only surface must have a head sample policy");
  }
  const resolution = resolveSide("head", input.head, input.impact, input.impact.headSamples);
  const facts: SupportedInput[] = [];
  const issues: IssueInput[] = [];
  if (resolution.kind === "resolved") {
    issues.push(...resolution.side.issues);
    facts.push(supported(
      { kind: "screen-added", screenTitle: screenTitle(resolution.side) },
      [observationRef("head", resolution.side.observation)],
    ));
  } else {
    issues.push(...resolution.issues);
  }
  const reviewerChanges = normalizeResults(facts, issues);
  const reasons = reviewReasons(reviewerChanges);
  return {
    surfaceId: input.impact.id,
    status: "added",
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    runtimeEvidence: comparisonForAdded(input.head.runtimeEvidence),
    reviewerChanges,
  };
}

function removedResult(input: RemovedSurfaceComparatorInput): EvidenceComparatorResult {
  if (input.impact.baseSamples !== 1 && input.impact.baseSamples !== 3) {
    throw new Error("A base-only surface must have a base sample policy");
  }
  const resolution = resolveSide("base", input.base, input.impact, input.impact.baseSamples);
  const facts: SupportedInput[] = [];
  const issues: IssueInput[] = [];
  if (resolution.kind === "resolved") {
    issues.push(...resolution.side.issues);
    facts.push(supported(
      { kind: "screen-removed", screenTitle: screenTitle(resolution.side) },
      [observationRef("base", resolution.side.observation)],
    ));
  } else {
    issues.push(...resolution.issues);
  }
  const reviewerChanges = normalizeResults(facts, issues);
  const reasons = reviewReasons(reviewerChanges);
  return {
    surfaceId: input.impact.id,
    status: "removed",
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    runtimeEvidence: comparisonForRemoved(input.base.runtimeEvidence),
    reviewerChanges,
  };
}

function commonResult(input: CommonSurfaceComparatorInput): EvidenceComparatorResult {
  if (
    (input.impact.baseSamples !== 1 && input.impact.baseSamples !== 3)
    || input.impact.headSamples !== input.impact.baseSamples
  ) {
    throw new Error("A common surface must have equal non-zero sample policies");
  }
  const baseResolution = resolveSide("base", input.base, input.impact, input.impact.baseSamples);
  const headResolution = resolveSide("head", input.head, input.impact, input.impact.headSamples);
  const facts: SupportedInput[] = [];
  const issues: IssueInput[] = [];
  if (baseResolution.kind === "missing" || headResolution.kind === "missing") {
    if (baseResolution.kind === "missing") issues.push(...baseResolution.issues);
    if (headResolution.kind === "missing") issues.push(...headResolution.issues);
    const reviewerChanges = normalizeResults(facts, issues);
    return {
      surfaceId: input.impact.id,
      status: "modified",
      needsReview: true,
      reviewReasons: reviewReasons(reviewerChanges),
      runtimeEvidence: comparisonForCommon(
        "modified",
        input.base.runtimeEvidence,
        input.head.runtimeEvidence,
      ),
      visualAssessment: input.visualAssessment,
      reviewerChanges,
    };
  }
  const base = baseResolution.side;
  const head = headResolution.side;
  issues.push(...base.issues, ...head.issues);
  // Identical accessibility trees cannot contain a real element change, and per-role occurrence
  // numbering can make byte-identical trees look ambiguous to the matcher. Skip element diffing
  // and report no element facts; the visual assessment still decides styling changes.
  const sameAccessibilityTree = base.observation.fingerprints.accessibility !== undefined
    && base.observation.fingerprints.accessibility === head.observation.fingerprints.accessibility;
  // agent-device 0.21.x serves a snapshot from its host AX bridge or from XCTest, and the two
  // describe one screen with different containers, roles and field labels. Trees from different
  // backends are not element-comparable; the visual assessment alone decides that surface.
  const mixedBackends = base.snapshotBackend !== undefined && head.snapshotBackend !== undefined
    && base.snapshotBackend !== head.snapshotBackend;
  const pairing = sameAccessibilityTree || mixedBackends
    ? { pairs: [], added: [], removed: [], issues: [] as IssueInput[] }
    : matchElements(base, head);
  issues.push(...pairing.issues);
  // A label that still appears on the other revision did not come or go: only its duplicate
  // exposures moved, which is not a reviewer-facing change.
  const labelsOf = (side: ResolvedSide) => new Set(side.elements.map(element => compact(element.label)).filter(Boolean));
  const headLabels = labelsOf(head);
  const baseLabels = labelsOf(base);
  // An unchanged container whose counterpart exposes no children at all differs in snapshot
  // depth, not in the interface; the elements it holds are not reviewer-facing changes.
  const depthOnly = new Set<string>();
  for (const pair of pairing.pairs) {
    const baseChildren = childrenOf(pair.base, base.elements);
    const headChildren = childrenOf(pair.head, head.elements);
    if (baseChildren.length && !headChildren.length) {
      for (const child of baseChildren) depthOnly.add(`base:${child.elementId}`);
    }
    if (headChildren.length && !baseChildren.length) {
      for (const child of headChildren) depthOnly.add(`head:${child.elementId}`);
    }
  }
  let gone = pairing.removed.filter(element => !headLabels.has(compact(element.label))
    && !depthOnly.has(`base:${element.elementId}`));
  let arrived = pairing.added.filter(element => !baseLabels.has(compact(element.label))
    && !depthOnly.has(`head:${element.elementId}`));
  if (mixedBackends) {
    // Across backends only content can be compared: text and controls whose words the other
    // side exposes nowhere, not as a label, a value, or one part of a merged label.
    const words = (side: ResolvedSide) => new Set(side.elements.flatMap(element => [element.label, element.value ?? ""]
      .flatMap(text => [compact(text), ...compact(text).split(/,\s*/)])).filter(Boolean));
    const baseWords = words(base), headWords = words(head);
    const content = (element: ObservedElement, other: Set<string>) => ["text", "button", "link", "tab"].includes(element.role)
      && !!compact(element.label) && !other.has(compact(element.label))
      && !compact(element.label).split(/,\s*/).some(part => other.has(part));
    gone = base.elements.filter(element => content(element, headWords));
    arrived = head.elements.filter(element => content(element, baseWords));
  }
  // Text without an identifier is matched by its label, so a label that changed on its own leaves as one element and
  // arrives as another: the one of its role at the same place on both sides is runtime state when its label is.
  const siblings = mixedBackends ? [] : resolveSiblings(input, input.impact.baseSamples);
  const runtimeText = { base: new Set<string>(), head: new Set<string>() };
  for (const removed of siblings.length ? specificByLabel(gone) : []) {
    const added = counterpart(removed, head);
    if (!added || !arrived.includes(added) || counterpart(added, base) !== removed) continue;
    const within = unstableWithin(removed, added, siblings);
    if (!within) continue;
    runtimeText.base.add(compact(removed.label));
    runtimeText.head.add(compact(added.label));
    facts.push(supported({
      kind: "unstable-text",
      subjectRole: reviewerRole(added.role),
      before: compact(removed.label),
      after: compact(added.label),
      within,
    }, [elementRef("base", removed), elementRef("head", added)]));
  }
  gone = gone.filter((element) => !runtimeText.base.has(compact(element.label)));
  arrived = arrived.filter((element) => !runtimeText.head.has(compact(element.label)));
  for (const element of outermost(specificByLabel(gone))) {
    const label = compact(element.label);
    if (!label) {
      issues.push(inconclusive(
        "Removed element has no reviewer-facing label.",
        [elementRef("base", element)],
      ));
    } else {
      facts.push(supported({
        kind: "element-removed",
        elementRole: reviewerRole(element.role),
        elementLabel: label,
      }, [elementRef("base", element)]));
    }
  }
  for (const element of outermost(specificByLabel(arrived))) {
    const label = compact(element.label);
    if (!label) {
      issues.push(inconclusive(
        "Added element has no reviewer-facing label.",
        [elementRef("head", element)],
      ));
    } else {
      facts.push(supported({
        kind: "element-added",
        elementRole: reviewerRole(element.role),
        elementLabel: label,
      }, [elementRef("head", element)]));
    }
  }
  for (const pair of pairing.pairs) {
    const comparison = comparePair(pair, base, head, unstableWithin(pair.base, pair.head, siblings));
    facts.push(...comparison.facts);
    issues.push(...comparison.issues);
  }
  issues.push(...validateVisualAssessment(
    input.impact,
    base,
    head,
    input.visualAssessment,
  ));
  const visual = visualFact(input, base, head);
  // Pixels always move when an element appears or its text changes. The generic styling line
  // only informs when nothing in the accessibility tree accounts for the difference.
  const explained = facts.some((fact) => fact.change.kind !== "unstable-text") && input.visualScope?.kind !== "landmark";
  if (visual.fact && !explained) facts.push(visual.fact);
  if (visual.issue) issues.push(visual.issue);

  // Source provenance is not an evidence question: the review step classifies a runtime delta
  // on source-unchanged code as a screen variant (evidence-assessment.ts `decideReview`).
  const hasRuntimeDelta = facts.length > 0 || input.visualAssessment.status === "modified";
  if (
    !hasRuntimeDelta
    && input.visualAssessment.status === "unchanged"
    && issues.length === 0
  ) {
    facts.push(supported({ kind: "no-visible-change" }, [
      observationRef("base", base.observation),
      observationRef("head", head.observation),
      captureRef("base", base.observation),
      captureRef("head", head.observation),
      visualRef(input.impact.id, input.visualAssessment),
    ]));
  }
  const reviewerChanges = normalizeResults(facts, issues);
  const reasons = reviewReasons(reviewerChanges);
  const status: "modified" | "unchanged" = hasRuntimeDelta || reasons.length > 0
    ? "modified"
    : "unchanged";
  return {
    surfaceId: input.impact.id,
    status,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    runtimeEvidence: comparisonForCommon(
      status,
      input.base.runtimeEvidence,
      input.head.runtimeEvidence,
    ),
    visualAssessment: input.visualAssessment,
    reviewerChanges,
  };
}

function isAdded(input: EvidenceComparatorInput): input is AddedSurfaceComparatorInput {
  return input.impact.presence === "head-only" && "head" in input && !("base" in input);
}

function isRemoved(input: EvidenceComparatorInput): input is RemovedSurfaceComparatorInput {
  return input.impact.presence === "base-only" && "base" in input && !("head" in input);
}

function isCommon(input: EvidenceComparatorInput): input is CommonSurfaceComparatorInput {
  return input.impact.presence === "both"
    && "base" in input
    && "head" in input
    && "visualAssessment" in input;
}

/** Compare one canonical surface using semantic runtime evidence, never pixel-derived semantics. */
export function compareSurfaceEvidence(input: EvidenceComparatorInput): EvidenceComparatorResult {
  if (isAdded(input)) return addedResult(input);
  if (isRemoved(input)) return removedResult(input);
  if (isCommon(input)) return commonResult(input);
  throw new Error("Surface comparator input does not match its impact presence");
}
