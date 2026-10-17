import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exploreCacheRoot } from "../shared/cache-root.js";
import { deleteLocalEmulator, deleteLocalSimulator, emulatorPortsDirectory, stopLocalAgentDevice, stopLocalArgentServer } from "./local-simulator.js";
import type { CommandRunner } from "./run.js";

/**
 * What one capture side started on this machine: its simulator or emulator, its agent-device daemon (under `directory`)
 * and its Argent tool-server, with the process that owns them. A capture that stops cleanly removes its record; one
 * stopped hard (a second Ctrl+C, a killed terminal) leaves it, and the next local review cleans up after it.
 */
export type LocalCaptureRecord = { owner: number; startedAt: string; directory: string; udid?: string; serial?: string; avd?: string;
  argent?: { pid: number; cli: string; home: string } };

function registryDirectory(environment: NodeJS.ProcessEnv): string {
  return join(exploreCacheRoot(environment), "local-captures");
}

/** Records what a capture side starts, as it starts it; `close` forgets it once everything is stopped. */
export async function openLocalCaptureRecord(environment: NodeJS.ProcessEnv, directory: string): Promise<{
  update: (patch: Partial<Omit<LocalCaptureRecord, "owner" | "startedAt" | "directory">>) => Promise<void>; close: () => Promise<void> }> {
  const registry = registryDirectory(environment);
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const path = join(registry, `${randomUUID()}.json`);
  let record: LocalCaptureRecord = { owner: process.pid, startedAt: new Date().toISOString(), directory };
  const write = async () => {
    // Written whole and renamed, so a sweep never reads half a record.
    await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  await write();
  return { update: async patch => { record = { ...record, ...patch }; await write(); }, close: () => rm(path, { force: true }) };
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Stops what captures whose process has exited left running, and says what it stopped. Only what Explore recorded is
 * touched, never other simulators or emulators on this machine. An emulator's console port may have been taken by a
 * live capture since; then that emulator is left alone rather than risk stopping the live one.
 */
export async function sweepLocalCaptures(options: { environment: NodeJS.ProcessEnv; runner: CommandRunner; cwd: string }): Promise<string[]> {
  const registry = registryDirectory(options.environment);
  const swept: string[] = [];
  for (const name of await readdir(registry).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const path = join(registry, name);
    const record = await readFile(path, "utf8").then(text => JSON.parse(text) as LocalCaptureRecord, () => undefined);
    if (!record || typeof record.owner !== "number" || alive(record.owner)) continue;
    const { runner, cwd, environment } = options;
    let complete = true;
    const attempt = async (what: string, stop: () => unknown) => {
      try { await stop(); swept.push(what); } catch { complete = false; }
    };
    if (record.argent && Number.isInteger(record.argent.pid)) {
      const argent = record.argent;
      await attempt(`Argent tool-server (pid ${argent.pid})`, () => stopLocalArgentServer({ ...argent, environment: { PATH: environment.PATH, HOME: argent.home } }));
    }
    if (typeof record.directory === "string") await attempt("agent-device daemon", () => stopLocalAgentDevice(join(record.directory, "agent-device-state")));
    if (typeof record.udid === "string") await attempt(`simulator ${record.udid}`, () => deleteLocalSimulator({ runner, udid: record.udid!, cwd, environment }));
    if (typeof record.serial === "string") {
      const holder = Number(await readFile(join(emulatorPortsDirectory(environment), `${record.serial.slice("emulator-".length)}.lock`), "utf8").catch(() => ""));
      if (!alive(holder) || holder === record.owner) await attempt(`emulator ${record.serial}`, () => deleteLocalEmulator({ runner, serial: record.serial!, cwd, environment }));
    }
    if (!complete) continue;
    if (typeof record.directory === "string") await rm(record.directory, { recursive: true, force: true });
    await rm(path, { force: true });
  }
  return swept;
}
