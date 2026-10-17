import type {
  ActionKind,
  ActionOutcome,
  ElementRole,
  Platform,
  SurfaceScope,
} from "../types.js";

export const RUNTIME_EVIDENCE_CONTRACT = "expo.explore.runtime-evidence.v0";
export const RUNTIME_EVIDENCE_COMPARISON_CONTRACT =
  "expo.explore.runtime-evidence-comparison.v0";

export type EvidenceSide = "base" | "head";
export type EvidenceOrigin = "eas-agent-device" | "capture-context" | "derived";

export type EvidenceField<Origin extends EvidenceOrigin, Value> = {
  origin: Origin;
  value: Value;
};

export type ConfiguredCaptureContext = {
  kind: "configured-capture-context";
  side: EvidenceSide;
  logicalBuild: string;
  profile: string;
  surfaceId: string;
  route: string;
  state?: string;
  variantId: string;
  observationId: string;
  expectedSampleCount: number;
  fixturePersona?: string;
  controllerPackageVersion?: string;
  easCliVersion?: string;
};

export type RawAccessibilityElement = {
  id: string;
  role: ElementRole;
  label: string;
  actionable: boolean;
  /** Present only when the controller explicitly identifies a landmark. */
  landmark?: boolean;
};

export type RawAccessibilityEvidence = {
  truncated: boolean;
  elements: RawAccessibilityElement[];
};

export type RawObservedScreen = {
  id: string;
  variantId: string;
  capturedAt: string;
  surfaceScope: SurfaceScope;
  accessibility: RawAccessibilityEvidence;
};

export type RawInteractionTarget = {
  surfaceId: string;
  route: string;
};

export type RawInteractionEvidence = {
  id: string;
  observationId: string;
  action: ActionKind;
  label: string;
  outcome: ActionOutcome;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  target?: RawInteractionTarget;
};

export type RawCaptureFingerprints = {
  combined: string;
  visual: string;
  accessibility?: string;
};

export type RawCaptureSample = {
  id: string;
  observationId: string;
  variantId: string;
  capturedAt: string;
  widthPixels: number;
  heightPixels: number;
  /** Present only when the controller reports it; never inferred from a device model. */
  pixelDensity?: number;
  fingerprints: RawCaptureFingerprints;
};

export type RawSimulatorEnvironment = {
  provider: "eas-simulator";
  controller: "agent-device" | "argent";
  platform: Platform;
  deviceModel: string;
  osVersion: string;
  locale: string;
  orientation: "portrait" | "landscape";
  colorScheme: "light" | "dark" | "system";
  sessionLifecycle: "starting" | "ready" | "capturing" | "stopped";
};

export type EasAgentDeviceRawEvidence = {
  kind: "eas-agent-device-raw";
  observation: RawObservedScreen;
  interactions: RawInteractionEvidence[];
  captures: RawCaptureSample[];
  environment: RawSimulatorEnvironment;
};

export type RuntimeDiagnosticEntry =
  | {
    code: "capture.sample-plan";
    title: "Capture sample plan";
    value: "single" | "triple";
    origin: "capture-context";
  }
  | {
    code: "capture.sample-shortfall";
    title: "Capture sample anomaly";
    value: "shortfall";
    origin: "derived";
  }
  | {
    code: "capture.stability-unstable";
    title: "Capture stability anomaly";
    value: "unstable";
    origin: "derived";
  }
  | {
    code: "ui.accessibility-truncated";
    title: "Accessibility snapshot truncated";
    value: "truncated";
    origin: "eas-agent-device";
  }
  | {
    code: "ui.accessibility-empty";
    title: "Accessibility snapshot empty";
    value: "empty";
    origin: "derived";
  }
  | {
    code: "interaction.failed";
    title: "Interaction failed";
    value: "failed";
    origin: "eas-agent-device";
  }
  | {
    code: "interaction.blocked";
    title: "Interaction blocked";
    value: "blocked";
    origin: "eas-agent-device";
  };

export type NonEmptyRuntimeDiagnostics = [
  RuntimeDiagnosticEntry,
  ...RuntimeDiagnosticEntry[],
];

export type RuntimeDiagnosticsExtension = {
  kind: "diagnostics-extension";
  entries: NonEmptyRuntimeDiagnostics;
};

export type RuntimeEvidenceInput = {
  context: ConfiguredCaptureContext;
  runtime: EasAgentDeviceRawEvidence;
  diagnostics?: RuntimeDiagnosticsExtension;
};

export type NormalizedRoleCount = {
  role: ElementRole;
  count: number;
};

export type NormalizedLandmark = {
  id: string;
  role: ElementRole;
  label: string;
};

export type SnapshotQuality = "complete" | "empty" | "truncated";
export type CaptureStability = "single-sample" | "stable" | "unstable";

export type NormalizedInteraction = RawInteractionEvidence;
export type NormalizedCaptureSample = RawCaptureSample;

