import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { formatCaptureCheck, formatDoctorReport, runCaptureCheck, runDoctor, summarizeCaptureCheck } from "../../dist/ci/doctor.js";
import { readRouteEntry, readSearchParameters } from "../../dist/ci/route-entry.js";
import { WORKFLOW_FILES, installCiFiles, renderWorkflow, stampWorkflow, workflowIssues, workflowTemplateDrift, workflowUnmodified, workflowVersion } from "../../dist/ci/workflow-install.js";
import { unreproducibleEasVariables } from "../../dist/capture/eas-build.js";
import { DRAFT_INSTRUCTIONS_MARKER } from "../../dist/config/setup.js";
import { CiError } from "../../dist/shared/ci-errors.js";
import { writeCaptureObserverPackages } from "../helpers/capture-observer-fixture.mjs";

const baseConfig = {
  mode: "deterministic",
  app: { name: "Example", platform: "ios", bundleId: "com.example.app", easProfile: "explore", scheme: "example-app" },
  navigation: { provider: "expo-router" },
  device: { name: "iPhone 17" },
  exploration: { scope: "all" },
  capture: { maxMinutes: 30, maxActions: 500 },
};

const source = {
  "package.json": JSON.stringify({ name: "example", dependencies: { expo: "57.0.0", "expo-router": "57.0.0" } }),
  "package-lock.json": "{}",
  ".gitignore": "node_modules\n",
  "app.json": JSON.stringify({ expo: { name: "Example", scheme: "example-app", ios: { bundleIdentifier: "com.example.app" } } }),
  "eas.json": JSON.stringify({ build: { explore: { ios: { simulator: true } } } }),
  "src/session.ts": "export function useSession(): string | null { return null; }\n",
  "src/app/_layout.tsx": "import { Stack } from 'expo-router';\nexport default function Root() { return <Stack />; }\n",
  "src/app/index.tsx": "import { Text } from 'react-native';\nexport default function Index() { return <Text>Start</Text>; }\n",
  "src/app/welcome.tsx": "import { Text } from 'react-native';\nexport default function Welcome() { return <Text>Welcome</Text>; }\n",
  "src/app/(member)/_layout.tsx": "import { Redirect, Stack } from 'expo-router';\nimport { useSession } from '../../session';\n"
    + "export default function Member() { const session = useSession(); if (!session) return <Redirect href=\"/welcome\" />; return <Stack />; }\n",
  "src/app/(member)/home.tsx": "import { Text } from 'react-native';\nexport default function Home() { return <Text>Home</Text>; }\n",
  "src/app/(member)/items/[id].tsx": "import { Text } from 'react-native';\nexport default function Item() { return <Text>Item</Text>; }\n",
};

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

async function app(t, config = baseConfig, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, { ...source, ".expo-explore/config.yaml": stringify(config), ...extra });
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "app");
  return root;
}

async function workflows(root, options = {}) {
  for (const name of WORKFLOW_FILES) {
    const text = renderWorkflow(await readFile(resolve("templates", name), "utf8"),
      { projectDir: ".", installDir: ".", manager: "npm", secretNames: [], ...options });
    await write(root, { [`.github/workflows/${name}`]: text });
  }
}

