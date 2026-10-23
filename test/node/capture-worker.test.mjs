import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

const { settleCaptureWorker } = await import("../../dist/ci/capture-worker.js");

// A worker that names a blocking call, then really blocks its thread in a synchronous subprocess, as a capture's
// install or native build does, and reports its result a little after the call returns.
const blockingWorker = `
const { parentPort } = require("node:worker_threads");
const { spawnSync } = require("node:child_process");
parentPort.postMessage({ type: "progress", message: "installing the app" });
parentPort.postMessage({ type: "blocking", phase: "install", boundMs: 15 * 60000 });
spawnSync("sleep", ["0.8"]);
parentPort.postMessage({ type: "unblocked" });
setTimeout(() => parentPort.postMessage({ type: "done", result: { outputDirectory: "/out" } }), 400);
`;

test("while a capture worker is blocked in a call it named, the parent prints a line on its own, and stops when the call returns", async () => {
  const lines = [];
  const started = Date.now();
  const result = await settleCaptureWorker(new Worker(blockingWorker, { eval: true }), { side: "head", appearancePass: { all: ["light", "dark"], capture: ["dark"] } },
    line => lines.push({ line, at: Date.now() - started }), undefined, 100);
  assert.deepEqual(result, { outputDirectory: "/out" });
  assert.equal(lines[0].line, "installing the app");
  const beats = lines.slice(1);
  assert.ok(beats.length >= 4, `heartbeats while blocked: ${JSON.stringify(lines)}`);
  assert.match(beats[0].line, /^head dark: still in install \(\d+ ms of at most 15 min\)$/);
  // None after the call returned: the last 400 ms before the result are quiet.
  assert.ok(beats.at(-1).at < Date.now() - started - 250, JSON.stringify(lines));
});

test("a worker that names no blocking call gets no heartbeat, and its failure still settles the capture", async () => {
  const lines = [];
  const worker = new Worker(`require("node:worker_threads").parentPort.postMessage({ type: "error", error: { code: "CAPTURE_INSTALL_FAILED", stage: "session", message: "m", nextAction: "n", retryable: false } });`, { eval: true });
  await assert.rejects(settleCaptureWorker(worker, { side: "base" }, line => lines.push(line), undefined, 50), error => error.code === "CAPTURE_INSTALL_FAILED");
  assert.deepEqual(lines, []);
});