export type RuntimeScreenEvidence = {
  id: "screen";
  side: EvidenceField<"capture-context", EvidenceSide>;
  logicalBuild: EvidenceField<"capture-context", string>;
  route: EvidenceField<"capture-context", string>;
  surfaceId: EvidenceField<"capture-context", string>;
  state?: EvidenceField<"capture-context", string>;
  variantId: EvidenceField<"capture-context", string>;
  observationId: EvidenceField<"eas-agent-device", string>;
  surfaceScope: EvidenceField<"eas-agent-device", SurfaceScope>;
  capturedAt: EvidenceField<"eas-agent-device", string>;
};

export type RuntimeUiEvidence = {
  id: "ui";
  elementCount: EvidenceField<"derived", number>;
  actionableCount: EvidenceField<"derived", number>;
  roleCounts: EvidenceField<"derived", NormalizedRoleCount[]>;
  landmarks: EvidenceField<"derived", NormalizedLandmark[]>;
  snapshotQuality: EvidenceField<"derived", SnapshotQuality>;
  truncated: EvidenceField<"eas-agent-device", boolean>;
};

export type InteractionOutcomeCounts = Record<ActionOutcome, number>;

export type RuntimeInteractionEvidence = {
  id: "interaction";
  attempts: EvidenceField<"eas-agent-device", NormalizedInteraction[]>;
  outcomeCounts: EvidenceField<"derived", InteractionOutcomeCounts>;
  transitionCount: EvidenceField<"derived", number>;
};

export type CaptureDimensions = {
  widthPixels: number;
  heightPixels: number;
};

export type CaptureCoverage = {
  expected: number;
  captured: number;
  ratio: number;
  complete: boolean;
};

export type RuntimeCaptureEvidence = {
  id: "capture";
  samples: EvidenceField<"eas-agent-device", NormalizedCaptureSample[]>;
  sampleCount: EvidenceField<"derived", number>;
  stability: EvidenceField<"derived", CaptureStability>;
  dimensions: EvidenceField<"derived", CaptureDimensions[]>;
  pixelDensities: EvidenceField<"derived", number[]>;
  coverage: EvidenceField<"derived", CaptureCoverage>;
};

export type RuntimeEnvironmentEvidence = {
  id: "environment";
  profile: EvidenceField<"capture-context", string>;
  fixturePersona?: EvidenceField<"capture-context", string>;
  provider: EvidenceField<"eas-agent-device", "eas-simulator">;
  controller: EvidenceField<"eas-agent-device", "agent-device" | "argent">;
  controllerPackageVersion?: EvidenceField<"capture-context", string>;
  easCliVersion?: EvidenceField<"capture-context", string>;
  platform: EvidenceField<"eas-agent-device", Platform>;
  deviceModel: EvidenceField<"eas-agent-device", string>;
  osVersion: EvidenceField<"eas-agent-device", string>;
  locale: EvidenceField<"eas-agent-device", string>;
  orientation: EvidenceField<"eas-agent-device", "portrait" | "landscape">;
  colorScheme: EvidenceField<"eas-agent-device", "light" | "dark" | "system">;
  sessionLifecycle: EvidenceField<
    "eas-agent-device",
    "starting" | "ready" | "capturing" | "stopped"
  >;
};

export type RuntimeDiagnosticsEvidence = {
  id: "diagnostics";
  entries: NonEmptyRuntimeDiagnostics;
};

export type RuntimeEvidence = {
  contract: typeof RUNTIME_EVIDENCE_CONTRACT;
  groups: {
    screen: RuntimeScreenEvidence;
    ui: RuntimeUiEvidence;
    interaction: RuntimeInteractionEvidence;
    capture: RuntimeCaptureEvidence;
    environment: RuntimeEnvironmentEvidence;
    diagnostics?: RuntimeDiagnosticsEvidence;
  };
};

export type AddedRuntimeEvidenceComparison = {
  contract: typeof RUNTIME_EVIDENCE_COMPARISON_CONTRACT;
  status: "added";
  head: RuntimeEvidence;
};

export type RemovedRuntimeEvidenceComparison = {
  contract: typeof RUNTIME_EVIDENCE_COMPARISON_CONTRACT;
  status: "removed";
  base: RuntimeEvidence;
};

export type CommonRuntimeEvidenceComparison = {
  contract: typeof RUNTIME_EVIDENCE_COMPARISON_CONTRACT;
  status: "modified" | "unchanged";
  base: RuntimeEvidence;
  head: RuntimeEvidence;
};

export type RuntimeEvidenceComparison =
  | AddedRuntimeEvidenceComparison
  | RemovedRuntimeEvidenceComparison
  | CommonRuntimeEvidenceComparison;

type RuntimeEvidenceGroupKey = "screen" | "ui" | "interaction" | "capture" | "environment";
type ForbiddenCategory = "mock" | "credential" | "telemetry" | "source-path";

const ELEMENT_ROLES = [
  "button",
  "link",
  "tab",
  "field",
  "toggle",
  "menu-item",
  "text",
  "image",
  "other",
] satisfies ElementRole[];

const ACTION_KINDS = [
  "press",
  "fill",
  "swipe",
  "back",
  "dismiss",
  "deep-link",
  "key",
  "other",
] satisfies ActionKind[];

