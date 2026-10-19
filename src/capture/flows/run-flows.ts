/**
 * Runs the app's e2e flows on the capture's device and turns the frames they took into bundle evidence. The flows
 * are the `e2e` package's test files; Explore adds nothing to their language. A flow that fails keeps the frames it
 * took before failing, and the capture goes on: flows are review evidence, not a gate.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile, mkdtemp, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BundleFlow, FlowFrame } from "../../contracts/capture.js";
import { assertDecodedPng } from "../../shared/png-evidence.js";
import { CONTROLLER_SESSION } from "../common.js";
import type { CommandRunner } from "../run.js";
import type { SimulatorConnection } from "../simulator.js";
import type { FlowsRequest, FlowsResult } from "./worker.js";

export const FLOWS_WORKER = fileURLToPath(new URL("./worker-main.js", import.meta.url));
/** The agent-device session the flows drive the device under, beside Explore's own locked session. */
/**
 * The agent-device session the flows use: Explore's own. A daemon lets one session hold a device; a second session name
 * connects but cannot open the app ("Device is already in use by session expo-explore-runtime", seen on EAS Simulator).
 */
export const FLOWS_SESSION = CONTROLLER_SESSION;
/** Where e2e writes while the flows run, inside the app directory as e2e requires; removed once the frames are copied out. */
export const FLOWS_OUTPUT_DIRECTORY = ".expo-explore-flows";
const MAX_FRAME_BYTES = 30 * 1024 * 1024;

export type RunFlowsOptions = {
  project: string;
  tests: readonly string[];
  platform: "ios" | "android";
  bundleId: string;
  connection?: SimulatorConnection | undefined;
  /** The local agent-device daemon's state directory when the capture has no session daemon. */
  stateDir?: string | undefined;
  deviceId?: string | undefined;
  /** The capture's private directory: the request, e2e's output and report go under it. */
  workDirectory: string;
  /** The bundle directory the frames are exported into, under `flows/`. */
  outputDirectory: string;
  runner: CommandRunner;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  agent?: { provider: "openai" | "anthropic"; model: string } | undefined;
  /** `steps`: a frame after every step of every flow, not only where a flow calls app.screenshot. */
  frames?: "checkpoints" | "steps" | undefined;
  progress?: ((message: string) => void) | undefined;
  /** Tests only: an engine module in place of agent-device. */
  engineModule?: string | undefined;
};

export type FlowsOutcome = { flows: Record<string, BundleFlow>; failure?: { code: string; message: string } };

/** The relative bundle path of a flow frame. */
export const flowFramePath = (flowId: string, key: string): string => `flows/${flowId}/${key}.png`;

export async function runFlows(options: RunFlowsOptions): Promise<FlowsOutcome> {
  const say = options.progress ?? (() => {});
  const work = join(options.workDirectory, "flows");
  await mkdir(work, { recursive: true, mode: 0o700 });
  // e2e keeps its report and screenshots inside the project it tests, so they live in the app directory while the
  // flows run and leave with the frames copied out: the capture's checkout must be clean again when it ends.
  // The sides of one commit share a checkout across platforms, so each run gets its own directory under it.
  const root = join(options.project, FLOWS_OUTPUT_DIRECTORY);
  const existing = await lstat(root).catch(() => undefined);
  if (existing && !existing.isDirectory()) return { flows: {}, failure: { code: "FLOWS_OUTPUT_EXISTS", message: `${FLOWS_OUTPUT_DIRECTORY} exists in the app directory and is not a directory; remove it and rerun.` } };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(join(root, `${options.platform}-`));
  try { return await executeFlows(options, work, output, say); }
  finally {
    await rm(output, { recursive: true, force: true });
    // The last run out removes the directory; a concurrent run's files keep it (ENOTEMPTY).
    await rmdir(root).catch(async () => {
      const left = await readdir(root).catch(() => []);
      if (left.length) say(`${FLOWS_OUTPUT_DIRECTORY} still holds ${left.slice(0, 3).join(", ")}${left.length > 3 ? ", …" : ""} (another run, or a late writer)`);
    });
  }
}

