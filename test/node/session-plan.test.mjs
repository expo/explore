import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sideAppearancePasses } from "../../dist/ci/pipeline.js";
import { DEFAULT_MAX_SESSIONS, maxParallelTargets, planSideSessions, sessionShare } from "../../dist/ci/session-plan.js";
import { validateExploreConfig } from "../../dist/config/explore-config.js";

test("the review-wide session ceiling is divided over the targets, the remainder going to the preferred ones", () => {
  const targets = ["iphone", "duo-closed", "duo-open", "android"];
  const prefer = target => target.startsWith("duo") ? 1 : 0;
  assert.equal(sessionShare({ maxSessions: 8, targets, target: "android" }), 2);
  assert.equal(sessionShare({ maxSessions: 16, targets, target: "iphone" }), 4);
  assert.equal(sessionShare({ maxSessions: 10, targets, target: "duo-closed", prefer }), 3, "remainder goes to the foldable first");
  assert.equal(sessionShare({ maxSessions: 10, targets, target: "duo-open", prefer }), 3);
  assert.equal(sessionShare({ maxSessions: 10, targets, target: "iphone", prefer }), 2);
  assert.equal(sessionShare({ maxSessions: 2, targets, target: "iphone" }), 1, "never below one");
});

test("unset, the ceiling is a typical plan's five simulators; below the number of targets, that many target jobs run at once", () => {
  assert.equal(DEFAULT_MAX_SESSIONS, 5);
  // One target: head and base at once, with sessions left to split light and dark.
  assert.equal(sessionShare({ maxSessions: undefined, targets: ["iphone"], target: "iphone" }), 5);
  assert.deepEqual(planSideSessions({ share: 5, sides: 2, routes: 16, schemes: ["light", "dark"] }), { concurrentSides: true, passes: [["light"], ["dark"]] });
  // Two targets: two each, head and base at once, as before the option.
  for (const target of ["iphone", "android"]) assert.equal(sessionShare({ maxSessions: undefined, targets: ["iphone", "android"], target }), 2);
  // Five targets: one each, head then base.
  const five = ["iphone", "ipad", "duo-closed", "duo-open", "android"];
  for (const target of five) assert.equal(sessionShare({ maxSessions: undefined, targets: five, target }), 1);
  assert.equal(planSideSessions({ share: 1, sides: 2, routes: 16, schemes: ["light", "dark"] }).concurrentSides, false);
  assert.deepEqual([maxParallelTargets(undefined, 1), maxParallelTargets(undefined, 2), maxParallelTargets(undefined, 5), maxParallelTargets(undefined, 7)], [1, 2, 5, 5]);
  // A starter plan, one simulator per platform: an iOS and an Android target, one session each, both jobs at once.
  for (const target of ["iphone", "android"]) assert.equal(sessionShare({ maxSessions: 2, targets: ["iphone", "android"], target }), 1);
  assert.equal(maxParallelTargets(2, 2), 2);
  // A ceiling below the targets: one session each, and only that many target jobs at a time.
  for (const target of five) assert.equal(sessionShare({ maxSessions: 2, targets: five, target }), 1);
  assert.equal(maxParallelTargets(2, 5), 2);
  assert.equal(maxParallelTargets(16, 4), 4);
});

test("a side splits its appearance passes only when the pass moved out saves at least a minute", () => {
  const euxy = { sides: 2, routes: 16, schemes: ["light", "dark"] };
  assert.deepEqual(planSideSessions({ share: 2, ...euxy }), { concurrentSides: true, passes: [["light", "dark"]] });
  assert.deepEqual(planSideSessions({ share: 4, ...euxy }), { concurrentSides: true, passes: [["light"], ["dark"]] });
  assert.deepEqual(planSideSessions({ share: 3, ...euxy }), { concurrentSides: true, passes: [["light", "dark"]] }, "one spare session cannot host a pass for both sides");
  assert.deepEqual(planSideSessions({ share: 8, ...euxy, routes: 3 }), { concurrentSides: true, passes: [["light", "dark"]] }, "three routes would save under a minute");
  assert.deepEqual(planSideSessions({ share: 8, ...euxy, schemes: ["light"] }), { concurrentSides: true, passes: [["light"]] }, "one appearance never splits");
  assert.deepEqual(planSideSessions({ share: 1, ...euxy }), { concurrentSides: false, passes: [["light", "dark"]] }, "one session: the sides take turns");
  assert.deepEqual(planSideSessions({ share: 2, sides: 1, routes: 16, schemes: ["light", "dark"] }), { concurrentSides: true, passes: [["light"], ["dark"]] }, "a baseline has one side");
});

test("a side's appearances come from eas config in a child with the capture's environment, read only when a split could pay", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-session-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The app config would leak this process's environment if it were evaluated here.
  await writeFile(join(root, "app.config.js"), `module.exports = () => { require("fs").writeFileSync(${JSON.stringify(join(root, "evaluated"))}, "yes"); return {}; };\n`);
  const eas = join(root, "eas");
  await writeFile(eas, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n");
process.stdout.write(JSON.stringify({ appConfig: { userInterfaceStyle: require("fs").existsSync("light-only") ? "light" : "automatic" }, buildProfile: {} }));
`);
  await chmod(eas, 0o755);
  const calls = async () => (await readFile(join(root, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const config = maxSessions => validateExploreConfig({ app: { bundleId: "com.example.app", easProfile: "explore" }, device: { name: "iPhone 17" },
    ...(maxSessions === undefined ? {} : { capture: { maxSessions } }) });
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, EXPO_TOKEN: "expo-token", GITHUB_TOKEN: "github-token", ANTHROPIC_API_KEY: "agent-key" };
  const side = { share: 2, sides: 1, routes: 16, project: root, easCommand: eas };
  assert.equal(await sideAppearancePasses(config(8), environment, { ...side, routes: 3 }), undefined, "three routes would save under a minute");
  assert.equal(await sideAppearancePasses(config(1), environment, { ...side, share: 1 }), undefined);
  assert.deepEqual(await calls(), [], "no app config is read when no split could pay");
  assert.deepEqual(await sideAppearancePasses(config(2), environment, side), [["light"], ["dark"]]);
  const [call] = await calls();
  assert.deepEqual(call.args, ["config", "--platform", "ios", "--profile", "explore", "--json", "--non-interactive"]);
  assert.equal(await realpath(call.cwd), await realpath(root));
  assert.equal(call.env.EXPO_TOKEN, "expo-token");
  assert.equal(call.env.GITHUB_TOKEN, undefined);
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  await assert.rejects(readFile(join(root, "evaluated")), "the app config is never evaluated in the review's process");
  assert.deepEqual(await sideAppearancePasses(config(undefined), environment, side), [["light"], ["dark"]], "unset, the default ceiling's share splits too");
  // Each side reads its own app config: one that declares a single appearance keeps one session.
  const lightOnly = join(root, "base"); await mkdir(lightOnly); await writeFile(join(lightOnly, "light-only"), "");
  assert.equal(await sideAppearancePasses(config(2), environment, { ...side, project: lightOnly }), undefined);
  assert.equal(await sideAppearancePasses(config(2), environment, { ...side, easCommand: join(root, "missing-eas") }), undefined, "an unreadable config keeps one session");
});