const ACTION_OUTCOMES = [
  "transition",
  "same-screen",
  "no-change",
  "failed",
  "blocked",
  "external",
] satisfies ActionOutcome[];

const SURFACE_SCOPES = ["app", "system", "external"] satisfies SurfaceScope[];
const PLATFORMS = ["ios", "android"] satisfies Platform[];
const SIDES = ["base", "head"] satisfies EvidenceSide[];
const RUNTIME_DIAGNOSTIC_CODES = [
  "capture.sample-plan",
  "capture.sample-shortfall",
  "capture.stability-unstable",
  "ui.accessibility-truncated",
  "ui.accessibility-empty",
  "interaction.failed",
  "interaction.blocked",
] satisfies RuntimeDiagnosticEntry["code"][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forbiddenCategory(key: string): ForbiddenCategory | undefined {
  const normalized = normalizedKey(key);
  if (
    normalized === "server"
    || normalized.includes("serverstate")
    || normalized.includes("hydration")
    || normalized === "form"
    || normalized.includes("formvalidity")
  ) return "mock";
  if (
    normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("credential")
    || normalized.includes("apikey")
    || normalized.includes("authorization")
    || normalized.includes("cookie")
  ) return "credential";
  if (
    normalized === "log"
    || normalized.endsWith("logs")
    || normalized.includes("rawlog")
    || normalized.includes("network")
    || normalized.includes("performance")
    || normalized === "perf"
    || normalized.endsWith("trace")
    || normalized.includes("video")
  ) return "telemetry";
  if (
    normalized.includes("sourcepath")
    || normalized.includes("sourcefile")
    || normalized.includes("filepath")
    || normalized.includes("filename")
    || normalized === "cwd"
    || normalized.includes("workingdirectory")
  ) return "source-path";
  return undefined;
}

function rejectForbiddenFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectForbiddenFields(entry);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const category = forbiddenCategory(key);
    if (category) {
      throw new Error(`Runtime evidence contains forbidden ${category} data`);
    }
    rejectForbiddenFields(entry);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is incomplete`);
  }
}

function literal<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string,
): Value {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`${label} is invalid`);
  return found;
}

function safeString(value: unknown, label: string, maxLength = 2_048): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const id = safeString(value, label, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

function safeRoute(value: unknown, label: string): string {
  const route = safeString(value, label);
  const queryIndex = route.indexOf("?");
  const pathname = queryIndex === -1 ? route : route.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : route.slice(queryIndex + 1);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const segments = decodedPathname.split("/");
  if (
    !pathname.startsWith("/")
    || pathname.startsWith("//")
    || !pathname
    || route.includes("#")
    || decodedPathname.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(decodedPathname)
    || segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is invalid`);
  }
  if (queryIndex !== -1) {
    if (!query) throw new Error(`${label} is invalid`);
    const parameters = new URLSearchParams(query);
    for (const [key, parameterValue] of parameters) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        !key
        || /[\u0000-\u001f\u007f]/.test(key)
        || /[\u0000-\u001f\u007f]/.test(parameterValue)
        || ["token", "secret", "key", "password", "auth", "cookie"]
          .some((credential) => normalizedKey.includes(credential))
      ) {
        throw new Error(`${label} is invalid`);
      }
    }
  }
  return route;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = safeString(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)) {
    throw new Error(`${label} is invalid`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  const canonical = timestamp.includes(".")
    ? timestamp.replace(/\.(\d{1,3})Z$/, (_match, fraction: string) => (
      `.${fraction.padEnd(3, "0")}Z`
    ))
    : timestamp.replace(/Z$/, ".000Z");
  const normalized = new Date(milliseconds).toISOString();
  if (normalized !== canonical) throw new Error(`${label} is invalid`);
  return normalized;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (number === 0) throw new Error(`${label} is invalid`);
  return number;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  return Object.hasOwn(value, key) ? safeString(value[key], label) : undefined;
}

function parseContext(value: unknown): ConfiguredCaptureContext {
  const context = record(value, "Capture context");
  exactKeys(
    context,
    [
      "kind",
      "side",
      "logicalBuild",
      "profile",
      "surfaceId",
      "route",
      "variantId",
      "observationId",
      "expectedSampleCount",
    ],
    ["state", "fixturePersona", "controllerPackageVersion", "easCliVersion"],
    "Capture context",
  );
  const state = optionalString(context, "state", "Capture state");
  const fixturePersona = optionalString(context, "fixturePersona", "Fixture persona");
  const controllerPackageVersion = optionalString(
    context,
    "controllerPackageVersion",
    "Controller package version",
  );
  const easCliVersion = optionalString(context, "easCliVersion", "EAS CLI version");
  return {
    kind: literal(context.kind, ["configured-capture-context"], "Capture context kind"),
    side: literal(context.side, SIDES, "Capture side"),
    logicalBuild: safeId(context.logicalBuild, "Logical build"),
    profile: safeId(context.profile, "Capture profile"),
    surfaceId: safeId(context.surfaceId, "Surface id"),
    route: safeRoute(context.route, "Route"),
    variantId: safeId(context.variantId, "Variant id"),
    observationId: safeId(context.observationId, "Observation id"),
    expectedSampleCount: positiveInteger(context.expectedSampleCount, "Expected sample count"),
    ...(state === undefined ? {} : { state }),
    ...(fixturePersona === undefined ? {} : { fixturePersona }),
    ...(controllerPackageVersion === undefined ? {} : { controllerPackageVersion }),
    ...(easCliVersion === undefined ? {} : { easCliVersion }),
  };
}

function parseAccessibilityElement(value: unknown): RawAccessibilityElement {
  const element = record(value, "Accessibility element");
  exactKeys(
    element,
    ["id", "role", "label", "actionable"],
    ["landmark"],
    "Accessibility element",
  );
  return {
    id: safeId(element.id, "Accessibility element id"),
    role: literal(element.role, ELEMENT_ROLES, "Accessibility role"),
    label: safeString(element.label, "Accessibility label"),
    actionable: booleanValue(element.actionable, "Accessibility actionable flag"),
    ...(Object.hasOwn(element, "landmark")
      ? { landmark: booleanValue(element.landmark, "Accessibility landmark flag") }
      : {}),
  };
}

function uniqueById<Value extends { id: string }>(values: Value[], label: string): Value[] {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`${label} contains duplicate ids`);
    ids.add(value.id);
  }
  return values;
}