// Real commands (git, gh, npm) run as they would for a user; ffmpeg is stubbed present so the launch-decoder
// check does not depend on the machine running the tests.
const withFfmpeg = (command, args, cwd) => command === "ffmpeg"
  ? { status: 0, stdout: "ffmpeg version 6.1", stderr: "" }
  : spawnSync(command, args, { cwd, encoding: "utf8", env: process.env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
const offline = project => ({ project, online: false, github: false, run: withFfmpeg });
const check = (report, id) => report.checks.filter(item => item.id === id);
const codes = report => report.checks.filter(item => item.status === "fail").map(item => item.code);

test("route entry reports parameter gaps, layout guards, and config names that match nothing", async (t) => {
  const root = await app(t);
  const report = readRouteEntry(root, { ...baseConfig, setup: [{ action: "open", url: "example-app://welcome" }, { action: "wait", milliseconds: 100, requiresRoute: "/missing" }] });
  const byPath = Object.fromEntries(report.routes.map(route => [route.logicalPath, route]));
  assert.equal(byPath["/(member)/items/[id]"].status, "needs-parameters");
  assert.equal(byPath["/(member)/items/[id]"].parameterKey, "/items/[id]");
  assert.deepEqual(byPath["/(member)/items/[id]"].missingParameters, ["id"]);
  assert.deepEqual(byPath["/(member)/home"].guards, [{ to: "/welcome", sourceFile: "src/app/(member)/_layout.tsx" }]);
  assert.deepEqual(byPath["/welcome"].guards, []);
  assert.equal(byPath["/welcome"].openedBySetup, true);
  assert.deepEqual(report.unknownSetupRoutes, ["/missing"]);

  const configured = readRouteEntry(root, { ...baseConfig, parameters: { "/items/[id]": { id: "item-1" }, "/itemz/[id]": { id: "x" } } });
  assert.equal(configured.routes.find(route => route.parameterKey === "/items/[id]").status, "ready");
  assert.deepEqual(configured.unusedParameterKeys, ["/itemz/[id]"]);

  const excluding = readRouteEntry(root, { ...baseConfig, exploration: { scope: "changes", exclude: ["/welcome", "/gone"] } });
  assert.equal(excluding.routes.find(route => route.logicalPath === "/welcome").excluded, true);
  assert.equal(excluding.routes.find(route => route.logicalPath === "/(member)/home").excluded, false);
  assert.deepEqual(excluding.unknownExcludedRoutes, ["/gone"]);

  const withoutScheme = readRouteEntry(root, { ...baseConfig, app: { ...baseConfig.app, scheme: undefined } });
  assert.ok(withoutScheme.routes.filter(route => route.status !== "redirect").every(route => route.status !== "ready"));
});

test("doctor names every blocker of a fresh deterministic setup with its next action", async (t) => {
  const root = await app(t);
  const report = await runDoctor(offline(root));
  assert.equal(report.ok, false);
  assert.equal(report.mode, "deterministic");
  assert.deepEqual(new Set(codes(report)), new Set(["CAPTURE_PARAMETERS_MISSING", "APP_DEPENDENCIES_MISSING", "WORKFLOW_MISSING"]));
  const parameters = check(report, "route-parameters")[0];
  assert.match(parameters.nextAction, /\/items\/\[id\]:\n\s+id: <value>/);
  assert.match(parameters.nextAction, /never invent/);
  assert.equal(check(report, "route-guards")[0].code, "ROUTE_GUARD_UNPREPARED");
  const text = formatDoctorReport(report);
  assert.match(text, /5\. Screen entry/);
  assert.match(text, /✗ .*\[CAPTURE_PARAMETERS_MISSING\]/);
  assert.match(text, /→ Add a real value/);
});

test("doctor passes a complete deterministic setup without network checks", async (t) => {
  const config = { ...baseConfig, parameters: { "/items/[id]": { id: "item-1" } },
    setup: [{ action: "open", url: "example-app://welcome", ready: { identifier: "welcome-continue" } }] };
  const root = await app(t, config);
  await writeCaptureObserverPackages(root);
  await workflows(root);
  const uncommitted = await runDoctor(offline(root));
  assert.deepEqual(codes(uncommitted), ["SETUP_FILES_UNCOMMITTED"]);
  assert.match(check(uncommitted, "committed")[0].message, /explore-review\.yml/);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "Set up Explore");
  const report = await runDoctor(offline(root));
  assert.deepEqual(codes(report), []);
  assert.equal(report.ok, true);
  const guards = check(report, "route-guards")[0];
  assert.equal(guards.status, "pass");
  assert.match(guards.message, /doctor --capture shows it/);
  assert.equal(guards.nextAction, undefined);
  assert.equal(check(report, "scheme")[0].status, "pass");
  assert.deepEqual(report.checks.filter(item => item.status === "skip").map(item => item.step), [1, 7]);
  assert.match(formatDoctorReport(report), /No problems in the checks that ran; 2 checks were skipped/);
  assert.doesNotMatch(formatDoctorReport(report), /Ready for Explore CI/);
});

test("doctor reports a missing app link scheme and unsupported installed versions", async (t) => {
  const { scheme: _scheme, ...app_ } = baseConfig.app;
  const root = await app(t, { ...baseConfig, app: app_ });
  await writeCaptureObserverPackages(root, { expoVersion: "56.0.0" });
  const report = await runDoctor(offline(root));
  assert.ok(codes(report).includes("APP_SCHEME_MISSING"));
  assert.ok(codes(report).includes("CAPTURE_LINK_UNSUPPORTED"));
  assert.match(check(report, "compatibility")[0].message, /Expo SDK 57/);
  assert.equal(check(report, "compatibility")[0].code, "CAPTURE_OBSERVER_UNSUPPORTED");
});

test("doctor explains a missing config and a directory that is not an Expo app", async (t) => {
  const root = await app(t);
  await rm(join(root, ".expo-explore"), { recursive: true });
  const missing = await runDoctor(offline(root));
  assert.deepEqual(codes(missing), ["CONFIG_MISSING"]);
  assert.match(check(missing, "config")[0].nextAction, /expo-explore setup/);
  // The route analysis still runs from the app config, so the capture mode can be chosen from it.
  assert.match(check(missing, "routes")[0].message, /4 screens; 3 open by app link, 1 need parameter values, 0 have no app link, 2 sit behind source redirects/);
  assert.ok(missing.routes.routes.length);
  await writeFile(join(root, "package.json"), "{}");
  assert.deepEqual(codes(await runDoctor(offline(root))), ["APP_NOT_EXPO"]);
});

function easRun({ signedIn = true, available = true, variables = "" } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command.split("/").at(-1), ...args]);
    if (!command.endsWith("/eas")) return { status: 0, stdout: "", stderr: "" };
    switch (args[0]) {
      case "whoami": return signedIn ? { status: 0, stdout: "example-user\n", stderr: "" } : { status: 1, stdout: "", stderr: "Not logged in" };
      case "project:info": return { status: 0, stdout: "fullName  @example/app\n", stderr: "" };
      case "simulator:availability": return { status: 0, stdout: JSON.stringify({ available }), stderr: "" };
      case "config": return { status: 0, stderr: "", stdout: JSON.stringify({
        buildProfile: { simulator: true, distribution: "internal" },
        appConfig: { name: "Example", slug: "example", owner: "example", scheme: "example-app", ios: { bundleIdentifier: "com.example.app" }, extra: { eas: { projectId: "00000000-0000-0000-0000-000000000000" } } },
      }) };
      case "env:list": return { status: 0, stderr: "", stdout: args.includes("project") ? variables : "" };
      default: return { status: 1, stdout: "", stderr: "unexpected" };
    }
  };
  return { run, calls };
}

