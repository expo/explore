import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runFlows, flowFramePath } from "../../dist/capture/flows/run-flows.js";
import { defaultRunner } from "../../dist/capture/controller.js";

const engineModule = fileURLToPath(new URL("../fixtures/flows/fake-engine.mjs", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));

async function project(files) {
  const root = await mkdtemp(join(tmpdir(), "explore-flows-"));
  const app = join(root, "app");
  await mkdir(join(app, "e2e"), { recursive: true });
  // The app resolves `e2e` the way a real app does: from its own node_modules.
  await mkdir(join(app, "node_modules"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(join(repo, "node_modules", "e2e"), join(app, "node_modules", "e2e"), "dir");
  for (const [name, source] of Object.entries(files)) await writeFile(join(app, "e2e", name), source);
  return { root, app, work: join(root, "work"), output: join(root, "bundle") };
}

const run = async (files, options = {}) => {
  const paths = await project(files);
  await mkdir(paths.work, { recursive: true });
  await mkdir(paths.output, { recursive: true });
  const progress = [];
  const result = await runFlows({ project: paths.app, tests: Object.keys(files).map(name => `e2e/${name}`), platform: "ios", bundleId: "com.example.app",
    stateDir: join(paths.work, "state"), workDirectory: paths.work, outputDirectory: paths.output, runner: defaultRunner, environment: { ...process.env },
    timeoutMs: 60_000, progress: message => progress.push(message), engineModule, ...options });
  return { ...paths, result, progress };
};

test("runs e2e flows through the worker and keeps every app.screenshot as a bundle frame", async () => {
  const { result, output, root } = await run({ "send.e2e.ts": `import { test, expect } from "e2e";
test("send money reaches contacts", async ({ app, screen }) => {
  await app.screenshot("home");
  await screen.getByTestId("home-send").tap();
  await expect(screen.getByRole("heading", "Your contacts")).toBeVisible();
  await app.screenshot("contacts");
});
` });
  try {
    assert.equal(result.failure, undefined);
    assert.deepEqual((await readdir(join(root, "app"))).filter(name => name.startsWith(".expo-explore")), [], "e2e's output leaves the app directory");
    const flow = result.flows["send/send-money-reaches-contacts"];
    assert.ok(flow, Object.keys(result.flows).join(","));
    assert.equal(flow.status, "passed");
    assert.deepEqual(flow.steps.map(step => [step.api, step.status, step.frame]),
      [["app.screenshot", "passed", "home"], ["locator.tap", "passed", undefined], ["expect.toBeVisible", "passed", undefined], ["app.screenshot", "passed", "contacts"]]);
    assert.deepEqual(Object.keys(flow.frames), ["home", "contacts"]);
    for (const [key, frame] of Object.entries(flow.frames)) {
      assert.equal(frame.path, flowFramePath("send/send-money-reaches-contacts", key));
      assert.deepEqual([frame.width, frame.height], [1, 1]);
      const bytes = await readFile(join(output, frame.path));
      assert.equal(bytes.length > 0, true);
      assert.match(frame.sha256, /^[a-f0-9]{64}$/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failing flow keeps the frames before the failure and reports the failing step; the capture goes on", async () => {
  const { result, root } = await run({ "broken.e2e.ts": `import { test, expect } from "e2e";
test("taps a contact that is not there", async ({ app, screen }) => {
  await app.screenshot("home");
  await screen.getByTestId("home-send").tap();
  await screen.getByText("Nobody Here").tap();
  await app.screenshot("never");
});
` });
  try {
    assert.equal(result.failure, undefined);
    const flow = result.flows["broken/taps-a-contact-that-is-not-there"];
    assert.equal(flow.status, "failed");
    assert.deepEqual(Object.keys(flow.frames), ["home"]);
    assert.equal(flow.steps[2].status, "failed");
    assert.ok(flow.error?.code, JSON.stringify(flow));
  } finally { await rm(root, { recursive: true, force: true }); }
});
