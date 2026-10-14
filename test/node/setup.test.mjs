import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { runExploreSetup } = await tsImport("../../src/config/setup.ts", import.meta.url);
const { readExploreConfig } = await tsImport("../../src/config/explore-config.ts", import.meta.url);
const exec = promisify(execFile);
const options = { nonInteractive: true, device: "iPhone 17", scope: "changes" };

async function fixture(t) {
  const project = await mkdtemp(join(tmpdir(), "explore-setup-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const json = (path, value) => writeFile(join(project, path), JSON.stringify(value));
  await json("package.json", { dependencies: { expo: "*", "expo-router": "*" } });
  await json("app.json", { expo: { name: "Test app", scheme: "test-app", ios: { bundleIdentifier: "com.example.test" } } });
  await json("eas.json", { build: { explore: { ios: { simulator: true } } } });
  return { project, json, path: join(project, ".expo-explore/config.yaml") };
}

test("non-interactive CLI creates a usable app config and check validates it", async (t) => {
  const { project, path } = await fixture(t);
  const cli = resolve("dist/cli.js");
  const { stdout } = await exec(process.execPath, [cli, "setup", "--project", project, "--device", "iPad mini (A17 Pro)", "--scope", "all", "--json"]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.path, await realpath(path));
  const config = await readExploreConfig(project);
  assert.equal(config.mode, "deterministic");
  assert.equal(config.app.bundleId, "com.example.test");
  assert.equal(config.app.scheme, "test-app");
  assert.equal(config.navigation.provider, "expo-router");
  assert.equal(config.device.name, "iPad mini (A17 Pro)");
  assert.equal(config.exploration.scope, "all");
  const check = await exec(process.execPath, [cli, "setup", "--project", project, "--check", "--json"]);
  assert.equal(JSON.parse(check.stdout).created, false);
});

test("interactive choices are validated and cancellation writes nothing", async (t) => {
  const { project, path } = await fixture(t);
  const answer = (scope, confirm) => ({
    log() {},
    async ask(label, fallback) {
      if (label === "Capture scope") return scope;
      if (label.startsWith("Write")) return confirm;
      return fallback;
    },
  });
  await assert.rejects(runExploreSetup({ project }, answer("all", "no")), /canceled/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await assert.rejects(runExploreSetup({ project }, answer("typo", "yes")), /scope/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await runExploreSetup({ project }, answer("all", "yes"));
  assert.equal((await readExploreConfig(project)).exploration.scope, "all");
});

test("existing config, including parameters and setup, is preserved", async (t) => {
  const { project, path } = await fixture(t);
  await runExploreSetup({ project, ...options });
  await writeFile(path, `${await readFile(path, "utf8")}parameters:\n  /cats/[id]:\n    id: kitten\nsetup:\n  - action: wait\n    milliseconds: 500\n`);
  const before = await readFile(path, "utf8");
  await assert.rejects(runExploreSetup({ project, ...options, scope: "all" }), /already exists and was preserved/);
  assert.equal(await readFile(path, "utf8"), before);
  const checked = await runExploreSetup({ project, check: true });
  assert.equal(checked.config.parameters["/cats/[id]"].id, "kitten");
});

test("EAS profile inheritance is respected and device builds cannot be selected", async (t) => {
  const { project, json, path } = await fixture(t);
  await json("eas.json", { build: {
    base: { ios: { simulator: true } },
    explore: { extends: "base", ios: { buildConfiguration: "Release" } },
    production: { extends: "base", ios: { simulator: false } },
  } });
  await assert.rejects(runExploreSetup({ project, ...options }), /--profile/);
  await assert.rejects(runExploreSetup({ project, ...options, profile: "production" }), /--profile/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await runExploreSetup({ project, ...options, profile: "explore" });
  assert.equal((await readExploreConfig(project)).app.easProfile, "explore");
});

test("dynamic config uses the app's Expo resolver instead of stale app.json", async (t) => {
  const { project } = await fixture(t);
  await writeFile(join(project, "app.config.js"), `module.exports = ({ config }) => ({ ...config, scheme: 'dynamic-app', ios: { bundleIdentifier: 'com.example.dynamic' } });`);
  await assert.rejects(runExploreSetup({ project, ...options }), /installed expo\/config/);
  await mkdir(join(project, "node_modules/expo"), { recursive: true });
  const expoConfig = createRequire(import.meta.url).resolve("@expo/config");
  await writeFile(join(project, "node_modules/expo/config.js"), `module.exports = require(${JSON.stringify(expoConfig)});`);
  await runExploreSetup({ project, ...options });
  const config = await readExploreConfig(project);
  assert.equal(config.app.bundleId, "com.example.dynamic");
  assert.equal(config.app.scheme, "dynamic-app");
});

test("app.config.json takes precedence over app.json", async (t) => {
  const { project, json } = await fixture(t);
  await json("app.config.json", { expo: { scheme: "static-app", ios: { bundleIdentifier: "com.example.static" } } });
  await runExploreSetup({ project, ...options });
  assert.equal((await readExploreConfig(project)).app.bundleId, "com.example.static");
});

test("setup fails before writing for missing prerequisites and invalid choices", async (t) => {
  const { project, json, path } = await fixture(t);
  await assert.rejects(runExploreSetup({ project, ...options, bundleId: "invalid" }), /reverse-DNS/);
  await json("eas.json", { build: { a: { extends: "b" }, b: { extends: "a" } } });
  await assert.rejects(runExploreSetup({ project, ...options }), /Circular EAS/);
  await json("eas.json", { build: { explore: { extends: "missing" } } });
  await assert.rejects(runExploreSetup({ project, ...options }), /Missing inherited EAS/);
  await json("eas.json", { build: { production: {} } });
  await assert.rejects(runExploreSetup({ project, ...options }), /No EAS build profile/);
  await rm(join(project, "eas.json"));
  await assert.rejects(runExploreSetup({ project, ...options }), /No eas.json/);
  await json("package.json", { private: true });
  await assert.rejects(runExploreSetup({ project, ...options }), /--project/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("setup does not follow a config-directory symlink or overwrite a file created during prompts", async (t) => {
  const { project, path } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "explore-setup-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(project, ".expo-explore"));
  await assert.rejects(runExploreSetup({ project, ...options }), /symlink/);
  await rm(join(project, ".expo-explore"));
  await assert.rejects(runExploreSetup({ project }, {
    log() {},
    async ask(label, fallback) {
      if (label.startsWith("Write")) {
        await mkdir(join(project, ".expo-explore"));
        await writeFile(path, "another editor's config");
      }
      return fallback;
    },
  }), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "another editor's config");
});

const { DRAFT_INSTRUCTIONS_MARKER } = await tsImport("../../src/config/setup.ts", import.meta.url);

/** Source analysis as the CLI supplies it, reduced to what setup asks about. */
function analysis({ guards = true } = {}) {
  const route = (logicalPath, extra = {}) => ({ id: `expo-router:${logicalPath}`, logicalPath, routeFile: `src/app${logicalPath}.tsx`, path: logicalPath,
    status: "ready", parameterKey: logicalPath, missingParameters: [], guards: [], searchParameters: { unset: [], opaque: false }, openedBySetup: false, excluded: false, ...extra });
  const guard = guards ? [{ to: "/welcome", sourceFile: "src/app/(member)/_layout.tsx" }] : [];
  return () => ({ commit: "a".repeat(40), provider: "expo-router", diagnostics: [], unusedParameterKeys: [], unknownSetupRoutes: [], unknownExcludedRoutes: [], routes: [
    route("/welcome"),
    route("/(member)/home", { guards: guard }),
    route("/(member)/items/[id]", { path: "/items/[id]", status: "needs-parameters", parameterKey: "/items/[id]", missingParameters: ["id"], guards: guard }),
  ] });
}

function scripted(answers) {
  const asked = [];
  const logs = [];
  return { asked, logs, interaction: {
    log(message) { logs.push(message); },
    async ask(label, fallback) {
      asked.push(label);
      const match = Object.entries(answers).find(([key]) => label.startsWith(key));
      return match ? match[1] : fallback;
    },
  } };
}

test("setup asks for the mode, a real value for each dynamic route, and how to prepare guarded screens", async (t) => {
  const { project } = await fixture(t);
  const { asked, logs, interaction } = scripted({ "/items/[id] → id": "item-1", "Prepare app state with": "setup template" });
  const result = await runExploreSetup({ project }, interaction, { analyzeRoutes: analysis() });
  assert.ok(asked.indexOf("Capture mode") < asked.indexOf("/items/[id] → id"));
  assert.match(logs.join("\n"), /no API key, no AI charges/);
  assert.match(logs.join("\n"), /src\/app\/\(member\)\/_layout\.tsx → \/welcome \(2 routes\)/);
  const config = await readExploreConfig(project);
  assert.equal(config.mode, "deterministic");
  assert.deepEqual(config.parameters, { "/items/[id]": { id: "item-1" } });
  const yaml = await readFile(join(project, ".expo-explore/config.yaml"), "utf8");
  assert.match(yaml, /# setup: put the app in the state each screen needs/);
  assert.match(yaml, /# {5}url: test-app:\/\//);
  assert.deepEqual(result.routes.needsParameters, ["/items/[id]"]);
  assert.match(result.nextSteps[0], /coding agent.*explore-setup\/SKILL\.md/s);
  assert.ok(result.nextSteps.some(step => step.startsWith("gh secret set EXPO_TOKEN")));
  assert.ok(!result.nextSteps.some(step => step.includes("ANTHROPIC_API_KEY")));
});

test("choosing agent mode for guarded screens asks for the provider and model and drafts instructions from the answers", async (t) => {
  const { project } = await fixture(t);
  const { logs, interaction } = scripted({
    "Prepare app state with": "agent mode", "Model provider": "anthropic", "Model ID": "example-model",
    "What state or test inputs": "Sign in with {{secret:EXAMPLE_LOGIN}} and {{secret:EXAMPLE_PASSWORD}}.",
  });
  const result = await runExploreSetup({ project }, interaction, { analyzeRoutes: analysis() });
  const config = await readExploreConfig(project);
  assert.equal(config.mode, "agent");
  assert.deepEqual(config.agent, { provider: "anthropic", model: "example-model", instructions: ".expo-explore/instructions.md" });
  const instructions = await readFile(join(project, ".expo-explore/instructions.md"), "utf8");
  assert.ok(instructions.startsWith(DRAFT_INSTRUCTIONS_MARKER));
  assert.match(instructions, /Sign in with \{\{secret:EXAMPLE_LOGIN\}\}/);
  assert.match(instructions, /- src\/app\/\(member\)\/_layout\.tsx → \/welcome/);
  assert.match(logs.join("\n"), /platform\.claude\.com\/docs\/en\/about-claude\/models/);
  const steps = result.nextSteps.join("\n");
  assert.match(steps, /gh secret set ANTHROPIC_API_KEY.*platform\.claude\.com\/settings\/keys.*billed/);
  assert.match(steps, /ANTHROPIC_WORKSPACE_ID/);
  assert.match(steps, /gh secret set EXAMPLE_LOGIN/);
  assert.match(steps, /gh secret set EXAMPLE_PASSWORD/);
  assert.match(steps, /expo-explore doctor --check-model/);
});

test("non-interactive setup takes every answer from flags and installs CI files with the referenced secrets", async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(runExploreSetup({ project, ...options, mode: "agent" }, undefined, {}), /--provider .* and --model/);
  await assert.rejects(runExploreSetup({ project, ...options, params: ["/items/[id]=x"] }, undefined, {}), /ROUTE\.NAME=VALUE/);
  const installs = [];
  const result = await runExploreSetup({ project, ...options, mode: "agent", provider: "openai", model: "example-model",
    params: ["/items/[id].id=item-1"], workflows: true }, undefined,
    { analyzeRoutes: analysis(), installWorkflows: async (_project, secrets) => { installs.push(secrets); return { written: [".github/workflows/explore-review.yml"], kept: [], notes: [] }; } });
  const config = await readExploreConfig(project);
  assert.equal(config.agent.provider, "openai");
  assert.deepEqual(config.parameters, { "/items/[id]": { id: "item-1" } });
  assert.deepEqual(installs, [[]]);
  assert.ok(!result.nextSteps.some(step => step.includes("setup --workflows")));
  assert.match(result.nextSteps.join("\n"), /gh secret set OPENAI_API_KEY/);
  assert.match(await readFile(join(project, ".expo-explore/instructions.md"), "utf8"), /## Reaching screens/);
});

test("without source redirects or parameter gaps, setup does not ask about app state", async (t) => {
  const { project } = await fixture(t);
  const { asked, interaction } = scripted({});
  const noGaps = () => ({ ...analysis({ guards: false })(), routes: analysis({ guards: false })().routes.filter(route => route.status === "ready") });
  const result = await runExploreSetup({ project }, interaction, { analyzeRoutes: noGaps });
  assert.ok(!asked.includes("Prepare app state with"));
  assert.ok(!result.nextSteps.some(step => step.includes("coding agent")));
  assert.match(result.nextSteps.join("\n"), /expo-explore setup --workflows/);
});

test("non-interactive setup uses the wizard defaults and names a missing bundle identifier", async (t) => {
  const { project, json } = await fixture(t);
  await runExploreSetup({ project, nonInteractive: true });
  const config = await readExploreConfig(project);
  assert.equal(config.device.name, "iPhone 17");
  assert.equal(config.exploration.scope, "changes");
  await rm(join(project, ".expo-explore"), { recursive: true });
  await json("app.json", { expo: { name: "Test app" } });
  await assert.rejects(runExploreSetup({ project, nonInteractive: true }), /No iOS bundle identifier found.*--bundle-id/);
});