test("online checks stop at the Expo login and otherwise report simulator access and the build environment", async (t) => {
  const root = await app(t);
  const signedOut = easRun({ signedIn: false });
  const report = await runDoctor({ project: root, github: false, run: signedOut.run });
  assert.equal(check(report, "eas-login")[0].code, "EAS_NOT_AUTHENTICATED");
  assert.deepEqual(check(report, "eas-simulator"), []);
  assert.ok(!signedOut.calls.some(call => call[1] === "project:info"));

  const blocked = await runDoctor({ project: root, github: false,
    run: easRun({ available: false, variables: "API_KEY=***** (This is a secret env variable that can only be accessed on EAS builder and can't be read in any UI. Learn more.)\nPUBLIC_URL=https://example.com\n" }).run });
  assert.equal(check(blocked, "eas-simulator")[0].code, "SIMULATOR_UNAVAILABLE");
  assert.match(check(blocked, "eas-simulator")[0].nextAction, /waitlist.*example-user/);
  const environment = check(blocked, "eas-environment")[0];
  assert.equal(environment.code, "CAPTURE_OBSERVER_BUILD_UNSUPPORTED");
  assert.match(environment.message, /preview.*API_KEY/);
  assert.doesNotMatch(JSON.stringify(blocked), /https:\/\/example\.com/);
  assert.equal(check(blocked, "eas-profile")[0].status, "pass");
});

test("GitHub checks name the missing repository settings as commands and skip without the GitHub CLI", async (t) => {
  const config = { ...baseConfig, setup: [{ action: "fill", identifier: "email", text: "{{secret:EXAMPLE_LOGIN}}" }] };
  const root = await app(t, config);
  const run = (command, args) => {
    if (command !== "gh") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "repo") return { status: 0, stderr: "", stdout: JSON.stringify({ nameWithOwner: "example/app", defaultBranchRef: { name: "main" } }) };
    if (args[0] === "api") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "secret") return { status: 0, stderr: "", stdout: JSON.stringify([{ name: "OTHER" }]) };
    return { status: 1, stdout: "", stderr: "" };
  };
  const report = await runDoctor({ project: root, online: false, run });
  assert.equal(check(report, "default-branch")[0].status, "pass");
  assert.deepEqual(check(report, "tools-commit"), []);
  const secrets = check(report, "secrets")[0];
  assert.equal(secrets.code, "EXPO_TOKEN_MISSING");
  assert.match(secrets.nextAction, /gh secret set EXPO_TOKEN -R example\/app/);
  assert.match(secrets.nextAction, /gh secret set EXAMPLE_LOGIN -R example\/app/);
  assert.ok(check(report, "workflow-explore-review.yml").some(item => item.code === "WORKFLOW_MISSING"));

  const unavailable = await runDoctor({ project: root, online: false, run: () => ({ status: null, stdout: "", stderr: "spawn gh ENOENT" }) });
  const github = check(unavailable, "github")[0];
  assert.equal(github.status, "skip");
  assert.match(github.nextAction, /secrets EXPO_TOKEN, EXAMPLE_LOGIN/);
  assert.doesNotMatch(github.nextAction, /EXPLORE_TOOLS_COMMIT/);
});

