/**
 * The Argent bridge on a worker thread: one bridge and one tool-server connection for a whole capture, instead of a
 * process (and a TLS handshake) per command. The capture thread posts a command and blocks on the shared buffer;
 * this thread runs it through Argent's own client library (the code `argent run` uses) and writes the answer back.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { copyFile, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ArgentCallError, type ArgentCall } from "./argent-driver.js";
import { argentBridgeSettings, createArgentBridge, type ArgentBridge } from "./argent-bridge.js";
import { ensureController } from "../shared/controller-cache.js";

/** The shared buffer: four Int32 header slots, then the UTF-8 answer. */
export const BRIDGE_HEADER_BYTES = 16;
export const BRIDGE_SLOT_READY = 0;
export const BRIDGE_SLOT_LENGTH = 1;
export const BRIDGE_SLOT_KIND = 2;
export const BRIDGE_KIND_RESULT = 0;
/** The bridge cannot run on this thread (Argent's client did not load); the host falls back to the process bridge. */
export const BRIDGE_KIND_UNAVAILABLE = 1;

export type BridgeWorkerData = { shared: SharedArrayBuffer; clientModule?: string };
export type BridgeRequest = { id: number; argv: readonly string[]; timeoutMs?: number } | { abort: number };

const ARGENT_CALL_TIMEOUT_MS = 180_000;

/** Argent's programmatic client, as `dist/client.js` of the pinned release exports it. */
type ArgentClient = { callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ data: unknown; note?: string }> };

/** Whether some bytes begin as a PNG or a JPEG does: `--out` is a screenshot, and nothing else is taken for one. */
function isImage(head: Uint8Array): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg = [0xff, 0xd8, 0xff];
  return [png, jpeg].some(signature => signature.every((byte, index) => head[index] === byte));
}

/** Whether a path names a file that is an image by its content. */
async function imageFile(path: string): Promise<boolean> {
  const file = await open(path, "r").catch(() => undefined);
  if (!file) return false;
  try {
    if (!(await file.stat()).isFile()) return false;
    const head = new Uint8Array(8);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return isImage(head.subarray(0, bytesRead));
  } finally { await file.close(); }
}

/** The first string in a tool's answer that names an image file: the materialized screenshot (`path` first). */
async function materializedFile(data: unknown): Promise<string | undefined> {
  const candidates: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (typeof value === "string") { if (key === "path") candidates.unshift(value); else candidates.push(value); }
    else if (Array.isArray(value)) value.forEach(item => walk(item));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(data);
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && await imageFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * An error's message with its cause's, as Argent's client words a failed fetch: "fetch failed: connect ECONNREFUSED …".
 * A host that resolves to several addresses (localhost: ::1 and 127.0.0.1) fails with an AggregateError whose message is
 * empty, so the causes' codes are named too.
 */
export function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!(cause instanceof Error)) return error.message;
  const codes = [cause, ...(cause instanceof AggregateError ? cause.errors : [])]
    .map(item => (item as { code?: unknown } | undefined)?.code).filter((code): code is string => typeof code === "string" && !cause.message.includes(code));
  return [`${error.message}:`, cause.message, ...(codes.length ? [`(${[...new Set(codes)].join(", ")})`] : [])].filter(Boolean).join(" ");
}

async function loadClient(environment: NodeJS.ProcessEnv, clientModule?: string): Promise<ArgentClient> {
  const module = clientModule ?? join(dirname(await ensureController("argent", { environment })), "client.js");
  const loaded = await import(pathToFileURL(module).href) as { createArgentClient?: () => ArgentClient };
  if (typeof loaded.createArgentClient !== "function") throw new Error(`${module} does not export createArgentClient`);
  return loaded.createArgentClient();
}

