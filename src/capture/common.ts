import { CiError } from "../shared/ci-errors.js";

export const EAS_CLI_VERSION = "24.4.2";
export { AGENT_DEVICE_VERSION } from "../shared/agent-device-version.js";

export const CONTROLLER_SESSION = "expo-explore-runtime";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function baseEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_HOME",
    "JAVA_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "SHELL",
    "USER",
    "LOGNAME",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    // repack-app signs Android APKs with the SDK build-tools; Java runs apktool and apksigner.
    "ANDROID_SDK_ROOT",
    "ANDROID_HOME",
    "JAVA_HOME",
  ]) {
    if (environment[name] !== undefined) result[name] = environment[name];
  }
  result.CI = "true";
  return result;
}

export function nonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value;
}

export function captureError(code: string, message: string, retryable = false): CiError {
  return new CiError({ code, stage: "capture", message, retryable,
    nextAction: code === "CAPTURE_BUDGET_EXHAUSTED"
      ? "Increase the capture budget or reduce the requested capture scope."
      : "Inspect this route's capture diagnostic and verify that its app link opens on the configured device." });
}