test("agent mode checks committed instructions, the draft, the provider key, and the model", async (t) => {
  const config = { ...baseConfig, mode: "agent", agent: { provider: "anthropic", model: "example-model", instructions: ".expo-explore/instructions.md" } };
  const root = await app(t, config, { ".expo-explore/instructions.md": `${DRAFT_INSTRUCTIONS_MARKER}\nSign in with {{secret:EXAMPLE_LOGIN}}.\n` });
  await writeCaptureObserverPackages(root);
  await workflows(root);
  const report = await runDoctor(offline(root));
  assert.equal(check(report, "instructions-draft")[0].code, "AGENT_INSTRUCTIONS_DRAFT");
  assert.equal(check(report, "model")[0].status, "skip");
  assert.match(check(report, "model")[0].nextAction, /ANTHROPIC_API_KEY.*--check-model/);
  assert.equal(check(report, "route-parameters")[0].status, "warn");
  assert.ok(codes(report).includes("EXPLORATION_SECRET_MISSING"));
  assert.match(check(report, "mode")[0].message, /billed/);

  await rm(join(root, ".expo-explore/instructions.md"));
  git(root, "rm", "-q", "--cached", ".expo-explore/instructions.md");
  await writeFile(join(root, ".expo-explore/instructions.md"), "Reach screens from the tab bar.\n");
  const untracked = await runDoctor(offline(root));
  assert.equal(check(untracked, "instructions")[0].code, "AGENT_INSTRUCTIONS_UNCOMMITTED");

  const noKey = await runDoctor({ ...offline(root), checkModel: true, environment: {} });
  assert.equal(check(noKey, "model")[0].code, "AGENT_API_KEY_MISSING");
  const accepted = await runDoctor({ ...offline(root), checkModel: true, environment: { ANTHROPIC_API_KEY: "test-key" },
    createSession: () => ({ preflight: async () => {} }) });
  assert.equal(check(accepted, "model")[0].status, "pass");
  const rejected = await runDoctor({ ...offline(root), checkModel: true, environment: { ANTHROPIC_API_KEY: "test-key" },
    createSession: () => ({ preflight: async () => { throw new CiError({ code: "AGENT_MODEL_NOT_FOUND", stage: "preflight", message: "Unknown model.", nextAction: "Use a model your account can access." }); } }) });
  assert.equal(check(rejected, "model")[0].code, "AGENT_MODEL_NOT_FOUND");
});

test("workflows render for the app's package manager, monorepo layout, and app-test secrets", async () => {
  const template = await readFile(resolve("templates/explore-review.yml"), "utf8");
  const rendered = renderWorkflow(template, { projectDir: "apps/mobile", installDir: ".", manager: "pnpm", secretNames: ["EXAMPLE_LOGIN"] });
  assert.match(rendered, /APP_PROJECT_DIR: apps\/mobile/);
  assert.match(rendered, /APP_INSTALL_DIR: \./);
  assert.match(rendered, /pnpm install --frozen-lockfile --ignore-scripts --dir "app-base\/\$APP_INSTALL_DIR"/);
  assert.doesNotMatch(rendered, /npm ci --ignore-scripts --prefix/);
  assert.match(rendered, /App-test secrets.*\n\s+EXAMPLE_LOGIN: \$\{\{ secrets\.EXAMPLE_LOGIN \}\}/);
  assert.deepEqual(workflowIssues("review", rendered, { projectDir: "apps/mobile", installDir: ".", manager: "pnpm", secretNames: ["EXAMPLE_LOGIN"] }), []);
  const issues = workflowIssues("review", template, { projectDir: "apps/mobile", installDir: ".", manager: "pnpm", secretNames: ["EXAMPLE_LOGIN"] }).map(issue => issue.code);
  assert.deepEqual(issues, ["EXPLORE_VERSION_INVALID", "WORKFLOW_APP_DIR_MISMATCH", "WORKFLOW_INSTALL_MISMATCH", "EXPLORATION_SECRET_MISSING"]);
});