function parseAccessibility(value: unknown): RawAccessibilityEvidence {
  const accessibility = record(value, "Accessibility evidence");
  exactKeys(accessibility, ["truncated", "elements"], [], "Accessibility evidence");
  if (!Array.isArray(accessibility.elements)) {
    throw new Error("Accessibility elements must be an array");
  }
  return {
    truncated: booleanValue(accessibility.truncated, "Accessibility truncation flag"),
    elements: uniqueById(
      accessibility.elements.map(parseAccessibilityElement),
      "Accessibility evidence",
    ),
  };
}

function parseObservation(value: unknown): RawObservedScreen {
  const observation = record(value, "Runtime observation");
  exactKeys(
    observation,
    ["id", "variantId", "capturedAt", "surfaceScope", "accessibility"],
    [],
    "Runtime observation",
  );
  return {
    id: safeId(observation.id, "Runtime observation id"),
    variantId: safeId(observation.variantId, "Runtime variant id"),
    capturedAt: isoTimestamp(observation.capturedAt, "Runtime capture time"),
    surfaceScope: literal(observation.surfaceScope, SURFACE_SCOPES, "Surface scope"),
    accessibility: parseAccessibility(observation.accessibility),
  };
}

function parseTarget(value: unknown): RawInteractionTarget {
  const target = record(value, "Interaction target");
  exactKeys(target, ["surfaceId", "route"], [], "Interaction target");
  return {
    surfaceId: safeId(target.surfaceId, "Target surface id"),
    route: safeRoute(target.route, "Target route"),
  };
}

function parseInteraction(value: unknown): RawInteractionEvidence {
  const interaction = record(value, "Interaction evidence");
  exactKeys(
    interaction,
    [
      "id",
      "observationId",
      "action",
      "label",
      "outcome",
      "startedAt",
      "completedAt",
      "durationMs",
    ],
    ["target"],
    "Interaction evidence",
  );
  const startedAt = isoTimestamp(interaction.startedAt, "Interaction start time");
  const completedAt = isoTimestamp(interaction.completedAt, "Interaction completion time");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error("Interaction completion precedes its start");
  }
  const outcome = literal(interaction.outcome, ACTION_OUTCOMES, "Interaction outcome");
  const target = Object.hasOwn(interaction, "target")
    ? parseTarget(interaction.target)
    : undefined;
  if (outcome === "transition" && target === undefined) {
    throw new Error("Transition evidence requires a target");
  }
  return {
    id: safeId(interaction.id, "Interaction id"),
    observationId: safeId(interaction.observationId, "Interaction observation id"),
    action: literal(interaction.action, ACTION_KINDS, "Interaction action"),
    label: safeString(interaction.label, "Interaction label"),
    outcome,
    startedAt,
    completedAt,
    durationMs: nonNegativeNumber(interaction.durationMs, "Interaction duration"),
    ...(target === undefined ? {} : { target }),
  };
}

