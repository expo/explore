import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { abandonSharedBuilds, sharedBuild } from "../../dist/capture/shared-build.js";

const key = { platform: "ios", easProfile: "explore", bundleId: "com.example.app", gitCommit: "a".repeat(40), repack: "local", local: true, routes: ["/", "/settings"] };

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "explore-shared-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("targets of one commit share one build: the first builds it, the others wait for its result", async t => {
  const directory = await scratch(t);
  let builds = 0, waited = 0;
  let finish, started;
  const building = new Promise(resolve => { started = resolve; });
  const owner = sharedBuild({ directory, key, appName: "App.app", owner: "/work/phone/head",
    build: () => new Promise(resolve => { builds += 1; finish = () => resolve({ buildId: "native", app: "App.app" }); started(); }) });
  // The first to claim the build's folder builds it; the second capture starts once it has.
  await building;
  // Routes are compared sorted, so the same set in another order is the same build.
  const waiter = sharedBuild({ directory, key: { ...key, routes: ["/settings", "/"] }, appName: "App.app", owner: "/work/duo/head",
    build: async () => { builds += 1; return { buildId: "other", app: "Other.app" }; }, waiting: () => { waited += 1; } });
  finish();
  assert.deepEqual(await owner, { buildId: "native", app: "App.app" });
  assert.deepEqual(await waiter, { buildId: "native", app: "App.app" });
  assert.deepEqual([builds, waited], [1, 1]);
});

test("a shared build that fails fails the targets waiting on it", async t => {
  const directory = await scratch(t);
  let started;
  const building = new Promise(resolve => { started = resolve; });
  const owner = sharedBuild({ directory, key, appName: "App.app", build: async () => { started(); await new Promise(resolve => setTimeout(resolve, 20)); throw new Error("repack-app exited with status 1"); } });
  await building;
  const waiter = sharedBuild({ directory, key, appName: "App.app", build: async () => assert.fail("only the owner builds") });
  await assert.rejects(owner, /repack-app exited/);
  await assert.rejects(waiter, error => error.code === "CAPTURE_BUILD_FAILED" && /The shared build failed: repack-app exited/.test(error.message));
});

test("a capture that ends without finishing its shared build releases the targets waiting on it", async t => {
  const directory = await scratch(t);
  // The owner's worker exits mid-build: its build never resolves and writes nothing.
  let started;
  const building = new Promise(resolve => { started = resolve; });
  void sharedBuild({ directory, key, appName: "App.app", owner: "/work/phone/head", build: () => { started(); return new Promise(() => {}); } });
  await building;
  const waiter = sharedBuild({ directory, key, appName: "App.app", owner: "/work/duo/head", build: async () => assert.fail("only the owner builds") });
  const outcome = waiter.then(() => "resolved", error => error);
  // Another target's failure leaves its builds alone; only the dead capture's are failed.
  await abandonSharedBuilds(directory, owner => owner.startsWith("/work/duo/"), "duo failed");
  assert.equal(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("waiting"), 2_500))]), "waiting");
  await abandonSharedBuilds(directory, owner => owner.startsWith("/work/phone/"), "CAPTURE_WORKER_EXITED");
  const error = await outcome;
  assert.equal(error.code, "CAPTURE_BUILD_FAILED");
  assert.match(error.message, /the capture building it stopped \(CAPTURE_WORKER_EXITED\)/);
});