test("bun workflows set up bun before the frozen-lockfile install", async () => {
  for (const name of WORKFLOW_FILES) {
    const template = await readFile(resolve("templates", name), "utf8");
    const layout = { projectDir: ".", installDir: ".", manager: "bun", secretNames: [] };
    const rendered = renderWorkflow(template, layout);
    assert.doesNotMatch(rendered, /npm ci --ignore-scripts --prefix/);
    assert.match(rendered, /\(cd "app[^"]*\/\$APP_INSTALL_DIR" && bun install --frozen-lockfile --ignore-scripts\)/);
    assert.match(rendered, /\n(\s+)- uses: oven-sh\/setup-bun@[0-9a-f]{40} # v\S+\n\1- name: Install app dependencies\n/);
    assert.deepEqual(workflowIssues(name, rendered, layout), []);
    const withoutSetup = rendered.replace(/^\s+- uses: oven-sh\/setup-bun@.*\n/m, "");
    assert.deepEqual(workflowIssues(name, withoutSetup, layout).map(issue => issue.code), ["WORKFLOW_INSTALL_MISMATCH"]);
  }
});

test("CI install keeps an existing workflow, adding only missing secret lines", async (t) => {
  const root = await app(t);
  await workflows(root);
  const result = await installCiFiles(root, ["EXAMPLE_LOGIN"]);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.written, WORKFLOW_FILES.map(name => `.github/workflows/${name} (secret lines)`));
  for (const name of WORKFLOW_FILES) {
    const text = await readFile(join(root, ".github/workflows", name), "utf8");
    assert.equal(text.match(/EXAMPLE_LOGIN: \$\{\{ secrets\.EXAMPLE_LOGIN \}\}/g).length, 1);
  }
  assert.deepEqual((await installCiFiles(root, ["EXAMPLE_LOGIN"])).written, []);
});

test("setup regenerates an unedited generated workflow when the template changed, and keeps an edited one", async (t) => {
  const root = await app(t);
  await workflows(root);
  const path = join(root, ".github/workflows/explore-review.yml");
  const generated = await readFile(path, "utf8");
  assert.ok(workflowUnmodified(generated));
  assert.deepEqual((await installCiFiles(root, [])).written, [], "an up-to-date generated workflow is kept");

  // A workflow generated by an older release: stamped, but its body differs from the current template.
  await writeFile(path, stampWorkflow("name: old\nenv:\n  EXPLORE_VERSION: 0.0.1\n"));
  const refreshed = await installCiFiles(root, []);
  assert.match(refreshed.written.join("\n"), /explore-review\.yml \(.*regenerated from the @expo\/explore .* template\)/);
  assert.equal(await readFile(path, "utf8"), generated);

  // An edited workflow keeps its edits and is only re-pinned; setup says how to replace it.
  await writeFile(path, generated.replace("EXPLORE_VERSION: ", "EXPLORE_VERSION: 0.0.1 #").replace(/\n$/, "\n# app edit\n"));
  const edited = await readFile(path, "utf8");
  assert.ok(!workflowUnmodified(edited));
  const kept = await installCiFiles(root, []);
  assert.match(kept.written.join("\n"), /explore-review\.yml \(@expo\/explore /);
  assert.match(kept.notes.join("\n"), /was edited after setup generated it.*--force/);
  assert.match(await readFile(path, "utf8"), /# app edit\n$/);

  // A workflow from before fingerprints is kept too, until --force replaces it.
  await writeFile(path, "name: legacy\nenv:\n  EXPLORE_VERSION: 0.0.1\n");
  const legacy = await installCiFiles(root, []);
  assert.match(legacy.notes.join("\n"), /predates generated-workflow fingerprints.*--force/);
  assert.match(await readFile(path, "utf8"), /^name: legacy/m);
  const forced = await installCiFiles(root, [], { force: true });
  assert.match(forced.written.join("\n"), /explore-review\.yml \(.*regenerated/);
  assert.equal(await readFile(path, "utf8"), generated);
});

test("workflows pin this CLI's version, and setup moves an existing workflow to it", async (t) => {
  const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const template = await readFile(resolve("templates/explore-review.yml"), "utf8");
  const layout = { projectDir: ".", installDir: ".", manager: "npm", secretNames: [] };
  assert.equal(workflowVersion(template), "set-by-expo-explore-setup");
  assert.deepEqual(workflowIssues("review", template, layout).map(issue => issue.code), ["EXPLORE_VERSION_INVALID"]);
  assert.equal(workflowVersion(renderWorkflow(template, layout)), version);

  const root = await app(t);
  await workflows(root);
  const path = join(root, ".github/workflows/explore-review.yml");
  await writeFile(path, (await readFile(path, "utf8")).replace(`EXPLORE_VERSION: ${version}`, "EXPLORE_VERSION: 0.0.1"));
  const older = await runDoctor(offline(root));
  assert.equal(check(older, "workflow-version-explore-review.yml")[0].code, "EXPLORE_VERSION_DIFFERENT");
  const result = await installCiFiles(root, []);
  assert.deepEqual(result.written, [`.github/workflows/explore-review.yml (@expo/explore ${version})`]);
  assert.equal(workflowVersion(await readFile(path, "utf8")), version);
});

test("doctor checks that npm has the pinned version, and flags a vendored workflow as outdated", async (t) => {
  const root = await app(t);
  await workflows(root);
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return command === "npm" ? { status: 1, stdout: "", stderr: "E404" } : { status: 0, stdout: "", stderr: "" };
  };
  const report = await runDoctor({ project: root, github: false, run });
  assert.equal(check(report, "explore-version")[0].code, "EXPLORE_VERSION_UNPUBLISHED");
  assert.equal(calls.filter(call => call[0] === "npm").length, 1, "both workflows pin one version");

  await write(root, { ".github/workflows/explore-baseline.yml": "env:\n  TOOLS_COMMIT: ${{ vars.EXPLORE_TOOLS_COMMIT }}\n",
    ".github/vendor/expo-explore/UPSTREAM.json": "{}\n" });
  const legacy = await runDoctor(offline(root));
  assert.equal(check(legacy, "workflow-explore-baseline.yml")[0].code, "WORKFLOW_OUTDATED");
  assert.equal(check(legacy, "tools-snapshot")[0].code, "TOOLS_SNAPSHOT_UNUSED");
  const kept = await installCiFiles(root, []);
  assert.ok(kept.kept.includes(".github/workflows/explore-baseline.yml"));
  assert.match(kept.notes.join("\n"), /vendored copy/);
});

test("EAS variables that repacking cannot reproduce are recognized by name only", () => {
  assert.deepEqual(unreproducibleEasVariables([
    "PLAIN=value",
    "SENSITIVE=***** (This is a sensitive env variable. To access it, run command with --include-sensitive flag. Learn more.)",
    "TOKEN=***** (This is a secret env variable that can only be accessed on EAS builder and can't be read in any UI. Learn more.)",
    "CERT=***** (This is a file env variable. To access it, run command with --include-file-content flag. Learn more.)",
  ].join("\n")), ["CERT", "TOKEN"]);
});

test("capture check reports each route with the reason it was not captured", () => {
  const surface = (id, logicalPath) => ({ id, status: "unchanged", baseSurface: null, headSurface: { id, logicalPath, route: logicalPath }, reasons: [], baseCapture: false, headCapture: true });
  const plan = { surfaces: [surface("home", "/(member)/home"), surface("item", "/(member)/items/[id]"), surface("welcome", "/welcome"), surface("later", "/later")],
    headCaptureSurfaceIds: ["home", "item", "welcome", "later"] };
  const bundle = {
    images: { welcome: { path: "screens/welcome.png" }, home: { path: "screens/home.png" } },
    outcomes: {
      welcome: { status: "captured", landing: "verified", attempts: 1 },
      home: { status: "captured", landing: "unverified", attempts: 2 },
      item: { status: "missing-params", landing: "unverified", attempts: 0 },
    },
  };
  const routes = summarizeCaptureCheck(plan, bundle, "/out/baseline-export");
  assert.deepEqual(routes.map(route => [route.route, route.status, route.code]), [
    ["/(member)/home", "problem", "CAPTURE_LANDING_UNVERIFIED"],
    ["/(member)/items/[id]", "problem", "CAPTURE_PARAMETERS_MISSING"],
    ["/welcome", "captured", undefined],
    ["/later", "not-run", undefined],
  ]);
  assert.equal(routes[2].screenshot, "/out/baseline-export/screens/welcome.png");
  assert.match(routes[0].nextAction, /redirected.*setup actions/);
  const text = formatCaptureCheck({ ok: false, commit: "c".repeat(40), output: "/out", routes,
    failure: { code: "SETUP_FAILED", message: "Setup step 3 did not become ready.", nextAction: "Check the identifier." } });
  assert.match(text, /1 of 4 routes captured/);
  assert.match(text, /✗ Setup step 3 did not become ready\. \[SETUP_FAILED\]/);
  assert.match(text, /Screenshots and diagnostics: \/out/);
});

test("capture check refuses uncommitted changes, because CI captures committed source", async (t) => {
  const root = await app(t);
  await writeFile(join(root, "src/app/welcome.tsx"), "export default function Welcome() { return null; }\n");
  await assert.rejects(runCaptureCheck({ project: root, output: join(tmpdir(), "unused") }), { code: "CAPTURE_CHECK_UNCOMMITTED" });
});

test("search parameters a screen reads are found from its hook call, including names hidden in a type", () => {
  assert.deepEqual(readSearchParameters("const { hold } = useLocalSearchParams<{ hold?: string }>();"), { names: ["hold"], opaque: false });
  assert.deepEqual(readSearchParameters("const { amount, ...params } = useLocalSearchParams<RecipientParams & { amount?: string }>();"), { names: ["amount"], opaque: true });
  assert.deepEqual(readSearchParameters("const params = useLocalSearchParams<RecipientParams>();"), { names: [], opaque: true });
  assert.deepEqual(readSearchParameters("const { tab = 'all' } = useGlobalSearchParams();"), { names: ["tab"], opaque: false });
  assert.deepEqual(readSearchParameters("const id = route.params.id; const mode = route.params?.mode;"), { names: ["id", "mode"], opaque: false });
  assert.equal(readSearchParameters("export default function Home() { return null; }"), undefined);
});

test("doctor warns about search parameters that config leaves unset, and not about path or configured ones", async (t) => {
  const root = await app(t, { ...baseConfig, parameters: { "/items/[id]": { id: "item-1", view: "full" } } }, {
    "src/app/(member)/items/[id].tsx": "import { useLocalSearchParams } from 'expo-router';\nexport default function Item() { const { id, view } = useLocalSearchParams<{ id: string; view?: string }>(); return null; }\n",
    "src/app/welcome.tsx": "import { useLocalSearchParams } from 'expo-router';\nexport default function Welcome() { const { invite } = useLocalSearchParams<{ invite?: string }>(); return null; }\n",
  });
  const report = await runDoctor(offline(root));
  const search = check(report, "search-parameters")[0];
  assert.equal(search.code, "ROUTE_SEARCH_PARAMETERS_UNSET");
  assert.deepEqual(search.details.routes, [{ key: "/welcome", unset: ["invite"], opaque: false }]);
  assert.match(search.nextAction, /\/welcome:\n\s+invite: <value>/);
});

test("capture check keeps its output in the system temporary directory, outside the app", async (t) => {
  const root = await app(t);
  await assert.rejects(runCaptureCheck({ project: root, output: join(root, "capture") }), { code: "CAPTURE_CHECK_OUTPUT_INVALID" });
  git(root, "clean", "-fdq");
  await assert.rejects(runCaptureCheck({ project: root, output: resolve("test-results/capture-check") }), { code: "CAPTURE_CHECK_OUTPUT_INVALID" });
});

test("the CLI shows why a capture check did not start, with its next action", async (t) => {
  const root = await app(t, { ...baseConfig, parameters: { "/items/[id]": { id: "item-1" } } });
  await writeCaptureObserverPackages(root);
  await writeFile(join(root, "notes.txt"), "unrelated\n");
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "doctor", "--capture", "--yes", "--offline", "--project", root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Capture check not started: .*notes\.txt.* \[CAPTURE_CHECK_UNCOMMITTED\]/);
  assert.match(result.stdout, /→ .*git worktree add --detach/);
});

test("a missing compare workflow is a warning: pull request reviews do not need it", async (t) => {
  const root = await app(t);
  await workflows(root);
  await rm(join(root, ".github/workflows/explore-compare.yml"));
  const report = await runDoctor(offline(root));
  assert.deepEqual(check(report, "workflow-explore-compare.yml").map(item => [item.status, item.code]), [["warn", "WORKFLOW_MISSING"]]);
  assert.equal(check(report, "workflow-explore-review.yml")[0].status, "pass");
});

test("workflows count as on the default branch only when its copy matches this checkout", async (t) => {
  const root = await app(t);
  await workflows(root);
  const local = name => readFile(join(root, ".github/workflows", name), "utf8");
  const github = published => (command, args) => {
    if (command !== "gh") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "repo") return { status: 0, stderr: "", stdout: JSON.stringify({ nameWithOwner: "example/app", defaultBranchRef: { name: "main" } }) };
    if (args[0] === "api" && args[1].includes(".github/workflows/")) {
      const text = published[args[1].split("/").at(-1).split("?")[0]];
      return text === undefined ? { status: 1, stdout: "", stderr: "Not Found" } : { status: 0, stderr: "", stdout: `${Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\\n")}\n` };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  const same = Object.fromEntries(await Promise.all(WORKFLOW_FILES.map(async name => [name, await local(name)])));
  assert.equal(check(await runDoctor({ project: root, online: false, run: github(same) }), "default-branch")[0].status, "pass");
  const older = await runDoctor({ project: root, online: false, run: github({ ...same, "explore-review.yml": "name: an older review workflow\n" }) });
  assert.equal(check(older, "default-branch")[0].code, "WORKFLOW_NOT_ON_DEFAULT_BRANCH");
  assert.match(check(older, "default-branch")[0].message, /explore-review\.yml \(different\)/);
  const missing = await runDoctor({ project: root, online: false, run: github({ "explore-review.yml": same["explore-review.yml"] }) });
  assert.match(check(missing, "default-branch")[0].message, /explore-baseline\.yml \(missing\)/);
});

test("doctor checks each configured platform's EAS profile and warns when the workflows capture one platform", async (t) => {
  const multi = { ...baseConfig, platforms: { ios: {}, android: { bundleId: "com.example.app", easProfile: "explore-android" } } };
  const root = await app(t, multi);
  await workflows(root);
  const missing = await runDoctor(offline(root));
  assert.equal(check(missing, "eas-json").at(-1).code, "EAS_PROFILE_NOT_APK");
  assert.match(check(missing, "eas-json").at(-1).nextAction, /build\.explore-android\.android\.buildType: apk/);
  assert.deepEqual(check(missing, "workflow-platforms-explore-review.yml"), [], "the current templates capture per platform");

  await write(root, { "eas.json": JSON.stringify({ build: { explore: { ios: { simulator: true } }, "explore-android": { extends: "base" }, base: { android: { buildType: "apk" } } } }) });
  const ready = await runDoctor(offline(root));
  assert.deepEqual(check(ready, "eas-json").map(item => [item.status, item.message]),
    [["pass", "eas.json profile explore builds for the iOS Simulator."], ["pass", "eas.json profile explore-android builds an Android APK."]]);

  const eas = easRun();
  const online = await runDoctor({ project: root, github: false, run: eas.run });
  assert.deepEqual(eas.calls.filter(call => call[1] === "config").map(call => call.slice(2, 6)),
    [["--platform", "ios", "--profile", "explore"], ["--platform", "android", "--profile", "explore-android"]]);
  assert.equal(check(online, "eas-profile").length, 2);
  assert.equal(eas.calls.filter(call => call[1] === "env:list").length, 2, "one environment shared by both profiles is listed once per scope");

  for (const name of ["explore-review.yml", "explore-baseline.yml"]) {
    const path = join(root, ".github/workflows", name);
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("matrix.target", "github.ref_name"));
  }
  const single = await runDoctor(offline(root));
  assert.deepEqual(check(single, "workflow-platforms-explore-review.yml").map(item => item.code), ["WORKFLOW_PLATFORM_MATRIX_MISSING"]);
  assert.deepEqual(check(single, "workflow-platforms-explore-baseline.yml").map(item => item.status), ["warn"]);
  const one = await app(t); await workflows(one); assert.deepEqual((await runDoctor(offline(one))).checks.filter(item => item.id.startsWith("workflow-platforms")), []);
  // A workflow installed before targets runs one job per platform: enough for platforms, not for targets.
  for (const name of ["explore-review.yml", "explore-baseline.yml"]) {
    const path = join(root, ".github/workflows", name);
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("github.ref_name", "matrix.platform"));
  }
  assert.deepEqual(check(await runDoctor(offline(root)), "workflow-platforms-explore-review.yml"), []);
  await write(root, { ".expo-explore/config.yaml": JSON.stringify({ ...baseConfig, targets: { phone: { platform: "ios" }, duo: { platform: "ios", device: "iPhone Duo", pose: "open" } } }) });
  assert.deepEqual(check(await runDoctor(offline(root)), "workflow-platforms-explore-review.yml").map(item => item.code), ["WORKFLOW_PLATFORM_MATRIX_MISSING"]);
});

test("doctor warns when ffmpeg is missing and the launch is observed", async t => {
  const root = await app(t);
  const withoutFfmpeg = command => command === "ffmpeg" ? { status: null, stdout: "", stderr: "spawn ffmpeg ENOENT" } : { status: 0, stdout: "", stderr: "" };
  const report = await runDoctor({ project: root, online: false, github: false, run: withoutFfmpeg });
  const check = report.checks.find(entry => entry.id === "launch-decoder");
  assert.equal(check?.status, "warn");
  assert.equal(check?.code, "LAUNCH_DECODER_MISSING");
  assert.match(check.nextAction, /Install ffmpeg/);
  const withFfmpeg = await runDoctor({ project: root, online: false, github: false, run: () => ({ status: 0, stdout: "ffmpeg version 6.1", stderr: "" }) });
  assert.equal(withFfmpeg.checks.find(entry => entry.id === "launch-decoder")?.status, "pass");
  const off = await runDoctor({ project: await app(t, { ...baseConfig, capture: { ...baseConfig.capture, launch: "off" } }), online: false, github: false, run: withoutFfmpeg });
  assert.equal(off.checks.find(entry => entry.id === "launch-decoder"), undefined);
});

test("doctor warns when an installed workflow drifts from this version's template", async (t) => {
  const root = await app(t);
  await workflows(root);
  const path = join(root, ".github/workflows/explore-review.yml");
  const generated = await readFile(path, "utf8");
  assert.equal(workflowTemplateDrift(generated, generated), undefined);
  assert.deepEqual(check(await runDoctor(offline(root)), "workflow-template-explore-review.yml"), []);

  // A version bumped by hand (how euxy upgraded) is not drift on its own.
  await writeFile(path, generated.replace(/EXPLORE_VERSION: .*/, "EXPLORE_VERSION: 0.0.1"));
  assert.deepEqual(check(await runDoctor(offline(root)), "workflow-template-explore-review.yml"), []);

  // An older template that lacks a step today's template has: generated by setup, untouched since.
  const withoutFfmpeg = stampWorkflow(generated.replace(/\n\s+- name: Install the launch recording decoder\n(?:\s+(?!- ).*\n)+/, "\n"));
  assert.notEqual(withoutFfmpeg, generated);
  assert.ok(workflowUnmodified(withoutFfmpeg));
  await writeFile(path, withoutFfmpeg);
  const stale = check(await runDoctor(offline(root)), "workflow-template-explore-review.yml");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].status, "warn");
  assert.equal(stale[0].code, "WORKFLOW_TEMPLATE_DRIFT");
  assert.match(stale[0].message, /older @expo\/explore template/);
  assert.match(stale[0].nextAction, /^Run expo-explore setup --workflows, then commit/);

  // Edited by the app: the warning says so and points at --force.
  await writeFile(path, `${generated}# app edit\n`);
  const edited = check(await runDoctor(offline(root)), "workflow-template-explore-review.yml");
  assert.equal(edited[0]?.code, "WORKFLOW_TEMPLATE_DRIFT");
  assert.match(edited[0].message, /edited after setup/);
  assert.match(edited[0].nextAction, /--force/);
});

