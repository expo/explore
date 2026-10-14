import {
  AGENT_DEVICE_VERSION,
  EAS_CLI_VERSION,
} from "../capture/run.js";
import type {
  ConfiguredCaptureContext,
  EasAgentDeviceRawEvidence,
  RawCaptureSample,
  RawInteractionEvidence,
  RuntimeEvidenceInput,
} from "./runtime-evidence.js";
import type { ExploreMap, Observation, Screen } from "../types.js";
import { CAPTURE_OBSERVER_IDENTIFIER } from "../capture/observer.js";

/** Strict, non-secret subset written after a successful EAS Simulator cleanup. */
export type RuntimeExecutionContext = {
  provider: "eas-simulator";
  controller: "agent-device";
  controllerPackageVersion: typeof AGENT_DEVICE_VERSION;
  easCliVersion: typeof EAS_CLI_VERSION;
  platform: "ios" | "android";
  deviceModel: string;
  osVersion: string;
  locale: string;
  orientation: "portrait" | "landscape";
  colorScheme: "light" | "dark" | "system";
  /** Every appearance the capture rendered, first the primary one; absent for a single-appearance capture. */
  colorSchemes?: ("light" | "dark")[];
  sessionLifecycle: "stopped";
};

export type RuntimeEvidenceFromMapOptions = {
  side: "base" | "head";
  map: ExploreMap;
  screenId: string;
  representativeObservationId: string;
  /** Exact observations selected by the capture plan; may be fewer than expected on an incomplete run. */
  sampleObservationIds: string[];
  expectedSampleCount: 1 | 3;
  profile: string;
  execution: RuntimeExecutionContext;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
  }
}

function safeText(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || !value
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function literal<const Value extends string>(
  value: unknown,
  values: readonly Value[],
  label: string,
): Value {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`${label} is invalid`);
  return found;
}

export function parseRuntimeExecutionContext(value: unknown): RuntimeExecutionContext {
  const context = record(value, "Runtime execution context");
  exactKeys(context, [
    "provider",
    "controller",
    "controllerPackageVersion",
    "easCliVersion",
    "platform",
    "deviceModel",
    "osVersion",
    "locale",
    "orientation",
    "colorScheme",
    "sessionLifecycle",
  ], "Runtime execution context", ["colorSchemes"]);
  const colorSchemes = context.colorSchemes === undefined ? undefined : (() => {
    if (!Array.isArray(context.colorSchemes) || context.colorSchemes.length === 0) {
      throw new Error("Runtime color schemes must list at least one appearance");
    }
    return context.colorSchemes.map((entry) => literal(entry, ["light", "dark"], "Runtime color schemes"));
  })();
  return {
    provider: literal(context.provider, ["eas-simulator"], "Runtime provider"),
    controller: literal(context.controller, ["agent-device"], "Runtime controller"),
    controllerPackageVersion: literal(
      context.controllerPackageVersion,
      [AGENT_DEVICE_VERSION],
      "Controller package version",
    ),
    easCliVersion: literal(context.easCliVersion, [EAS_CLI_VERSION], "EAS CLI version"),
    platform: literal(context.platform, ["ios", "android"], "Runtime platform"),
    deviceModel: safeText(context.deviceModel, "Runtime device model"),
    osVersion: safeText(context.osVersion, "Runtime OS version"),
    locale: safeText(context.locale, "Runtime locale", 64),
    orientation: literal(
      context.orientation,
      ["portrait", "landscape"],
      "Runtime orientation",
    ),
    colorScheme: literal(
      context.colorScheme,
      ["light", "dark", "system"],
      "Runtime color scheme",
    ),
    ...(colorSchemes ? { colorSchemes } : {}),
    sessionLifecycle: literal(
      context.sessionLifecycle,
      ["stopped"],
      "Runtime session lifecycle",
    ),
  };
}

function requiredScreen(map: ExploreMap, id: string): Screen & { route: string } {
  const screen = map.screens.find((candidate) => candidate.id === id);
  if (!screen) throw new Error(`Runtime surface is missing from the map: ${id}`);
  if (!screen.route) throw new Error(`Runtime surface is missing its canonical route: ${id}`);
  return screen as Screen & { route: string };
}

function requiredObservation(map: ExploreMap, id: string): Observation {
  const observation = map.observations.find((candidate) => candidate.id === id);
  if (!observation) throw new Error(`Runtime observation is missing from the map: ${id}`);
  return observation;
}

function compareEnvironment(
  observed: string | undefined,
  expected: string,
  label: string,
): void {
  if (!observed) throw new Error(`Map runtime environment is missing ${label}`);
  if (observed !== expected) {
    throw new Error(`Map runtime environment ${label} does not match EAS Simulator context`);
  }
}

function captureSample(map: ExploreMap, observation: Observation): RawCaptureSample {
  if (!observation.screenshotArtifactId) {
    throw new Error(`Runtime observation has no screenshot: ${observation.id}`);
  }
  const artifact = map.artifacts.find((candidate) => candidate.id === observation.screenshotArtifactId);
  if (!artifact || artifact.kind !== "screenshot") {
    throw new Error(`Runtime screenshot artifact is missing: ${observation.screenshotArtifactId}`);
  }
  if (!artifact.width || !artifact.height) {
    throw new Error(`Runtime screenshot dimensions are missing: ${artifact.id}`);
  }
  if (!observation.fingerprints.visual) {
    throw new Error(`Runtime visual fingerprint is missing: ${observation.id}`);
  }
  return {
    id: `${observation.id}:capture`,
    observationId: observation.id,
    variantId: observation.variantId,
    capturedAt: observation.capturedAt,
    widthPixels: artifact.width,
    heightPixels: artifact.height,
    fingerprints: {
      combined: observation.fingerprints.combined,
      visual: observation.fingerprints.visual,
      ...(observation.fingerprints.accessibility
        ? { accessibility: observation.fingerprints.accessibility }
        : {}),
    },
  };
}

