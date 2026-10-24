import { createCiAgentSession, type CiAgentSession } from "../capture/agent/session.js";
import { createLocalCiAgentSession } from "../capture/agent/session-local.js";
import type { CiAgentProviderName } from "../capture/agent/provider.js";
import { createExplorationInputs } from "../config/exploration-inputs.js";
import { CiError } from "../shared/ci-errors.js";
import type { Platform } from "../types.js";
import { assertAppUrl } from "./app-url.js";
import { assertFlowsFit, createFlowSession, flowGoals, flowSetup, flowsNeedModel, parseFlowPlan, type FlowPlan } from "./flows.js";
import { assertReplayFits, createReplaySession, parseReplayPlan, replaySetup, type ReplayPlan } from "./replay.js";
import type { BinaryExploreOptions } from "./run.js";

/**
 * How an exploration decides what to do on the device. The explorer (`runBlackBoxExploration`) owns the device and the
 * tools that drive it, the budgets, what is refused, and what is recorded; a strategy only calls those tools, through
 * `session.run`. A model explores on its own, a replay plan takes fixed steps, and a flows file takes named flows.
 * A new strategy is one more case here: what `chooseStrategy` checks before any device starts, and the session
 * `startStrategy` runs.
 */
export type StrategyChoice = { kind: "model" } | { kind: "replay"; plan: ReplayPlan } | { kind: "flows"; plan: FlowPlan };

export type ModelAuth = "local-login" | "api-key";

/** A strategy ready to run, and how the report names it. */
export type ExplorationStrategy = {
  session: Pick<CiAgentSession, "run">;
  provider: CiAgentProviderName | "replay" | "flows";
  model: string;
  auth: ModelAuth | "none";
  /** A sentence a budget stop's gap adds to its own: the planned screens or checkpoints the run did not reach. */
  budgetNote?: () => string | undefined;
  /** Takes the explorer's flow tools (start_flow, checkpoint, end_flow), with a relaunch before each flow after the first. */
  flowTools?: boolean;
};

export const DEFAULT_MODELS: Record<CiAgentProviderName, string> = { anthropic: "claude-sonnet-4-5", openai: "gpt-6.1-sol" };

type StrategyOptions = Pick<BinaryExploreOptions, "replay" | "flows" | "provider" | "model" | "hints" | "createSession">;
type ModelSessionOptions = Pick<BinaryExploreOptions, "provider" | "model" | "createSession">;

function strategyError(code: string, message: string, nextAction: string): CiError {
  return new CiError({ code, stage: "session", message, nextAction });
}

/** The turns the model gets: three for each action and two for each screen, plus a few to look around and finish. */
export const turnBudget = (limits: { maxScreens: number; maxActions: number }): number => limits.maxActions * 3 + limits.maxScreens * 2 + 20;

/**
 * The strategy the options ask for, checked before any device starts. A plan file is checked here as well as by the
 * CLI, for callers that pass one directly.
 */
export function chooseStrategy(options: StrategyOptions): StrategyChoice {
  if (options.replay && options.flows) throw strategyError("FLOWS_WITH_REPLAY", "--flows and --replay each decide every step, so only one of them can run.", "Drop --replay, or move its steps into a flow.");
  if (options.replay) return { kind: "replay", plan: replayPlan(options.replay, options) };
  if (options.flows) return { kind: "flows", plan: flowsPlan(options.flows, options) };
  return { kind: "model" };
}

/**
 * A replay plan takes the model's place, so the options that only steer a model would do nothing; the plan's own fill
 * and type steps name the secrets it types.
 */
function replayPlan(value: ReplayPlan, options: StrategyOptions): ReplayPlan {
  const ignored = (["provider", "model", "hints"] as const).filter(name => options[name] !== undefined);
  if (ignored.length) {
    throw strategyError("REPLAY_OPTIONS_IGNORED", `--replay takes the model's place, so ${ignored.map(name => `--${name}`).join(" and ")} would do nothing.`,
      `Drop ${ignored.map(name => `--${name}`).join(" and ")}. A {{secret:NAME}} in the plan's fill and type steps is read from the environment, as one in --hints is.`);
  }
  const plan = parseReplayPlan(value);
  for (const [index, step] of plan.steps.entries()) {
    if (!("action" in step) || step.action !== "open") continue;
    try { assertAppUrl(step.url); }
    catch (error) { throw new CiError({ code: "REPLAY_PLAN_INVALID", stage: "exploration", message: `Step ${index + 1}: ${error instanceof Error ? error.message : String(error)}`, nextAction: "Open only the app's own URLs in the replay plan." }); }
  }
  return plan;
}

/**
 * A flows file decides every step, as a replay plan does, but a step it describes in words is carried out by a model,
 * so --provider, --model and --hints apply only when it has one.
 */
function flowsPlan(value: FlowPlan, options: StrategyOptions): FlowPlan {
  const plan = parseFlowPlan(value);
  const ignored = flowsNeedModel(plan) ? [] : (["provider", "model", "hints"] as const).filter(name => options[name] !== undefined);
  if (ignored.length) {
    throw strategyError("FLOWS_OPTIONS_IGNORED", `Every step of the flows file is exact, so ${ignored.map(name => `--${name}`).join(" and ")} would do nothing.`,
      `Drop ${ignored.map(name => `--${name}`).join(" and ")}, or describe a step in words ({"do": "…"}) for a model to carry out.`);
  }
  for (const [index, flow] of plan.flows.entries()) for (const [stepIndex, step] of flow.steps.entries()) {
    if (!("action" in step) || step.action !== "open") continue;
    try { assertAppUrl(step.url); }
    catch (error) { throw new CiError({ code: "FLOWS_PLAN_INVALID", stage: "exploration", message: `Flow ${index + 1} (${flow.name}), step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`, nextAction: "Open only the app's own URLs in the flows file." }); }
  }
  return plan;
}

