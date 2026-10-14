import { CiError } from "../shared/ci-errors.js";
import type { CaptureSetupAction } from "./explore-config.js";

const TOKEN = /\{\{secret:([A-Z][A-Z0-9_]{0,127})\}\}/g;
const RESERVED = /^(?:GITHUB_|RUNNER_|ACTIONS_|AGENT_DEVICE_|OPENAI_|ANTHROPIC_|EXPO_TOKEN$)/;

/** References are data, never shell expressions or arbitrary environment access. */
export function explorationSecretNames(text: string): string[] {
  const names = [...new Set([...text.matchAll(TOKEN)].map(match => match[1]!))].sort();
  if (text.replace(TOKEN, "").includes("{{secret:")) throw new CiError({
    code: "EXPLORATION_SECRET_REFERENCE_INVALID", stage: "configuration",
    message: "An exploration input has an invalid secret reference.",
    nextAction: "Use {{secret:ENV_NAME}} with an uppercase environment variable name.",
  });
  if (names.some(name => RESERVED.test(name))) throw new CiError({
    code: "EXPLORATION_SECRET_REFERENCE_INVALID", stage: "configuration",
    message: "Exploration inputs cannot reference provider, controller, or CI credentials.",
    nextAction: "Use a separate application test credential and reference its environment variable.",
  });
  return names;
}

export function createExplorationInputs(options: {
  instructions?: string;
  setup?: readonly CaptureSetupAction[];
  environment?: NodeJS.ProcessEnv;
} = {}) {
  const environment = options.environment ?? process.env;
  const names = explorationSecretNames([options.instructions ?? "",
    ...(options.setup ?? []).map(action => action.action === "fill" || action.action === "type" ? action.text : "")].join("\n"));
  const entries = names.map(name => {
    const value = environment[name];
    if (!value?.trim()) throw new CiError({ code: "EXPLORATION_SECRET_MISSING", stage: "preflight",
      message: `Required application input ${name} is missing.`,
      nextAction: `Add ${name} to GitHub Actions secrets and pass it to the capture step.`, details: { secretName: name } });
    if (value.length > 4096 || /[\u0000\r\n]/.test(value)) throw new CiError({
      code: "EXPLORATION_SECRET_INVALID", stage: "preflight", message: `Application input ${name} is not a supported single-line value.`,
      nextAction: `Configure ${name} as a nonempty, single-line application input of at most 4096 characters.` });
    return [name, value] as const;
  });
  const values = [...new Set(entries.map(([, value]) => value))].sort((a, b) => b.length - a.length);
  const known = new Map(entries);
  const resolve = (text: string): string => {
    for (const name of explorationSecretNames(text)) if (!known.has(name)) throw new CiError({
      code: "EXPLORATION_SECRET_UNDECLARED", stage: "capture", message: "The agent requested an undeclared application input.",
      nextAction: "Declare the required input reference in the committed exploration instructions before rerunning." });
    return text.replace(TOKEN, (_, name: string) => known.get(name)!);
  };
  const escapedValues = [...new Set(values.flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))]
    .sort((a, b) => b.length - a.length);
  const redact = (text: string): string => escapedValues.reduce((result, value) => result.split(value).join("[REDACTED]"), text);
  const redactValue = <T>(value: T): T => {
    if (typeof value === "string") return redact(value) as T;
    if (Array.isArray(value)) return value.map(redactValue) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)])) as T;
    return value;
  };
  const assertSafeSnapshot = (snapshot: unknown): void => {
    const containsSecret = (value: unknown): boolean => {
      if (typeof value === "string") return escapedValues.some(secret => value.includes(secret));
      if (!value || typeof value !== "object") return false;
      return Object.values(value).some(containsSecret);
    };
    // Inputs are protected while present even when iOS masks their accessibility value.
    const containsSecureInput = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(containsSecureInput);
      const node = value as Record<string, unknown>;
      if (node.visible !== false && typeof node.type === "string" && /securetextfield/i.test(node.type)
        && typeof node.value === "string" && node.value.length > 0 && node.value !== node.placeholder) return true;
      return Object.values(node).some(containsSecureInput);
    };
    if (containsSecret(snapshot) || containsSecureInput(snapshot)) throw new CiError({
      code: "CAPTURE_SENSITIVE_INPUT", stage: "capture", message: "The current screen contains a sensitive application input.",
      nextAction: "Complete or clear the input and navigate to a reviewable screen before capturing it." });
  };
  return { names, values, resolve, redact, redactValue, assertSafeSnapshot };
}
