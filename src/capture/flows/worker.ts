/**
 * Runs the app's e2e flows (the `e2e` package) on the device Explore already drives. A child process of the capture:
 * the flows are the reviewed commit's own test code, so they run with the narrowed environment the capture gives
 * them and never inside Explore's process. Reads one request file, writes one result file next to it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "e2e/runner";
import type { E2EConfig } from "e2e";
import type { EngineHandle } from "e2e/engine";
import { mobile, type DeviceProvider } from "@e2e-dev/mobile";
import { summarizeFlowReport } from "./report.js";

export type FlowsRequest = {
  projectRoot: string;
  tests: string[];
  platform: "ios" | "android";
  bundleId: string;
  /** The agent-device session name the flows drive the device under; Explore's own session stays locked to its commands. */
  session: string;
  /** Where e2e writes its report and screenshots; inside the capture's private directory. */
  output: string;
  timeoutMs: number;
  /** Explore's EAS session daemon; the token comes through `EXPLORE_FLOWS_DAEMON_TOKEN`. */
  daemon?: { baseUrl: string };
  /** A local agent-device daemon's state directory, when the capture runs a simulator on this machine. */
  stateDir?: string;
  /** The device inside that daemon: a simulator UDID or an adb serial. */
  deviceId?: string;
  agent?: { provider: "openai" | "anthropic"; model: string };
  /** Tests only: a module whose `engine()` export replaces the agent-device engine. */
  engineModule?: string;
};

export type FlowsResult = {
  status: string; exitCode: number;
  errors: Array<{ code: string; message: string }>;
  artifactsRoot: string;
  tests: ReturnType<typeof summarizeFlowReport>;
};

/** Hands e2e the device Explore holds instead of leasing one: same daemon, same simulator, another session name. */
export function exploreDevice(request: FlowsRequest, token: string | undefined): DeviceProvider {
  return {
    name: "expo-explore",
    async acquire() {
      if (request.daemon) return { id: "explore-session", daemon: { baseUrl: request.daemon.baseUrl, ...(token ? { authToken: token } : {}) }, ...(request.deviceId ? { deviceId: request.deviceId } : {}) };
      if (request.stateDir) return { id: "explore-local", client: { stateDir: request.stateDir }, ...(request.deviceId ? { deviceId: request.deviceId } : {}) };
      throw new Error("The flows request names neither a session daemon nor a local daemon state directory");
    },
    async release() { /* Explore stops its own session once the capture is done. */ },
  };
}

async function agentModel(agent: NonNullable<FlowsRequest["agent"]>, environment: NodeJS.ProcessEnv): Promise<unknown> {
  const name = agent.provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai";
  const key = agent.provider === "anthropic" ? environment.ANTHROPIC_API_KEY : environment.OPENAI_API_KEY;
  if (!key) throw new Error(`agent.act in a flow needs ${agent.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} in the capture environment`);
  let module: Record<string, unknown>;
  try { module = await import(name) as Record<string, unknown>; }
  catch { throw new Error(`agent.act in a flow needs ${name} installed next to @expo/explore (e2e builds the model with the AI SDK)`); }
  const create = module[agent.provider === "anthropic" ? "createAnthropic" : "createOpenAI"] as (options: { apiKey: string }) => (model: string) => unknown;
  return create({ apiKey: key })(agent.model);
}

export async function runFlowsWorker(requestPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as FlowsRequest;
  const token = environment.EXPLORE_FLOWS_DAEMON_TOKEN;
  const engine: EngineHandle = request.engineModule
    ? ((await import(request.engineModule)) as { engine: () => EngineHandle }).engine()
    : mobile({ platform: request.platform, device: exploreDevice(request, token), session: request.session, videoTouches: false });
  const config: E2EConfig = {
    targets: [{ name: request.platform, engine, app: { bundleId: request.bundleId } }],
    // The configured suite is exactly the files the config names; nothing else in the app is collected.
    tests: request.tests,
    output: request.output,
    timeout: request.timeoutMs,
    retries: 0,
    workers: 1,
    cache: "read-only",
    ...(request.agent ? { agents: { default: { model: await agentModel(request.agent, environment) as never } } } : {}),
  };
  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(), request.timeoutMs + 60_000);
  try {
    const result = await run({ cwd: request.projectRoot, config, interruptSignal: controller.signal });
    const report = result.report as unknown as { run: { errors?: unknown[] } };
    const output: FlowsResult = { status: result.status, exitCode: result.exitCode,
      errors: (report.run.errors ?? []).flatMap(error => error && typeof error === "object" ? [{ code: String((error as { code?: unknown }).code ?? "ERROR"), message: String((error as { message?: unknown }).message ?? "") }] : []),
      artifactsRoot: join(request.output, "results"), tests: summarizeFlowReport(result.report) };
    await writeFile(join(request.output, "explore-flows.json"), JSON.stringify(output), { mode: 0o600 });
  } finally { clearTimeout(expiry); }
}
