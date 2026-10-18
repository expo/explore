import { createLocalCiAgentSession } from "./session-local.js";
import { spawnSync } from "node:child_process";
import { createCiAgentSession, type CiAgentSessionOptions } from "./session.js";
import type { CiAgentRuntimeOptions } from "./runtime.js";
import { assertExecutionMode, readExploreInstructions, type ExploreConfig } from "../../config/explore-config.js";
import { createExplorationInputs } from "../../config/exploration-inputs.js";
import { CiError } from "../../shared/ci-errors.js";
import { assessCaptureReadiness } from "./readiness.js";

export type PrepareCiExplorationOptions = { subscription?: boolean; createSession?: typeof createCiAgentSession; onUsage?: CiAgentSessionOptions["onUsage"] };

/** Resolve credentials only after deterministic planning establishes executable work. */
export async function prepareCiExploration(config: ExploreConfig, project: string, environment: NodeJS.ProcessEnv, active: boolean,
  options: PrepareCiExplorationOptions = {}) {
  const instructions = await readExploreInstructions(project, config);
  if (!active) return { instructionsSha256: instructions?.sha256, agent: undefined };
  const inputs = createExplorationInputs({ ...(instructions ? { instructions: instructions.text } : {}),
    ...(config.setup ? { setup: config.setup } : {}), environment });
  if (config.mode !== "agent") return { instructionsSha256: undefined, agent: undefined };
  if (!options.subscription) assertExecutionMode(config, environment);
  const tracked = spawnSync("git", ["-C", project, "ls-files", "--error-unmatch", "--", config.agent!.instructions!], { encoding: "utf8" });
  if (tracked.status !== 0) throw new CiError({ code: "AGENT_INSTRUCTIONS_UNCOMMITTED", stage: "preflight",
    message: "Agent instructions are not tracked in the application checkout.",
    nextAction: "Commit the exploration instructions alongside the configuration and rerun Explore." });
  const provider = (options.createSession ?? (options.subscription ? createLocalCiAgentSession : createCiAgentSession))(config.agent!, { env: environment,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}) });
  await provider.preflight({ timeoutMs: 30_000 });
  const agent: CiAgentRuntimeOptions = {
    provider, instructions: instructions!.text,
    secretValues: inputs.values, resolveInput: inputs.resolve, contexts: {},
    assessCapture: request => assessCaptureReadiness(provider, request),
  };
  return { instructionsSha256: instructions!.sha256, agent };
}