test("with a local simulator, doctor checks that this Mac can create the device instead of EAS Simulator access", async (t) => {
  const root = await app(t);
  const eas = easRun({ available: false });
  const simctl = (devicetypes, runtimes) => (command, args, cwd) => {
    if (command !== "xcrun") return eas.run(command, args, cwd);
    const json = args[2] === "devicetypes" ? devicetypes : runtimes;
    return { status: 0, stderr: "", stdout: JSON.stringify(json) };
  };
  const types = { devicetypes: [{ name: "iPhone 17", identifier: "type.iPhone-17" }, { name: "iPhone 17 Pro", identifier: "type.iPhone-17-Pro" }] };
  const runtimes = { runtimes: [{ identifier: "runtime.iOS-27-0", version: "27.0", platform: "iOS", isAvailable: true,
    supportedDeviceTypes: [{ identifier: "type.iPhone-17" }, { identifier: "type.iPhone-17-Pro" }] }] };
  const ready = await runDoctor({ project: root, github: false, simulator: "local", run: simctl(types, runtimes) });
  assert.deepEqual(check(ready, "eas-simulator"), [], "EAS Simulator access is not needed");
  assert.equal(check(ready, "local-simulator")[0].status, "pass");
  assert.match(check(ready, "local-simulator")[0].message, /iOS 27\.0/);
  const missing = await runDoctor({ project: root, github: false, simulator: "local", run: simctl({ devicetypes: [] }, runtimes) });
  assert.equal(check(missing, "local-simulator")[0].code, "LOCAL_SIMULATOR_DEVICE_UNAVAILABLE");
});