/**
 * App-test inputs: each {{secret:NAME}} in the hints, and in the strategy's own fill and type steps and described steps,
 * names an environment variable whose value Explore types. Read before any session starts, so a missing one costs nothing.
 */
export function strategyInputs(choice: StrategyChoice, hints: string | undefined, environment: NodeJS.ProcessEnv): ReturnType<typeof createExplorationInputs> {
  const setup = choice.kind === "replay" ? replaySetup(choice.plan) : choice.kind === "flows" ? flowSetup(choice.plan) : undefined;
  try { return createExplorationInputs({ instructions: [hints ?? "", ...(choice.kind === "flows" ? flowGoals(choice.plan) : [])].join("\n"), ...(setup ? { setup } : {}), environment }); }
  catch (error) {
    if (!(error instanceof CiError) || !error.code.startsWith("EXPLORATION_SECRET_")) throw error;
    const name = typeof error.details?.secretName === "string" ? error.details.secretName : "NAME";
    throw new CiError({ code: error.code, stage: "preflight", message: error.message, ...(error.details ? { details: error.details } : {}),
      nextAction: error.code === "EXPLORATION_SECRET_REFERENCE_INVALID"
        ? "Write each input in --hints as {{secret:NAME}} with an uppercase environment variable name that is not a provider, Expo, or CI credential."
        : `Set ${name} in the environment that runs Explore (export ${name}=…) to the single-line test value, then rerun.` });
  }
}

/** The session the chosen strategy runs. Model access is checked here, before a simulator is paid for, and only when the strategy uses a model. */
export async function startStrategy(choice: StrategyChoice, context: { platform: Platform; limits: { maxScreens: number; maxActions: number }; options: StrategyOptions;
  environment: NodeJS.ProcessEnv; say: (message: string) => void; app: { name: string } }): Promise<ExplorationStrategy> {
  const { platform, limits, options, environment, say, app } = context;
  if (choice.kind === "replay") {
    assertReplayFits(choice.plan, platform, { ...limits, maxTurns: turnBudget(limits) });
    const session = createReplaySession(choice.plan, platform);
    return { session, budgetNote: session.budgetNote, provider: "replay", model: "replay plan", auth: "none" };
  }
  if (choice.kind === "flows") {
    assertFlowsFit(choice.plan, platform, limits);
    const goals = flowsNeedModel(choice.plan) ? await preflightModelSession(options, environment, say) : undefined;
    const session = createFlowSession(choice.plan, platform, { app, ...(goals ? { model: goals.session } : {}), ...(options.hints ? { hints: options.hints } : {}) });
    return { session, budgetNote: session.budgetNote, flowTools: true, provider: "flows", model: goals ? `${goals.provider} ${goals.model}` : session.model, auth: goals?.auth ?? "none" };
  }
  return preflightModelSession(options, environment, say);
}

function modelSession(provider: CiAgentProviderName, auth: ModelAuth, options: ModelSessionOptions, environment: NodeJS.ProcessEnv) {
  const config = { provider, model: options.model ?? DEFAULT_MODELS[provider] };
  const session = options.createSession ? options.createSession(config, { env: environment, auth })
    : auth === "api-key" ? createCiAgentSession(config, { env: environment }) : createLocalCiAgentSession(config, { env: environment });
  return { session, provider, model: config.model, auth };
}

/** Local `claude`/`codex` login unless an API key is present; preflight proves access before a simulator is paid for. */
export function selectModelSession(options: ModelSessionOptions, environment: NodeJS.ProcessEnv) {
  const provider: CiAgentProviderName = options.provider ?? (environment.OPENAI_API_KEY?.trim() && !environment.ANTHROPIC_API_KEY?.trim() ? "openai" : "anthropic");
  const keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  return modelSession(provider, environment[keyName]?.trim() ? "api-key" : "local-login", options, environment);
}

/**
 * With --provider or --model, only that choice is tried. Otherwise every model access this shell has is tried
 * in turn (API keys, then the local claude and codex logins) and the first that passes preflight runs.
 */
export async function preflightModelSession(options: ModelSessionOptions, environment: NodeJS.ProcessEnv, say: (message: string) => void) {
  const candidates = options.provider || options.model ? [selectModelSession(options, environment)] : [
    ...(["anthropic", "openai"] as const).filter(provider => environment[provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]?.trim())
      .map(provider => modelSession(provider, "api-key", options, environment)),
    modelSession("anthropic", "local-login", options, environment),
    modelSession("openai", "local-login", options, environment),
  ];
  let firstError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    say(`checking ${candidate.provider} ${candidate.model} (${candidate.auth === "api-key" ? "API key" : "local login"})`);
    try {
      await candidate.session.preflight();
      return candidate;
    } catch (error) {
      firstError ??= error;
      if (index < candidates.length - 1) say(`${candidate.provider} ${candidate.auth === "api-key" ? "API key" : "local login"} unavailable (${error instanceof Error ? error.message : String(error)}); trying the next`);
    }
  }
  throw firstError;
}
