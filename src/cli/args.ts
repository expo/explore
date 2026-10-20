import { CiError } from "../shared/ci-errors.js";
import { ExploreStore } from "../map/store.js";
import { QUERY_CONTRACT } from "../types.js";

const argv = process.argv.slice(2);
const aliases: Record<string, string> = {
  "screen list": "screen:list",
  "screen get": "screen:get",
  "element list": "element:list",
  "observation list": "observation:list",
  "observation get": "observation:get",
  "attempt list": "attempt:list",
  "attempt get": "attempt:get",
  "transition list": "transition:list",
  "transition get": "transition:get",
  "journey list": "journey:list",
  "journey get": "journey:get",
  "frontier next": "frontier:next",
  "frontier list": "frontier:list",
  "gap list": "gap:list",
  "export web": "export:web",
  "ci report": "ci:report",
  "ci publish": "ci:publish",
  "ci failure": "ci:failure",
  "ci deploy": "ci:deploy",
  "config platforms": "config:platforms",
  "config targets": "config:targets",
};

/** One-word names for commands people type: `capture` is the local review, `capture:review` without its CI flags. */
const shortNames: Record<string, string> = { capture: "capture:review" };

const first = argv[0] ?? "help";
const pair = `${first} ${argv[1] ?? ""}`.trim();
export const command = aliases[pair] ?? shortNames[first] ?? first;
export const resultContract = ["source:verify", "capture:review", "capture:baseline", "ci:report", "ci:publish", "ci:failure", "ci:deploy", "ci:pr", "ci:find-baseline", "ci:compare-refs", "ci:after-capture", "config:platforms", "config:targets", "explore:binary", "explore:session", "report:upload", "reports"].includes(command)
  ? "explore.result" : QUERY_CONTRACT;
const commandArgCount = aliases[pair] ? 2 : 1;
const args = argv.slice(commandArgCount);
/** Commands that take one bare argument before their flags, e.g. `explore:binary ./app.apk`. */
const POSITIONAL_COMMANDS = new Set(["explore:binary", "explore:session"]);
/** Commands that take any number of bare arguments among their flags, e.g. `report:upload ios/report.zip android/report.zip`. */
const VARIADIC_COMMANDS = new Set(["report:upload", "reports"]);

const commonFlagKinds: Record<string, "value" | "boolean"> = {
  dir: "value",
  json: "boolean",
};

const flagKinds: Record<string, Record<string, "value" | "boolean">> = {
  setup: { project: "value", platform: "value", device: "value", scope: "value", profile: "value", "bundle-id": "value", scheme: "value", navigation: "value",
    mode: "value", provider: "value", model: "value", param: "value", "app-state": "value", workflows: "boolean", "no-workflows": "boolean",
    "non-interactive": "boolean", check: "boolean", force: "boolean", help: "boolean" },
  doctor: { project: "value", offline: "boolean", "no-github": "boolean", "check-model": "boolean", capture: "boolean", output: "value", target: "value", platform: "value", controller: "value", simulator: "value", repack: "value", yes: "boolean", help: "boolean" },
  "capture:baseline": { project:"value", sha:"value", output:"value", config:"value", target:"value", platform:"value", controller:"value", simulator:"value", repack:"value" },
  "source:verify": { "base-project":"value", "head-project":"value", "base-sha":"value", "head-sha":"value", output:"value", config:"value", scope:"value", target:"value", platform:"value" },
  "config:platforms": { project:"value", config:"value" },
  "config:targets": { project:"value", config:"value" },
  "screen:list": { limit: "value", cursor: "value", unexplored: "boolean" },
  "screen:get": { id: "value" },
  "element:list": {
    screen: "value",
    role: "value",
    query: "value",
    limit: "value",
    cursor: "value",
    actionable: "boolean",
  },
  "observation:list": { screen: "value", limit: "value", cursor: "value" },
  "observation:get": { id: "value" },
  "frontier:next": {},
  "frontier:list": { status: "value", limit: "value", cursor: "value" },
  "attempt:list": { outcome: "value", screen: "value", limit: "value", cursor: "value" },
  "attempt:get": { id: "value" },
  "transition:list": { screen: "value", limit: "value", cursor: "value" },
  "transition:get": { id: "value" },
  neighbors: { screen: "value" },
  path: { from: "value", to: "value" },
  "journey:list": { limit: "value", cursor: "value" },
  "journey:get": { id: "value" },
  "gap:list": { status: "value", limit: "value", cursor: "value" },
  summary: {},
  search: { query: "value", limit: "value", cursor: "value" },
  status: {},
  validate: {},
  export: { output: "value" },
  "export:web": {catalog:"value",output:"value"},
  "capture:review": { "base-project":"value", "head-project":"value", "pull-request":"value", compare:"value", output:"value", config:"value", parallel:"value", target:"value", platform:"value", controller:"value", simulator:"value", repack:"value", scope:"value", "expires-in":"value",
    base:"value", head:"value", project:"value", committed:"boolean", uncommitted:"boolean", "include-untracked":"boolean", upload:"boolean", "no-open":"boolean", "no-cache":"boolean", port:"value" },



  "explore:binary": { replay:"value", archive:"value", output:"value", platform:"value", controller:"value", simulator:"value", device:"value", "bundle-id":"value", "launch-url":"value", hints:"value", "allow-destructive":"value",
    "max-duration-minutes":"value", "max-screens":"value", "max-actions":"value", provider:"value", model:"value", owner:"value", project:"value",
    upload:"boolean", "no-upload":"boolean", "expires-in":"value", alias:"value", "no-open":"boolean", port:"value" },
  "explore:session": { replay:"value", session:"value", "env-file":"value", "bundle-id":"value", "app-name":"value", "app-version":"value", output:"value", platform:"value", controller:"value", device:"value", "launch-url":"value", hints:"value",
    "allow-destructive":"value", "max-duration-minutes":"value", "max-screens":"value", "max-actions":"value", provider:"value", model:"value", owner:"value", project:"value",
    upload:"boolean", "expires-in":"value", alias:"value", "no-open":"boolean", port:"value" },
  "ci:report": { input:"value", output:"value", target:"value", platform:"value" },
  "ci:publish": { input:"value", "artifact-url":"value", target:"value", platform:"value", inputs:"value" },
  "ci:failure": { pr:"value", head:"value", base:"value", diagnostics:"value", target:"value", platform:"value" },
  "ci:deploy": { input:"value", report:"value", "artifact-url":"value", target:"value", platform:"value", inputs:"value", reports:"value" },
  "ci:pr": { pr:"value", output:"value", "app-dir":"value", config:"value" },
  "ci:find-baseline": { sha:"value", target:"value", platform:"value" },
  "ci:compare-refs": { project:"value", base:"value", head:"value", title:"value", output:"value" },
  "ci:after-capture": { output:"value", checkout:"value" },
  compare: {
    baseline: "value",
    current: "value",
    output: "value",
    "review-output": "value",
    "catalog-output": "value",
    "catalog-name": "value",





  },
  view: { port: "value", catalog: "value", "no-open": "boolean" },
  "report:upload": { owner: "value", project: "value", "expires-in": "value", config: "value" },
  reports: { all: "boolean", owner: "value", project: "value", "expires-in": "value", config: "value", port: "value", "no-open": "boolean", "no-intro": "boolean" },
  help: { all: "boolean" },
  "--help": { all: "boolean" },
  "-h": { all: "boolean" },
  version: {},
  "--version": {},
  "-v": {},
};

