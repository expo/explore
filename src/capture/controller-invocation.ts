import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SimulatorConnection } from "./simulator.js";
import { controllerCacheRoot } from "../shared/controller-cache.js";

/** The Argent bridge's entry, run where agent-device's CLI would be. */
export const ARGENT_CONTROLLER_WORKER = fileURLToPath(new URL("./argent-controller-worker.js", import.meta.url));

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The command and environment that drive an Argent session the way agent-device's are run: a small executable in
 * the run's private directory runs the bridge with this Node, so every caller keeps passing one command and its
 * arguments. The bridge gets only the session's tool-server variables, telemetry off, and a HOME of its own, so
 * Argent's state (links, downloaded recordings) is never shared between runs or sides of a review.
 */
export async function argentControllerInvocation(options: {
  directory: string; connection: SimulatorConnection; platform: "ios" | "android"; environment: NodeJS.ProcessEnv; bundleId?: string;
}): Promise<{ command: string; environment: NodeJS.ProcessEnv }> {
  const home = join(options.directory, "argent-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const command = join(options.directory, "argent-controller");
  await writeFile(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(ARGENT_CONTROLLER_WORKER)} "$@"\n`, { mode: 0o700 });
  // agent-device's variables never reach Argent's bridge, and Argent's never reach agent-device.
  const environment = Object.fromEntries(Object.entries(options.environment).filter(([name]) => !/^(AGENT_DEVICE_|ARGENT_)/.test(name)));
  return {
    command,
    environment: { ...environment, HOME: home, DO_NOT_TRACK: "1",
      ARGENT_TOOLS_URL: options.connection.daemonBaseUrl,
      ...(options.connection.daemonAuthToken ? { ARGENT_AUTH_TOKEN: options.connection.daemonAuthToken } : {}),
      EXPLORE_ARGENT_STATE: join(options.directory, "argent-state.json"), EXPLORE_ARGENT_PLATFORM: options.platform,
      // The bridge runs with a HOME of its own, so it is told where the fetched Argent release is cached.
      EXPLORE_CONTROLLER_CACHE: controllerCacheRoot(options.environment),
      ...(options.bundleId ? { EXPLORE_ARGENT_BUNDLE_ID: options.bundleId } : {}) },
  };
}