function interactionEvidence(
  map: ExploreMap,
  representative: Observation,
): RawInteractionEvidence[] {
  const screens = new Map(map.screens.map((screen) => [screen.id, screen]));
  return map.actionAttempts
    .filter((attempt) => attempt.sourceObservationId === representative.id)
    .map((attempt): RawInteractionEvidence => {
      let target: RawInteractionEvidence["target"];
      if (attempt.outcome === "transition") {
        const targetScreen = attempt.targetScreenId
          ? screens.get(attempt.targetScreenId)
          : undefined;
        if (!targetScreen?.route) {
          throw new Error(`Runtime transition has no canonical target route: ${attempt.id}`);
        }
        target = { surfaceId: targetScreen.id, route: targetScreen.route };
      }
      const measuredDuration = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt);
      const durationMs = attempt.durationMs ?? measuredDuration;
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(`Runtime interaction duration is invalid: ${attempt.id}`);
      }
      return {
        id: attempt.id,
        observationId: representative.id,
        action: attempt.action.kind,
        label: attempt.action.label,
        outcome: attempt.outcome,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        durationMs,
        ...(target ? { target } : {}),
      };
    });
}

/**
 * Convert one exact map surface into raw Runtime Evidence input without
 * inferring controller facts. Validation/projection remains owned by
 * projectRuntimeEvidence.
 */
export function runtimeEvidenceInputFromMap(
  options: RuntimeEvidenceFromMapOptions,
): RuntimeEvidenceInput {
  const { map, execution } = options;
  if (map.run.status !== "complete" && map.run.status !== "partial") {
    throw new Error(`Runtime map must have finished capture, received ${map.run.status}`);
  }
  if (map.run.controller !== execution.controller || map.run.platform !== execution.platform) {
    throw new Error("Map controller or platform does not match EAS Simulator context");
  }
  compareEnvironment(map.run.environment.deviceModel, execution.deviceModel, "device model");
  compareEnvironment(map.run.environment.osVersion, execution.osVersion, "OS version");
  compareEnvironment(map.run.environment.locale, execution.locale, "locale");
  compareEnvironment(map.run.environment.orientation, execution.orientation, "orientation");
  compareEnvironment(map.run.environment.colorScheme, execution.colorScheme, "color scheme");
  const logicalBuild = map.run.build.gitCommit;
  if (!logicalBuild || !/^[0-9a-f]{40}$/i.test(logicalBuild)) {
    throw new Error("Runtime map is missing its exact full Git commit");
  }

  const screen = requiredScreen(map, options.screenId);
  const representative = requiredObservation(map, options.representativeObservationId);
  if (representative.screenId !== screen.id || !screen.observationIds.includes(representative.id)) {
    throw new Error("Representative observation does not belong to the configured surface");
  }
  const sampleIds = new Set<string>();
  const samples = options.sampleObservationIds.map((id) => {
    if (sampleIds.has(id)) throw new Error(`Repeated runtime sample observation: ${id}`);
    sampleIds.add(id);
    const observation = requiredObservation(map, id);
    if (observation.screenId !== screen.id || observation.variantId !== representative.variantId) {
      throw new Error(`Runtime sample escaped the configured surface variant: ${id}`);
    }
    return captureSample(map, observation);
  });
  if (samples.length !== options.expectedSampleCount) {
    throw new Error(
      `Runtime evidence expected ${options.expectedSampleCount} capture samples, received ${samples.length}`,
    );
  }

  const context: ConfiguredCaptureContext = {
    kind: "configured-capture-context",
    side: options.side,
    logicalBuild: logicalBuild.toLowerCase(),
    profile: options.profile,
    surfaceId: screen.id,
    route: screen.route,
    ...(screen.state ? { state: screen.state } : {}),
    variantId: representative.variantId,
    observationId: representative.id,
    expectedSampleCount: options.expectedSampleCount,
    ...(map.run.environment.authPersona
      ? { fixturePersona: map.run.environment.authPersona }
      : {}),
    controllerPackageVersion: execution.controllerPackageVersion,
    easCliVersion: execution.easCliVersion,
  };
  const runtime: EasAgentDeviceRawEvidence = {
    kind: "eas-agent-device-raw",
    observation: {
      id: representative.id,
      variantId: representative.variantId,
      capturedAt: representative.capturedAt,
      surfaceScope: representative.surfaceScope,
      accessibility: {
        // Controller parse warnings become coverage gaps. An open gap means the
        // snapshot was never reviewed; an accepted or resolved one records that a
        // reviewer (or the CI closure) judged the inventory complete.
        truncated: map.gaps.some((gap) => (
          gap.kind === "controller-parse"
          && gap.status === "open"
          && (gap.observationId === undefined || gap.observationId === representative.id)
        )),
        elements: representative.elements
          .filter((element) => element.identifier !== "expo-explore-route"
            && element.identifier !== CAPTURE_OBSERVER_IDENTIFIER)
          .map((element) => ({
            id: element.elementId,
            role: element.role,
            // Multi-line native labels keep their words; the evidence contract forbids control characters.
            label: element.label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim(),
            actionable: element.actionable,
          })),
      },
    },
    interactions: interactionEvidence(map, representative),
    captures: samples,
    environment: {
      provider: execution.provider,
      controller: execution.controller,
      platform: execution.platform,
      deviceModel: execution.deviceModel,
      osVersion: execution.osVersion,
      locale: execution.locale,
      orientation: execution.orientation,
      colorScheme: execution.colorScheme,
      sessionLifecycle: execution.sessionLifecycle,
    },
  };
  return { context, runtime };
}
