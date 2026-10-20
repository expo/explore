import { readFile } from "node:fs/promises";
import { CiError } from "../shared/ci-errors.js";
import type { CiAgentSessionRunRequest, CiAgentSessionRunResult } from "../capture/agent/session.js";

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
export type ReplayStep = (ReplayAction | ReplayCapture) & { platforms?: ReplayPlatform[]; optional?: boolean };
export type ReplayPlan = { steps: ReplayStep[] };

export type ReplaySession = {
  readonly provider: "replay";
  readonly model: string;
  preflight(): Promise<void>;
  run(request: CiAgentSessionRunRequest): Promise<CiAgentSessionRunResult>;
};

const ACTIONS = new Set(["tap", "fill", "type", "scroll", "wait", "open", "back", "dismiss-keyboard"]);
const DIRECTIONS = new Set(["up", "down", "left", "right", "top", "bottom"]);

function invalid(message: string): CiError {
  return new CiError({ code: "REPLAY_PLAN_INVALID", stage: "exploration", message, retryable: false,
    nextAction: "Fix the replay plan: a JSON object with a steps array of actions ({\"action\":\"tap\",\"label\":\"Settings\"}) and captures ({\"capture\":\"Settings\"})." });
}

const nonEmpty = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function parseReplayPlan(value: unknown): ReplayPlan {
  if (!value || typeof value !== "object" || !Array.isArray((value as { steps?: unknown }).steps)) throw invalid("The replay plan has no steps array.");
  const steps = (value as { steps: unknown[] }).steps;
  if (!steps.length) throw invalid("The replay plan has no steps.");
  steps.forEach((step, index) => {
    const at = `Step ${index + 1}`;
    if (!step || typeof step !== "object") throw invalid(`${at} is not an object.`);
    const entry = step as Record<string, unknown>;
    if (entry.platforms !== undefined && (!Array.isArray(entry.platforms) || !entry.platforms.length || entry.platforms.some(item => item !== "ios" && item !== "android"))) {
      throw invalid(`${at}: platforms must list ios and/or android.`);
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") throw invalid(`${at}: optional must be true or false.`);
    if ("capture" in entry) {
      if (!nonEmpty(entry.capture, 80)) throw invalid(`${at}: capture must be a screen title of at most 80 characters.`);
      if (entry.state !== undefined && !nonEmpty(entry.state, 80)) throw invalid(`${at}: state must be a string of at most 80 characters.`);
      if (entry.description !== undefined && !nonEmpty(entry.description, 500)) throw invalid(`${at}: description must be a string of at most 500 characters.`);
      return;
    }
    const action = entry.action;
    if (typeof action !== "string" || !ACTIONS.has(action)) throw invalid(`${at} needs a capture title or an action (${[...ACTIONS].join(", ")}).`);
    const selectors = ["label", "identifier"].filter(key => entry[key] !== undefined);
    if (action === "tap" || action === "fill") {
      if (selectors.length !== 1 || !nonEmpty(entry[selectors[0]!], 2000)) throw invalid(`${at}: ${action} needs exactly one of label or identifier.`);
    }
    if ((action === "fill" || action === "type") && !nonEmpty(entry.text, 2000)) throw invalid(`${at}: ${action} needs text.`);
    if (action === "scroll" && !DIRECTIONS.has(String(entry.direction))) throw invalid(`${at}: scroll needs a direction (${[...DIRECTIONS].join(", ")}).`);
    if (action === "wait" && !(Number.isInteger(entry.milliseconds) && Number(entry.milliseconds) >= 1 && Number(entry.milliseconds) <= 15_000)) {
      throw invalid(`${at}: wait needs milliseconds between 1 and 15000.`);
    }
    if (action === "open" && !nonEmpty(entry.url, 2000)) throw invalid(`${at}: open needs a url.`);
  });
  return { steps: steps as ReplayStep[] };
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

function describeAction(step: ReplayAction): string {
  if ("label" in step && step.label) return `${step.action} "${step.label}"`;
  if ("identifier" in step && step.identifier) return `${step.action} #${step.identifier}`;
  if (step.action === "scroll") return `scroll ${step.direction}`;
  return step.action;
}

/**
 * Runs a fixed plan through the explorer's own tools in place of a model: the same observe, act, and capture calls,
 * so the map and report are those of a model run, but every run takes the same steps. A step that fails does not
 * fail the run: the report keeps what was captured and names the screens that were not.
 */
export function createReplaySession(plan: ReplayPlan, platform: ReplayPlatform): ReplaySession {
  return {
    provider: "replay",
    model: "replay plan",
    async preflight() {},
    async run(request) {
      const signal = request.signal ?? new AbortController().signal;
      const call = async (name: string, input: Record<string, unknown>) => {
        const result = await request.callTool(name, input, signal);
        const text = result.content.find(block => block.type === "text");
        const value = text && "text" in text ? JSON.parse(text.text) as Record<string, unknown> : {};
        if (typeof value.screenId === "string" && !reached.has(value.screenId)) reached.set(value.screenId, String(value.title ?? ""));
        return { failed: Boolean(result.isError) || value.ok === false, value };
      };
      const reached = new Map<string, string>();
      const planned = new Map<string, string>();
      const steps = plan.steps.filter(step => !step.platforms || step.platforms.includes(platform));
      const missed: string[] = [];
      const title = (step: ReplayCapture) => step.state ? `${step.capture} (${step.state})` : step.capture;
      try {
        for (const [index, step] of steps.entries()) {
          if ("capture" in step) {
            const seen = await call("observe", { includeImage: true });
            const frameId = typeof seen.value.frameId === "string" ? seen.value.frameId : undefined;
            const captured = frameId && !seen.failed ? await call("capture", { frameId, title: step.capture,
              ...(step.state ? { state: step.state } : {}), ...(step.description ? { description: step.description } : {}) }) : undefined;
            const screenId = typeof captured?.value.screenId === "string" ? captured.value.screenId : undefined;
            const earlier = screenId ? planned.get(screenId) : undefined;
            if (!captured || captured.failed || !screenId) missed.push(title(step));
            else if (captured.value.duplicate && earlier && earlier !== step.capture) missed.push(`${title(step)} (looked the same as ${earlier})`);
            else if (!earlier) planned.set(screenId, step.capture);
            continue;
          }
          const { platforms: _platforms, optional, ...action } = step;
          const acted = await call("act", action as Record<string, unknown>);
          if (!acted.failed || optional) continue;
          const rest = steps.slice(index + 1).filter((item): item is ReplayCapture & ReplayStep => "capture" in item).map(title);
          const why = String(acted.value.error ?? acted.value.reason ?? acted.value.message ?? "it failed");
          const notCaptured = [...missed, ...rest];
          await call("stop_blocked", { reason: `Replay step ${plan.steps.indexOf(step) + 1} (${describeAction(action as ReplayAction)}) failed: ${why}`.slice(0, 600)
            + (notCaptured.length ? `. Not captured: ${notCaptured.join(", ")}`.slice(0, 390) : "") });
          return { inputTokens: 0, outputTokens: 0 };
        }
        const unplanned = [...reached].filter(([id]) => !planned.has(id)).map(([, name]) => name || "untitled");
        await call("finish", { summary: `Replayed ${steps.length} planned steps on ${platform}.`
          + (missed.length ? ` Not captured: ${missed.join(", ")}.` : " Every planned screen was captured.")
          + (unplanned.length ? ` Also reached, not in the plan: ${unplanned.join(", ")}.` : "") });
      } catch (error) {
        if (signal.aborted) return { inputTokens: 0, outputTokens: 0 };
        throw error;
      }
      return { inputTokens: 0, outputTokens: 0 };
    },
  };
}