/** The in-thread Argent call: the client's `callTool`, with `--out` served from the artifact it materialized. */
export function argentClientCall(client: ArgentClient, signal: () => AbortSignal): ArgentCall {
  return async (tool, args, options) => {
    const active = signal();
    if (active.aborted) throw new ArgentCallError(`argent run ${tool} was not sent: the command was given up.`, false);
    let answer: { data: unknown };
    const timeoutMs = Math.max(1, Math.ceil(Math.min(ARGENT_CALL_TIMEOUT_MS, options?.timeoutMs ?? ARGENT_CALL_TIMEOUT_MS)));
    try { answer = await client.callTool(tool, args, { signal: AbortSignal.any([active, AbortSignal.timeout(timeoutMs)]) }); }
    catch (error) { throw new ArgentCallError(`argent run ${tool} failed: ${failureText(error).slice(0, 800)}`, true); }
    if (!options?.out) return answer.data;
    const file = await materializedFile(answer.data);
    if (!file) {
      const url = (answer.data as { url?: unknown } | null)?.url;
      if (typeof url !== "string") throw new ArgentCallError(`argent run ${tool} did not write ${options.out}`, true);
      const response = await fetch(url, { signal: signal() });
      if (!response.ok) throw new ArgentCallError(`argent run ${tool} did not write ${options.out}: ${response.status}`, true);
      const body = Buffer.from(await response.arrayBuffer());
      if (!isImage(body)) throw new ArgentCallError(`argent run ${tool} did not write ${options.out}: the answer is not an image`, true);
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(options.out, body);
      return { path: options.out };
    }
    await mkdir(dirname(options.out), { recursive: true });
    if (file !== options.out) await copyFile(file, options.out);
    return { path: options.out };
  };
}

if (!isMainThread && parentPort && (workerData as Partial<BridgeWorkerData> | null)?.shared instanceof SharedArrayBuffer) {
  const port = parentPort;
  const { shared, clientModule } = workerData as BridgeWorkerData;
  const header = new Int32Array(shared, 0, BRIDGE_HEADER_BYTES / 4);
  const bytes = new Uint8Array(shared, BRIDGE_HEADER_BYTES);
  const answer = (id: number, kind: number, text: string) => {
    let encoded = Buffer.from(text, "utf8");
    if (encoded.length > bytes.length) {
      encoded = Buffer.from(JSON.stringify({ exitCode: 1, stdout: JSON.stringify({ success: false,
        error: { code: "COMMAND_FAILED", message: `The controller's answer (${encoded.length} bytes) exceeds the bridge buffer.` } }) }));
    }
    bytes.set(encoded);
    Atomics.store(header, BRIDGE_SLOT_LENGTH, encoded.length);
    Atomics.store(header, BRIDGE_SLOT_KIND, kind);
    Atomics.store(header, BRIDGE_SLOT_READY, id);
    Atomics.notify(header, BRIDGE_SLOT_READY);
  };
  const controllers = new Map<number, AbortController>();
  let current: AbortController | undefined;
  const settings = argentBridgeSettings(process.env);
  const bridge: Promise<ArgentBridge> = settings && settings.toolsUrl
    ? loadClient(process.env, clientModule).then(client => createArgentBridge(settings, argentClientCall(client, () => current?.signal ?? new AbortController().signal), "thread"))
    : Promise.reject(new Error("The Argent bridge needs EXPLORE_ARGENT_STATE, EXPLORE_ARGENT_PLATFORM and ARGENT_TOOLS_URL."));
  bridge.catch(() => undefined);
  let queue: Promise<unknown> = Promise.resolve();
  port.on("message", (request: BridgeRequest) => {
    if ("abort" in request) { controllers.get(request.abort)?.abort(new Error("The capture gave up waiting for this command.")); return; }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    queue = queue.then(async () => {
      current = controller;
      try {
        const ready = await bridge.catch(error => { throw Object.assign(error as Error, { unavailable: true }); });
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = await ready.run(request.argv);
        answer(request.id, BRIDGE_KIND_RESULT, JSON.stringify(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if ((error as { unavailable?: boolean }).unavailable) answer(request.id, BRIDGE_KIND_UNAVAILABLE, message);
        else answer(request.id, BRIDGE_KIND_RESULT, JSON.stringify({ exitCode: 1, stdout: JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message } }) }));
      } finally {
        controllers.delete(request.id);
        current = undefined;
      }
    });
  });
}