function fingerprint(value: unknown, label: string): string {
  const result = safeString(value, label, 512);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function parseFingerprints(value: unknown): RawCaptureFingerprints {
  const fingerprints = record(value, "Capture fingerprints");
  exactKeys(
    fingerprints,
    ["combined", "visual"],
    ["accessibility"],
    "Capture fingerprints",
  );
  const accessibility = Object.hasOwn(fingerprints, "accessibility")
    ? fingerprint(fingerprints.accessibility, "Accessibility fingerprint")
    : undefined;
  return {
    combined: fingerprint(fingerprints.combined, "Combined fingerprint"),
    visual: fingerprint(fingerprints.visual, "Visual fingerprint"),
    ...(accessibility === undefined ? {} : { accessibility }),
  };
}

function parseCapture(value: unknown): RawCaptureSample {
  const capture = record(value, "Capture sample");
  exactKeys(
    capture,
    [
      "id",
      "observationId",
      "variantId",
      "capturedAt",
      "widthPixels",
      "heightPixels",
      "fingerprints",
    ],
    ["pixelDensity"],
    "Capture sample",
  );
  return {
    id: safeId(capture.id, "Capture sample id"),
    observationId: safeId(capture.observationId, "Capture observation id"),
    variantId: safeId(capture.variantId, "Capture variant id"),
    capturedAt: isoTimestamp(capture.capturedAt, "Capture sample time"),
    widthPixels: positiveInteger(capture.widthPixels, "Capture width"),
    heightPixels: positiveInteger(capture.heightPixels, "Capture height"),
    ...(Object.hasOwn(capture, "pixelDensity")
      ? { pixelDensity: positiveNumber(capture.pixelDensity, "Capture pixel density") }
      : {}),
    fingerprints: parseFingerprints(capture.fingerprints),
  };
}

function parseEnvironment(value: unknown): RawSimulatorEnvironment {
  const environment = record(value, "Runtime environment");
  exactKeys(
    environment,
    [
      "provider",
      "controller",
      "platform",
      "deviceModel",
      "osVersion",
      "locale",
      "orientation",
      "colorScheme",
      "sessionLifecycle",
    ],
    [],
    "Runtime environment",
  );
  return {
    provider: literal(environment.provider, ["eas-simulator"], "Runtime provider"),
    controller: literal(environment.controller, ["agent-device", "argent"], "Runtime controller"),
    platform: literal(environment.platform, PLATFORMS, "Runtime platform"),
    deviceModel: safeString(environment.deviceModel, "Device model", 256),
    osVersion: safeString(environment.osVersion, "OS version", 256),
    locale: safeString(environment.locale, "Locale", 64),
    orientation: literal(
      environment.orientation,
      ["portrait", "landscape"],
      "Runtime orientation",
    ),
    colorScheme: literal(
      environment.colorScheme,
      ["light", "dark", "system"],
      "Runtime color scheme",
    ),
    sessionLifecycle: literal(
      environment.sessionLifecycle,
      ["starting", "ready", "capturing", "stopped"],
      "Session lifecycle",
    ),
  };
}

function parseRuntime(value: unknown): EasAgentDeviceRawEvidence {
  const runtime = record(value, "Raw runtime evidence");
  exactKeys(
    runtime,
    ["kind", "observation", "interactions", "captures", "environment"],
    [],
    "Raw runtime evidence",
  );
  if (!Array.isArray(runtime.interactions)) {
    throw new Error("Runtime interactions must be an array");
  }
  if (!Array.isArray(runtime.captures) || runtime.captures.length === 0) {
    throw new Error("Runtime captures must be a non-empty array");
  }
  return {
    kind: literal(runtime.kind, ["eas-agent-device-raw"], "Runtime evidence kind"),
    observation: parseObservation(runtime.observation),
    interactions: uniqueById(
      runtime.interactions.map(parseInteraction),
      "Runtime interactions",
    ),
    captures: uniqueById(runtime.captures.map(parseCapture), "Runtime captures"),
    environment: parseEnvironment(runtime.environment),
  };
}

function parseDiagnosticEntry(value: unknown): RuntimeDiagnosticEntry {
  const entry = record(value, "Diagnostics entry");
  exactKeys(entry, ["code", "title", "value", "origin"], [], "Diagnostics entry");
  const code = literal(entry.code, RUNTIME_DIAGNOSTIC_CODES, "Diagnostics code");
  switch (code) {
    case "capture.sample-plan":
      return {
        code,
        title: literal(entry.title, ["Capture sample plan"], "Diagnostics title"),
        value: literal(entry.value, ["single", "triple"], "Diagnostics value"),
        origin: literal(entry.origin, ["capture-context"], "Diagnostics origin"),
      };
    case "capture.sample-shortfall":
      return {
        code,
        title: literal(entry.title, ["Capture sample anomaly"], "Diagnostics title"),
        value: literal(entry.value, ["shortfall"], "Diagnostics value"),
        origin: literal(entry.origin, ["derived"], "Diagnostics origin"),
      };
    case "capture.stability-unstable":
      return {
        code,
        title: literal(entry.title, ["Capture stability anomaly"], "Diagnostics title"),
        value: literal(entry.value, ["unstable"], "Diagnostics value"),
        origin: literal(entry.origin, ["derived"], "Diagnostics origin"),
      };
    case "ui.accessibility-truncated":
      return {
        code,
        title: literal(entry.title, ["Accessibility snapshot truncated"], "Diagnostics title"),
        value: literal(entry.value, ["truncated"], "Diagnostics value"),
        origin: literal(entry.origin, ["eas-agent-device"], "Diagnostics origin"),
      };
    case "ui.accessibility-empty":
      return {
        code,
        title: literal(entry.title, ["Accessibility snapshot empty"], "Diagnostics title"),
        value: literal(entry.value, ["empty"], "Diagnostics value"),
        origin: literal(entry.origin, ["derived"], "Diagnostics origin"),
      };
    case "interaction.failed":
      return {
        code,
        title: literal(entry.title, ["Interaction failed"], "Diagnostics title"),
        value: literal(entry.value, ["failed"], "Diagnostics value"),
        origin: literal(entry.origin, ["eas-agent-device"], "Diagnostics origin"),
      };
    case "interaction.blocked":
      return {
        code,
        title: literal(entry.title, ["Interaction blocked"], "Diagnostics title"),
        value: literal(entry.value, ["blocked"], "Diagnostics value"),
        origin: literal(entry.origin, ["eas-agent-device"], "Diagnostics origin"),
      };
  }
}

function diagnosticsFactExists(
  entry: RuntimeDiagnosticEntry,
  context: ConfiguredCaptureContext,
  runtime: EasAgentDeviceRawEvidence,
): boolean {
  switch (entry.code) {
    case "capture.sample-plan":
      return context.expectedSampleCount === (entry.value === "single" ? 1 : 3);
    case "capture.sample-shortfall":
      return runtime.captures.length < context.expectedSampleCount;
    case "capture.stability-unstable":
      return captureStability(runtime.captures) === "unstable";
    case "ui.accessibility-truncated":
      return runtime.observation.accessibility.truncated;
    case "ui.accessibility-empty":
      return snapshotQuality(runtime.observation.accessibility) === "empty";
    case "interaction.failed":
      return runtime.interactions.some((interaction) => interaction.outcome === "failed");
    case "interaction.blocked":
      return runtime.interactions.some((interaction) => interaction.outcome === "blocked");
  }
}

function parseDiagnostics(
  value: unknown,
  context: ConfiguredCaptureContext,
  runtime: EasAgentDeviceRawEvidence,
): RuntimeDiagnosticsExtension {
  const diagnostics = record(value, "Diagnostics extension");
  exactKeys(diagnostics, ["kind", "entries"], [], "Diagnostics extension");
  if (!Array.isArray(diagnostics.entries) || diagnostics.entries.length === 0) {
    throw new Error("Diagnostics extension must contain at least one safe entry");
  }
  const entries = diagnostics.entries.map(parseDiagnosticEntry);
  const codes = new Set<RuntimeDiagnosticEntry["code"]>();
  for (const entry of entries) {
    if (codes.has(entry.code)) throw new Error("Diagnostics extension contains duplicate codes");
    codes.add(entry.code);
    if (!diagnosticsFactExists(entry, context, runtime)) {
      throw new Error("Diagnostics entry is not supported by runtime evidence");
    }
  }
  entries.sort((left, right) => (
    RUNTIME_DIAGNOSTIC_CODES.indexOf(left.code)
    - RUNTIME_DIAGNOSTIC_CODES.indexOf(right.code)
  ));
  const [first, ...rest] = entries;
  if (!first) throw new Error("Diagnostics extension must contain at least one safe entry");
  return {
    kind: literal(diagnostics.kind, ["diagnostics-extension"], "Diagnostics kind"),
    entries: [first, ...rest],
  };
}

function parseInput(value: unknown): RuntimeEvidenceInput {
  rejectForbiddenFields(value);
  const input = record(value, "Runtime evidence input");
  exactKeys(input, ["context", "runtime"], ["diagnostics"], "Runtime evidence input");
  const context = parseContext(input.context);
  const runtime = parseRuntime(input.runtime);
  const diagnostics = Object.hasOwn(input, "diagnostics")
    ? parseDiagnostics(input.diagnostics, context, runtime)
    : undefined;
  return {
    context,
    runtime,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function configured<Value>(value: Value): EvidenceField<"capture-context", Value> {
  return { origin: "capture-context", value };
}

function raw<Value>(value: Value): EvidenceField<"eas-agent-device", Value> {
  return { origin: "eas-agent-device", value };
}

function derived<Value>(value: Value): EvidenceField<"derived", Value> {
  return { origin: "derived", value };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedElements(elements: RawAccessibilityElement[]): RawAccessibilityElement[] {
  return [...elements].sort((left, right) => (
    compareText(left.role, right.role)
    || compareText(left.label, right.label)
    || compareText(left.id, right.id)
  ));
}

function roleCounts(elements: readonly RawAccessibilityElement[]): NormalizedRoleCount[] {
  const counts = new Map<ElementRole, number>();
  for (const element of elements) counts.set(element.role, (counts.get(element.role) ?? 0) + 1);
  return ELEMENT_ROLES
    .filter((role) => counts.has(role))
    .map((role) => ({ role, count: counts.get(role) ?? 0 }));
}

function landmarks(elements: readonly RawAccessibilityElement[]): NormalizedLandmark[] {
  return elements
    .filter((element) => element.landmark)
    .map(({ id, role, label }) => ({ id, role, label }));
}

function snapshotQuality(accessibility: RawAccessibilityEvidence): SnapshotQuality {
  if (accessibility.truncated) return "truncated";
  return accessibility.elements.length === 0 ? "empty" : "complete";
}

function normalizedInteractions(interactions: RawInteractionEvidence[]): NormalizedInteraction[] {
  return [...interactions].sort((left, right) => (
    compareText(left.startedAt, right.startedAt) || compareText(left.id, right.id)
  ));
}

function outcomeCounts(interactions: readonly RawInteractionEvidence[]): InteractionOutcomeCounts {
  const counts: InteractionOutcomeCounts = {
    transition: 0,
    "same-screen": 0,
    "no-change": 0,
    failed: 0,
    blocked: 0,
    external: 0,
  };
  for (const interaction of interactions) counts[interaction.outcome] += 1;
  return counts;
}

function normalizedCaptures(captures: RawCaptureSample[]): NormalizedCaptureSample[] {
  return [...captures].sort((left, right) => (
    compareText(left.capturedAt, right.capturedAt) || compareText(left.id, right.id)
  ));
}

// Repeated samples are judged on their accessibility tree; pixel-level noise between relaunches
// is measured separately by the visual evidence assessment with its own tolerance.
function stabilityKey(capture: RawCaptureSample): string {
  return capture.fingerprints.accessibility ?? capture.fingerprints.combined;
}

function captureStability(captures: readonly RawCaptureSample[]): CaptureStability {
  if (captures.length === 1) return "single-sample";
  const first = captures[0];
  if (!first) return "single-sample";
  return captures.every((capture) => stabilityKey(capture) === stabilityKey(first))
    ? "stable"
    : "unstable";
}

function dimensions(captures: readonly RawCaptureSample[]): CaptureDimensions[] {
  const keys = new Set<string>();
  const result: CaptureDimensions[] = [];
  for (const capture of captures) {
    const key = `${capture.widthPixels}x${capture.heightPixels}`;
    if (keys.has(key)) continue;
    keys.add(key);
    result.push({ widthPixels: capture.widthPixels, heightPixels: capture.heightPixels });
  }
  return result.sort((left, right) => (
    left.widthPixels - right.widthPixels || left.heightPixels - right.heightPixels
  ));
}

function pixelDensities(captures: readonly RawCaptureSample[]): number[] {
  return [...new Set(captures.flatMap((capture) => (
    capture.pixelDensity === undefined ? [] : [capture.pixelDensity]
  )))].sort((a, b) => a - b);
}

function coverage(expected: number, captured: number): CaptureCoverage {
  return {
    expected,
    captured,
    ratio: Math.round((captured / expected) * 1_000_000) / 1_000_000,
    complete: captured === expected,
  };
}

function validateScope(input: RuntimeEvidenceInput): void {
  const { context, runtime } = input;
  if (runtime.observation.id !== context.observationId) {
    throw new Error("Runtime observation does not match the configured observation scope");
  }
  if (runtime.observation.variantId !== context.variantId) {
    throw new Error("Runtime observation does not match the configured variant scope");
  }
  if (runtime.captures.some((capture) => capture.variantId !== context.variantId)) {
    throw new Error("Capture sample escaped the configured variant scope");
  }
  // The configured observation is the representative screen snapshot.
  // Stability samples are separate Explore observations in the same variant,
  // so each sample keeps its own observation id. Variant scope remains strict.
  if (runtime.interactions.some((interaction) => interaction.observationId !== context.observationId)) {
    throw new Error("Interaction escaped the configured observation scope");
  }
  if (runtime.captures.length > context.expectedSampleCount) {
    throw new Error("Captured samples exceed the configured sample scope");
  }
}

function assertJsonSafe(value: unknown): void {
  const visited = new Set<object>();
  function visit(candidate: unknown): void {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("Runtime evidence is not JSON-safe");
      return;
    }
    if (Array.isArray(candidate)) {
      if (visited.has(candidate)) throw new Error("Runtime evidence is not JSON-safe");
      visited.add(candidate);
      for (const entry of candidate) visit(entry);
      return;
    }
    if (isRecord(candidate)) {
      if (visited.has(candidate)) throw new Error("Runtime evidence is not JSON-safe");
      visited.add(candidate);
      for (const entry of Object.values(candidate)) {
        if (entry === undefined) throw new Error("Runtime evidence is not JSON-safe");
        visit(entry);
      }
      return;
    }
    throw new Error("Runtime evidence is not JSON-safe");
  }
  visit(value);
}

/** Project five required groups and, when supplied, a non-empty validated Diagnostics group. */
export function projectRuntimeEvidence(value: unknown): RuntimeEvidence {
  const input = parseInput(value);
  validateScope(input);
  const { context, runtime } = input;
  const elements = normalizedElements(runtime.observation.accessibility.elements);
  const interactions = normalizedInteractions(runtime.interactions);
  const captures = normalizedCaptures(runtime.captures);
  const state = context.state === undefined ? {} : { state: configured(context.state) };
  const fixturePersona = context.fixturePersona === undefined
    ? {}
    : { fixturePersona: configured(context.fixturePersona) };
  const controllerPackageVersion = context.controllerPackageVersion === undefined
    ? {}
    : { controllerPackageVersion: configured(context.controllerPackageVersion) };
  const easCliVersion = context.easCliVersion === undefined
    ? {}
    : { easCliVersion: configured(context.easCliVersion) };
  const diagnostics: { diagnostics?: RuntimeDiagnosticsEvidence } = input.diagnostics === undefined
    ? {}
    : { diagnostics: { id: "diagnostics", entries: input.diagnostics.entries } };
  const result: RuntimeEvidence = {
    contract: RUNTIME_EVIDENCE_CONTRACT,
    groups: {
      screen: {
        id: "screen",
        side: configured(context.side),
        logicalBuild: configured(context.logicalBuild),
        route: configured(context.route),
        surfaceId: configured(context.surfaceId),
        ...state,
        variantId: configured(context.variantId),
        observationId: raw(runtime.observation.id),
        surfaceScope: raw(runtime.observation.surfaceScope),
        capturedAt: raw(runtime.observation.capturedAt),
      },
      ui: {
        id: "ui",
        elementCount: derived(elements.length),
        actionableCount: derived(elements.filter((element) => element.actionable).length),
        roleCounts: derived(roleCounts(elements)),
        landmarks: derived(landmarks(elements)),
        snapshotQuality: derived(snapshotQuality(runtime.observation.accessibility)),
        truncated: raw(runtime.observation.accessibility.truncated),
      },
      interaction: {
        id: "interaction",
        attempts: raw(interactions),
        outcomeCounts: derived(outcomeCounts(interactions)),
        transitionCount: derived(
          interactions.filter((interaction) => interaction.outcome === "transition").length,
        ),
      },
      capture: {
        id: "capture",
        samples: raw(captures),
        sampleCount: derived(captures.length),
        stability: derived(captureStability(captures)),
        dimensions: derived(dimensions(captures)),
        pixelDensities: derived(pixelDensities(captures)),
        coverage: derived(coverage(context.expectedSampleCount, captures.length)),
      },
      environment: {
        id: "environment",
        profile: configured(context.profile),
        ...fixturePersona,
        provider: raw(runtime.environment.provider),
        controller: raw(runtime.environment.controller),
        ...controllerPackageVersion,
        ...easCliVersion,
        platform: raw(runtime.environment.platform),
        deviceModel: raw(runtime.environment.deviceModel),
        osVersion: raw(runtime.environment.osVersion),
        locale: raw(runtime.environment.locale),
        orientation: raw(runtime.environment.orientation),
        colorScheme: raw(runtime.environment.colorScheme),
        sessionLifecycle: raw(runtime.environment.sessionLifecycle),
      },
      ...diagnostics,
    },
  };
  assertJsonSafe(result);
  return result;
}

function requireSide(evidence: RuntimeEvidence, side: EvidenceSide, label: string): void {
  if (evidence.groups.screen.side.value !== side) {
    throw new Error(`${label} evidence has the wrong side scope`);
  }
}

/**
 * Project side-scoped evidence without permitting an absent screen to borrow the other side.
 * In particular, removed screens are base-only and can never carry a head environment.
 */
export function projectRuntimeEvidenceComparison(value: unknown): RuntimeEvidenceComparison {
  rejectForbiddenFields(value);
  const comparison = record(value, "Runtime evidence comparison");
  const status = literal(
    comparison.status,
    ["added", "removed", "modified", "unchanged"],
    "Runtime change status",
  );
  if (status === "added") {
    exactKeys(comparison, ["status", "head"], [], "Added runtime evidence comparison");
    const head = projectRuntimeEvidence(comparison.head);
    requireSide(head, "head", "Added");
    const result: AddedRuntimeEvidenceComparison = {
      contract: RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
      status,
      head,
    };
    assertJsonSafe(result);
    return result;
  }
  if (status === "removed") {
    exactKeys(comparison, ["status", "base"], [], "Removed runtime evidence comparison");
    const base = projectRuntimeEvidence(comparison.base);
    requireSide(base, "base", "Removed");
    const result: RemovedRuntimeEvidenceComparison = {
      contract: RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
      status,
      base,
    };
    assertJsonSafe(result);
    return result;
  }
  exactKeys(comparison, ["status", "base", "head"], [], "Common runtime evidence comparison");
  const base = projectRuntimeEvidence(comparison.base);
  const head = projectRuntimeEvidence(comparison.head);
  requireSide(base, "base", "Base");
  requireSide(head, "head", "Head");
  const result: CommonRuntimeEvidenceComparison = {
    contract: RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
    status,
    base,
    head,
  };
  assertJsonSafe(result);
  return result;
}

/** Stable JSON for hashing, sidecars, and publication after validation and normalization. */
export function serializeRuntimeEvidence(value: unknown): string {
  return `${JSON.stringify(projectRuntimeEvidence(value))}\n`;
}

export const RUNTIME_EVIDENCE_GROUP_ORDER = [
  "screen",
  "ui",
  "interaction",
  "capture",
  "environment",
] satisfies RuntimeEvidenceGroupKey[];
