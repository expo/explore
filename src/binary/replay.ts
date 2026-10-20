import { readFile } from "node:fs/promises";
import { CiError } from "../shared/ci-errors.js";
import type { CiAgentSessionRunRequest, CiAgentSessionRunResult } from "../capture/agent/session.js";
import { SETUP_SELECTOR_MAX, isSetupInput, isSetupSelector } from "../capture/setup-actions.js";
import type { CaptureSetupAction } from "../config/explore-config.js";
import { explorationSecretNames } from "../config/exploration-inputs.js";
import { TOOL_LIMITS, isPlaceholderTitle } from "./explorer.js";

export type ReplayPlatform = "ios" | "android";
type Selector = { label: string; identifier?: never } | { identifier: string; label?: never };
type ReplayAction =
  | ({ action: "tap" } & Selector)
  | ({ action: "fill"; text: string } & Selector)
  | { action: "type"; text: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right" | "top" | "bottom" }
  | { action: "wait"; milliseconds: number }
  | { action: "open"; url: string }
  | { action: "back" }
  | { action: "dismiss-keyboard" };
type ReplayCapture = { capture: string; state?: string; description?: string };
/** `platforms` limits a step to those platforms; an `optional` action that fails is skipped instead of ending the replay. */
export type ReplayStep = (ReplayCapture & { platforms?: ReplayPlatform[] }) | (ReplayAction & { platforms?: ReplayPlatform[]; optional?: boolean });
export type ReplayPlan = { steps: ReplayStep[] };

export type ReplaySession = {
  readonly provider: "replay";
  readonly model: string;
  preflight(): Promise<void>;
  run(request: CiAgentSessionRunRequest): Promise<CiAgentSessionRunResult>;
  /** After a budget stop, the planned screens the run did not reach, for the explorer's gap. */
  budgetNote(): string | undefined;
};

const DIRECTIONS = new Set(["up", "down", "left", "right", "top", "bottom"]);
/**
 * The fields each kind of step takes. Anything else is refused: a typo (`platform`, `optinal`) would otherwise do nothing,
 * and a field `act` reads another way (a coordinate tap's `frameId`, `x`, `y` and `target`) would change what is tapped.
 */
const FIELDS = new Map<string, readonly string[]>([
  ["capture", ["capture", "state", "description", "platforms"]],
  ["tap", ["action", "label", "identifier", "platforms", "optional"]],
  ["fill", ["action", "label", "identifier", "text", "platforms", "optional"]],
  ["type", ["action", "text", "platforms", "optional"]],
  ["scroll", ["action", "direction", "platforms", "optional"]],
  ["wait", ["action", "milliseconds", "platforms", "optional"]],
  ["open", ["action", "url", "platforms", "optional"]],
  ["back", ["action", "platforms", "optional"]],
  ["dismiss-keyboard", ["action", "platforms", "optional"]],
]);
const ACTIONS = [...FIELDS.keys()].filter(kind => kind !== "capture");

function invalid(message: string): CiError {
  return new CiError({ code: "REPLAY_PLAN_INVALID", stage: "exploration", message, retryable: false,
    nextAction: "Fix the replay plan: a JSON object with a steps array of actions ({\"action\":\"tap\",\"label\":\"Settings\"}) and captures ({\"capture\":\"Settings\"})." });
}

const nonEmpty = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function parseStep(step: unknown, at: string): ReplayStep {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw invalid(`${at} is not an object.`);
  const entry = step as Record<string, unknown>;
  const kind = "capture" in entry ? "capture" : typeof entry.action === "string" && FIELDS.has(entry.action) ? entry.action : undefined;
  if (!kind) throw invalid(`${at} needs a capture title or an action (${ACTIONS.join(", ")}).`);
  const fields = FIELDS.get(kind)!;
  const unknown = Object.keys(entry).find(key => !fields.includes(key));
  if (unknown !== undefined) throw invalid(`${at} (${kind}) has a field ${JSON.stringify(unknown.slice(0, 40))} it does not take; a ${kind} step takes ${fields.join(", ")}.`);
  if (entry.platforms !== undefined && (!Array.isArray(entry.platforms) || !entry.platforms.length || entry.platforms.some(item => item !== "ios" && item !== "android"))) {
    throw invalid(`${at}: platforms must list ios and/or android.`);
  }
  if (entry.optional !== undefined && typeof entry.optional !== "boolean") throw invalid(`${at}: optional must be true or false.`);
  const extra = { ...(entry.platforms ? { platforms: [...entry.platforms] as ReplayPlatform[] } : {}), ...(entry.optional !== undefined ? { optional: entry.optional as boolean } : {}) };
  if (kind === "capture") {
    if (!nonEmpty(entry.capture, TOOL_LIMITS.title)) throw invalid(`${at}: capture must be a screen title of at most ${TOOL_LIMITS.title} characters.`);
    if (entry.state !== undefined && !nonEmpty(entry.state, TOOL_LIMITS.state)) throw invalid(`${at}: state must be a string of at most ${TOOL_LIMITS.state} characters.`);
    if (entry.description !== undefined && !nonEmpty(entry.description, TOOL_LIMITS.description)) throw invalid(`${at}: description must be a string of at most ${TOOL_LIMITS.description} characters.`);
    return { capture: entry.capture.trim(), ...(entry.state !== undefined ? { state: entry.state as string } : {}),
      ...(entry.description !== undefined ? { description: entry.description as string } : {}), ...extra };
  }
  // The device selects by the setup executor's rules, which are stricter than what `act` itself accepts.
  const selector = (): Selector => {
    const keys = (["label", "identifier"] as const).filter(key => entry[key] !== undefined);
    if (keys.length !== 1) throw invalid(`${at}: ${kind} needs exactly one of label or identifier.`);
    const key = keys[0]!, value = entry[key];
    if (!isSetupSelector(value) || value.length > TOOL_LIMITS.selector) throw invalid(`${at}: ${key} must be 1–${SETUP_SELECTOR_MAX} characters without control characters.`);
    return key === "label" ? { label: value } : { identifier: value };
  };
  const input = (): string => {
    if (!nonEmpty(entry.text, TOOL_LIMITS.text) || !isSetupInput(entry.text)) throw invalid(`${at}: ${kind} needs text: one line of at most ${TOOL_LIMITS.text} characters.`);
    try { explorationSecretNames(entry.text); }
    catch (error) { throw invalid(`${at}: ${error instanceof Error ? error.message : String(error)} Write each input as {{secret:NAME}} with an uppercase environment variable name that is not a provider, Expo, or CI credential.`); }
    return entry.text;
  };
  switch (kind) {
    case "tap": return { action: "tap", ...selector(), ...extra };
    case "fill": return { action: "fill", ...selector(), text: input(), ...extra };
    case "type": return { action: "type", text: input(), ...extra };
    case "scroll":
      if (typeof entry.direction !== "string" || !DIRECTIONS.has(entry.direction)) throw invalid(`${at}: scroll needs a direction (${[...DIRECTIONS].join(", ")}).`);
      return { action: "scroll", direction: entry.direction as "up", ...extra };
    case "wait":
      if (!(Number.isInteger(entry.milliseconds) && Number(entry.milliseconds) >= 1 && Number(entry.milliseconds) <= TOOL_LIMITS.waitMs)) {
        throw invalid(`${at}: wait needs milliseconds between 1 and ${TOOL_LIMITS.waitMs}.`);
      }
      return { action: "wait", milliseconds: entry.milliseconds as number, ...extra };
    case "open":
      if (!nonEmpty(entry.url, TOOL_LIMITS.url)) throw invalid(`${at}: open needs a url of at most ${TOOL_LIMITS.url} characters.`);
      return { action: "open", url: entry.url, ...extra };
    default: return { action: kind as "back" | "dismiss-keyboard", ...extra };
  }
}

/** Checks a plan and keeps only the fields each step takes, so what reaches `act` is what the plan documents. */
export function parseReplayPlan(value: unknown): ReplayPlan {
  if (!value || typeof value !== "object" || !Array.isArray((value as { steps?: unknown }).steps)) throw invalid("The replay plan has no steps array.");
  const unknown = Object.keys(value).find(key => key !== "steps");
  if (unknown !== undefined) throw invalid(`The replay plan has a field ${JSON.stringify(unknown.slice(0, 40))} it does not take; it takes only steps.`);
  const steps = (value as { steps: unknown[] }).steps;
  if (!steps.length) throw invalid("The replay plan has no steps.");
  return { steps: steps.map((step, index) => parseStep(step, `Step ${index + 1}`)) };
}

export async function readReplayPlan(path: string): Promise<ReplayPlan> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { throw invalid(`The replay plan ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw invalid(`The replay plan ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return parseReplayPlan(value);
}

/** The plan's fill and type steps, whose {{secret:NAME}} inputs must be set before any device starts, as the hints' are. */
export function replaySetup(plan: ReplayPlan): CaptureSetupAction[] {
  return plan.steps.flatMap(step => "action" in step && (step.action === "fill" || step.action === "type") ? [step as CaptureSetupAction] : []);
}

const stepsFor = (plan: ReplayPlan, platform: ReplayPlatform) => plan.steps.map((step, index) => ({ step, number: index + 1 }))
  .filter(({ step }) => !step.platforms || step.platforms.includes(platform));

/**
 * Refuses, before any device starts, a plan with nothing to do on this platform or one the budgets cannot hold: a run that
 * would stop at its budget partway through the plan is better raised or shortened up front.
 */
export function assertReplayFits(plan: ReplayPlan, platform: ReplayPlatform, limits: { maxScreens: number; maxActions: number; maxTurns: number }): void {
  const steps = stepsFor(plan, platform);
  if (!steps.length) {
    throw new CiError({ code: "REPLAY_PLAN_EMPTY", stage: "exploration", message: `No step of the replay plan runs on ${platform}: each one is limited to ${platform === "ios" ? "android" : "ios"} by its platforms.`,
      nextAction: `Add steps for ${platform} to the plan, or run it on the platform it was written for.` });
  }
  const captures = steps.filter(({ step }) => "capture" in step).length;
  const actions = steps.filter(({ step }) => "action" in step && step.action !== "wait").length;
  // A screen counts against the budget when it is first photographed, on arrival, and a capture is refused once the budget
  // is used up, so the last capture needs one screen to spare.
  const over = [
    ...(captures >= limits.maxScreens ? [{ text: `${captures} captures, which need a screen budget of at least ${captures + 1} (it is ${limits.maxScreens})`, flag: `--max-screens ${captures + 1}` }] : []),
    ...(actions > limits.maxActions ? [{ text: `${actions} actions, more than the action budget of ${limits.maxActions}`, flag: `--max-actions ${actions}` }] : []),
  ];
  if (over.length) {
    throw new CiError({ code: "REPLAY_PLAN_OVER_BUDGET", stage: "exploration", message: `On ${platform} the replay plan takes ${over.map(item => item.text).join(" and ")}.`,
      nextAction: `Pass ${over.map(item => item.flag).join(" ")} (or more: each screen the plan reaches without capturing it also counts), or shorten the plan.` });
  }
  // Each capture is an observe and a capture call, each action one act call, and the run ends with get_progress and finish.
  const turns = steps.length + captures + 2;
  if (turns > limits.maxTurns) {
    throw new CiError({ code: "REPLAY_PLAN_OVER_BUDGET", stage: "exploration", message: `On ${platform} the replay plan takes ${turns} tool calls, more than the ${limits.maxTurns} that the screen and action budgets allow.`,
      nextAction: "Raise --max-actions, or use fewer wait steps." });
  }
}

function describeAction(step: ReplayAction): string {
  if ("label" in step && step.label) return `${step.action} "${step.label}"`;
  if ("identifier" in step && step.identifier) return `${step.action} #${step.identifier}`;
  if (step.action === "scroll") return `scroll ${step.direction}`;
  return step.action;
}

/** Only the fields `act` documents for that action, whatever else the step object carries. */
function actInput(step: ReplayAction): Record<string, unknown> {
  const selector = "label" in step && step.label !== undefined ? { label: step.label } : "identifier" in step && step.identifier !== undefined ? { identifier: step.identifier } : {};
  switch (step.action) {
    case "tap": return { action: "tap", ...selector };
    case "fill": return { action: "fill", ...selector, text: step.text };
    case "type": return { action: "type", text: step.text };
    case "scroll": return { action: "scroll", direction: step.direction };
    case "wait": return { action: "wait", milliseconds: step.milliseconds };
    case "open": return { action: "open", url: step.url };
    default: return { action: step.action };
  }
}

/** As many names as fit in `room` characters, then "and N more"; a count of them when not even the first fits. */
function listed(names: readonly string[], room: number, noun: string): string {
  let text = "";
  for (const [index, name] of names.entries()) {
    const next = text ? `${text}, ${name}` : name;
    const left = names.length - index - 1;
    if (next.length + (left ? ` and ${left} more`.length : 0) > room) return text ? `${text} and ${names.length - index} more` : `${names.length} ${noun}`;
    text = next;
  }
  return text;
}

const sameTitle = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * Runs a fixed plan through the explorer's own tools in place of a model: the same observe, act, and capture calls,
 * so the map and report are those of a model run, but every run takes the same steps. A step that fails does not
 * fail the run: the report keeps what was captured and names the screens that were not.
 */
export function createReplaySession(plan: ReplayPlan, platform: ReplayPlatform): ReplaySession {
  const steps = stepsFor(plan, platform);
  const title = (step: ReplayCapture) => step.state ? `${step.capture} (${step.state})` : step.capture;
  const missed: string[] = [];
  let position = 0;
  /** What the plan meant to capture and has not: the screens still ahead first, then the ones earlier steps missed. */
  const notCaptured = () => [...steps.slice(position).flatMap(({ step }) => "capture" in step ? [title(step)] : []), ...missed];
  return {
    provider: "replay",
    model: "replay plan",
    async preflight() {},
    budgetNote() {
      const names = notCaptured();
      return names.length ? `Not captured: ${listed(names, TOOL_LIMITS.reason, "planned screens")}.` : undefined;
    },
    async run(request) {
      const signal = request.signal ?? new AbortController().signal;
      const call = async (name: string, input: Record<string, unknown>) => {
        const result = await request.callTool(name, input, signal);
        const text = result.content.find(block => block.type === "text");
        const value = text && "text" in text ? JSON.parse(text.text) as Record<string, unknown> : {};
        return { failed: Boolean(result.isError) || value.ok === false, value };
      };
      const why = (value: Record<string, unknown>) => String(value.error ?? value.reason ?? value.message ?? "it failed");
      // A refused finish or stop_blocked would otherwise end the session with no result, which the explorer reports as a turn budget stop.
      const end = async (name: "finish" | "stop_blocked", input: Record<string, unknown>) => {
        const ended = await call(name, input);
        if (!ended.failed) return;
        if (name === "finish") return end("stop_blocked", { reason: `The replay could not finish (${why(ended.value)}). ${String(input.summary)}`.slice(0, TOOL_LIMITS.reason) });
        throw new CiError({ code: "REPLAY_STOP_REFUSED", stage: "exploration", message: `The explorer refused the replay's ${name}: ${why(ended.value)}`.slice(0, 600),
          nextAction: "Report this with the replay plan; the screens captured so far are in the map." });
      };
      /** Screen id to the title the plan captured it under. */
      const planned = new Map<string, string>();
      const skipped: string[] = [];
      missed.length = 0;
      try {
        for (const [index, { step, number }] of steps.entries()) {
          position = index;
          if ("capture" in step) {
            const seen = await call("observe", { includeImage: true });
            const frameId = typeof seen.value.frameId === "string" ? seen.value.frameId : undefined;
            const known = typeof seen.value.screenId === "string" && !step.state ? planned.get(seen.value.screenId) : undefined;
            // The plan already captured this screen: a second capture would only rename it, so it is not made.
            if (known !== undefined) {
              if (!sameTitle(known, step.capture)) missed.push(`${title(step)} (looked the same as ${known})`);
              continue;
            }
            const captured = frameId && !seen.failed ? await call("capture", { frameId, title: step.capture,
              ...(step.state ? { state: step.state } : {}), ...(step.description ? { description: step.description } : {}) }) : undefined;
            const screenId = typeof captured?.value.screenId === "string" ? captured.value.screenId : undefined;
            if (!captured || captured.failed || !screenId) missed.push(title(step));
            else if (!planned.has(screenId)) planned.set(screenId, step.capture);
            continue;
          }
          const acted = await call("act", actInput(step));
          if (!acted.failed) continue;
          if (step.optional) { skipped.push(`step ${number} (${describeAction(step)})`); continue; }
          const head = `Replay step ${number} (${describeAction(step)}) failed: ${why(acted.value)}`.slice(0, 600);
          const names = notCaptured();
          const lead = ". Not captured: ";
          await end("stop_blocked", { reason: head + (names.length ? `${lead}${listed(names, TOOL_LIMITS.reason - head.length - lead.length, "planned screens")}` : "") });
          return { inputTokens: 0, outputTokens: 0 };
        }
        position = steps.length;
        // The map as it stands: screens merged into others are gone, and each keeps its latest title. One reached but never
        // captured is still "Screen N" here and is named after the path to it only once the run ends, so it is counted.
        const progress = await call("get_progress", {});
        const screens = Array.isArray(progress.value.captured) ? progress.value.captured as Array<{ id?: unknown; title?: unknown }> : [];
        const unplanned = screens.filter(screen => typeof screen.id === "string" && !planned.has(screen.id)).map(screen => typeof screen.title === "string" ? screen.title : "");
        const named = unplanned.filter(name => name && !isPlaceholderTitle(name));
        const unnamed = unplanned.length - named.length;
        const reached = [...named, ...(unnamed ? [`${unnamed} unnamed screen${unnamed === 1 ? "" : "s"}`] : [])];
        const sections = ([["Not captured", missed, "planned screens"], ["Optional steps skipped because they failed", skipped, "steps"],
          ["Also reached, not in the plan", reached, "screens"]] as const).filter(([, names]) => names.length);
        let summary = `Replayed ${steps.length} planned steps on ${platform}.${missed.length ? "" : " Every planned screen was captured."}`;
        for (const [index, [label, names, noun]] of sections.entries()) {
          // Each later section keeps room for its label and a count, so a long list of misses does not crowd out the rest.
          const reserve = sections.slice(index + 1).reduce((sum, [later]) => sum + later.length + 32, 0);
          const lead = ` ${label}: `;
          summary += `${lead}${listed(names, TOOL_LIMITS.summary - summary.length - lead.length - 1 - reserve, noun)}.`;
        }
        await end("finish", { summary });
      } catch (error) {
        if (signal.aborted) return { inputTokens: 0, outputTokens: 0 };
        throw error;
      }
      return { inputTokens: 0, outputTokens: 0 };
    },
  };
}