async function executeFlows(options: RunFlowsOptions, work: string, output: string, say: (message: string) => void): Promise<FlowsOutcome> {
  const request: FlowsRequest = {
    projectRoot: options.project, tests: [...options.tests], platform: options.platform, bundleId: options.bundleId, session: FLOWS_SESSION,
    output, timeoutMs: options.timeoutMs, frames: options.frames ?? "checkpoints",
    ...(options.connection ? { daemon: { baseUrl: options.connection.daemonBaseUrl } } : options.stateDir ? { stateDir: options.stateDir } : {}),
    ...(options.deviceId ? { deviceId: options.deviceId } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.engineModule ? { engineModule: options.engineModule } : {}),
  };
  const requestPath = join(work, "request.json");
  await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  say(`running ${options.tests.length} flow ${options.tests.length === 1 ? "file" : "files"} with e2e`);
  // The worker's exit code is e2e's: 1 for failed tests, which is a result here, not a fault.
  const result = options.runner({ command: process.execPath, args: [FLOWS_WORKER, requestPath], cwd: options.project,
    environment: { ...options.environment, E2E_TELEMETRY_DISABLED: "1", ...(options.connection?.daemonAuthToken ? { EXPLORE_FLOWS_DAEMON_TOKEN: options.connection.daemonAuthToken } : {}) },
    timeoutMs: options.timeoutMs + 120_000, allowFailure: true });
  let summary: FlowsResult;
  try { summary = JSON.parse(await readFile(join(output, "explore-flows.json"), "utf8")) as FlowsResult; }
  catch {
    // The worker prints the error and its stack; the message is the error lines, not the frames.
    const message = (result.stderr || result.stdout).trim().split("\n").filter(line => line.trim() && !/^\s+at /.test(line)).slice(0, 4).join("\n").slice(0, 2_000);
    say(`the flows did not run: ${message || "the e2e worker wrote no result"}`);
    return { flows: {}, failure: { code: "FLOWS_NOT_RUN", message: message || "The e2e worker wrote no result." } };
  }
  const artifactsRoot = await realpath(summary.artifactsRoot).catch(() => resolve(summary.artifactsRoot));
  const flows: Record<string, BundleFlow> = {};
  for (const test of summary.tests) {
    const frames: Record<string, FlowFrame> = {};
    for (const frame of test.frames) {
      try {
        const source = await realpath(resolve(artifactsRoot, frame.path));
        if (isAbsolute(frame.path) || relative(artifactsRoot, source).startsWith("..") || source.split(sep).includes("..")) throw new Error("outside the e2e artifacts");
        const info = await lstat(source);
        if (!info.isFile() || info.size > MAX_FRAME_BYTES) throw new Error("not a bounded regular file");
        const png = await readFile(source);
        assertDecodedPng(png, `Flow frame ${test.id}/${frame.key}`);
        const path = flowFramePath(test.id, frame.key);
        await mkdir(join(options.outputDirectory, dirname(path)), { recursive: true });
        await copyFile(source, join(options.outputDirectory, path));
        frames[frame.key] = { path, sha256: createHash("sha256").update(png).digest("hex"), width: png.readUInt32BE(16), height: png.readUInt32BE(20),
          capturedAt: Number.isFinite(Date.parse(frame.capturedAt)) ? frame.capturedAt : new Date().toISOString() };
      } catch (error) {
        say(`flow ${test.id}: frame ${frame.key} was not kept (${(error as Error).message})`);
        const step = test.steps[frame.stepIndex];
        if (step) delete step.frame;
      }
    }
    flows[test.id] = { file: test.file, title: test.title, status: test.status, durationMs: test.durationMs, ...(test.error ? { error: test.error } : {}),
      steps: test.steps.map(step => ({ ...step, ...(step.frame && !frames[step.frame] ? { frame: undefined } : {}) })).map(({ frame, ...rest }) => frame ? { ...rest, frame } : rest),
      frames };
    const taken = Object.keys(frames).length;
    say(`flow ${test.title}: ${test.status}${taken ? `, ${taken} ${taken === 1 ? "frame" : "frames"}` : ""}${test.error ? ` (${test.error.code}: ${test.error.message.split("\n")[0]})` : ""}`);
  }
  if (summary.stepFrames) {
    const { taken, failed, firstError } = summary.stepFrames;
    say(`${taken} step ${taken === 1 ? "frame" : "frames"} taken${failed ? `, ${failed} not taken (${firstError})` : ""}`);
  }
  const failure = summary.errors[0];
  return { flows, ...(failure && !summary.tests.length ? { failure: { code: failure.code, message: failure.message } } : {}) };
}