export function argumentError(message: string, name?: string, action?: string): never {
  throw new CiError({ code: "CLI_ARGUMENT_INVALID", stage: "preflight", message,
    nextAction: action ?? `Run expo-explore help and correct ${name ? `--${name}` : "the arguments"} for ${command}.`,
    details: { command, ...(name ? { flag: name } : {}) } });
}

export function validateCommandArguments(): void {
  const commandFlags = flagKinds[command];
  if (!commandFlags) return;
  const allowed = { ...commonFlagKinds, ...commandFlags };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      if ((index === 0 && POSITIONAL_COMMANDS.has(command)) || VARIADIC_COMMANDS.has(command)) continue;
      argumentError(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const kind = allowed[name];
    if (!kind) argumentError(`Unknown flag for ${command}: --${name}`, name,
      `Remove --${name}. Run expo-explore help to see the supported ${command} flags.`);
    if (kind === "value") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        argumentError(`Missing value for --${name}`, name, `Provide a value after --${name} and rerun ${command}.`);
      }
      index += 1;
    }
  }
}

/** The bare argument of a positional command, when given. */
export function positional(): string | undefined {
  const first = args[0];
  return POSITIONAL_COMMANDS.has(command) && first !== undefined && !first.startsWith("--") ? first : undefined;
}

/** The bare arguments of a variadic command, in order: every token that is neither a flag nor a flag's value. */
export function positionals(): string[] {
  const allowed = { ...commonFlagKinds, ...flagKinds[command] };
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) values.push(token);
    else if (allowed[token.slice(2)] === "value") index += 1;
  }
  return values;
}

export function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith("--")) argumentError(`Missing value for --${name}`, name, `Provide a value after --${name} and rerun ${command}.`);
  return result;
}

/** Every value of a repeatable flag, in order. */
export function flags(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) argumentError(`Missing value for --${name}`, name, `Provide a value after --${name} and rerun ${command}.`);
    values.push(value);
  }
  return values;
}

export function has(name: string): boolean {
  return args.includes(`--${name}`);
}

export function required(name: string): string {
  const result = flag(name);
  if (!result) argumentError(`Missing --${name}`, name, `Add --${name} with its required value and rerun ${command}.`);
  return result;
}

export function positiveInteger(name: string, fallback?: number): number {
  const raw = flag(name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const result = Number(raw);
  if (!Number.isInteger(result) || result <= 0) {
    argumentError(`--${name} must be a positive integer`, name, `Set --${name} to a whole number greater than zero.`);
  }
  return result;
}

export function nonNegativeInteger(name: string, fallback?: number): number {
  const raw = flag(name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const result = Number(raw);
  if (!Number.isInteger(result) || result < 0) {
    argumentError(`--${name} must be a non-negative integer`, name, `Set --${name} to a whole number of zero or greater.`);
  }
  return result;
}

export function oneOf<T extends string>(name: string, choices: readonly T[], fallback?: T): T {
  const result = flag(name) ?? fallback;
  if (!result) argumentError(`Missing --${name}`, name, `Add --${name} with one of: ${choices.join(", ")}.`);
  if (!choices.includes(result as T)) {
    argumentError(`--${name} must be one of: ${choices.join(", ")}`, name, `Set --${name} to one of: ${choices.join(", ")}.`);
  }
  return result as T;
}

export function output(value: Record<string, unknown>): void {
  console.log(
    JSON.stringify(
      {
        contract: resultContract,
        command,
        ...value,
      },
      null,
      has("json") ? 0 : 2,
    ),
  );
}

export let store: ExploreStore;

/** Handlers read `store` as a live binding; the entry point sets it once before running one. */
export function setStore(value: ExploreStore): void {
  store = value;
}
