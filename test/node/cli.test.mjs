import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { addCoverageGap, addScreen, createMapStore } from "../helpers/map-store-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");
const fixtures = join(import.meta.dirname, "../fixtures");
const { parseControllerOutput } = await import(join(root, "dist", "capture", "controller-output.js"));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function raw(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], {
    cwd,
    encoding: "utf8",
  });
}

function run(cwd, args) {
  const result = raw(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runFailure(cwd, args) {
  const result = raw(cwd, args);
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr || result.stdout);
}

async function writeFixture(cwd, name, contents) {
  const path = join(cwd, name);
  await writeFile(path, contents);
  return path;
}

// Capture parses controller output with the same parser (src/capture/run.ts).
function parseFile(cwd, controller, path) {
  return parseControllerOutput(controller, readFileSync(resolve(cwd, path), "utf8"));
}

test("map query commands read a captured map without writing to it", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-query-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = await createMapStore(cwd, "Query fixture");
  const screenshotPath = await writeFixture(cwd, "screen.png", png);
  await addScreen(store, { id: "home", title: "Home", start: true, screenshotPath,
    snapshotPath: join(fixtures, "agent-device-snapshot.txt") });
  await addScreen(store, { id: "details", title: "Details", screenshotPath });
  const captured = await store.read();
  const [home, details] = captured.screens;
  const timestamp = captured.run.updatedAt;
  captured.actionAttempts.push({ id: "open-details", sourceScreenId: home.id,
    sourceObservationId: home.observationIds[0], targetScreenId: details.id,
    targetObservationId: details.observationIds[0], action: { kind: "press", label: "Open details" },
    outcome: "transition", risk: "safe", startedAt: timestamp, completedAt: timestamp });
  captured.transitions.push({ id: "home-details", fromScreenId: home.id, toScreenId: details.id,
    actionKind: "press", firstObservedAt: timestamp, lastObservedAt: timestamp, attemptIds: ["open-details"] });
  captured.journeys.push({ id: "browse", title: "Browse details", screenIds: [home.id, details.id],
    transitionIds: ["home-details"], attemptIds: ["open-details"] });
  await store.write(captured);
  const exampleMap = store.root;
  const map = JSON.parse(await readFile(join(exampleMap, "screen-map.json"), "utf8"));
  const before = (await readdir(exampleMap)).sort();
  const query = (args) => {
    const result = run(root, [...args, "--dir", exampleMap]);
    assert.equal(result.contract, "expo.explore.query.v1");
    assert.equal(result.ok, true, args.join(" "));
    return result;
  };
  const start = map.screens.find((screen) => screen.start);
  const transition = map.transitions.find((entry) => entry.fromScreenId === start.id);
  const observation = map.observations.find((entry) => entry.screenId === start.id);
  const attempt = map.actionAttempts[0];

  assert.equal(query(["summary"]).coverage.screens, map.screens.length);
  assert.equal(query(["status"]).revision, map.revision);
  assert.deepEqual(query(["validate"]).errors, []);
  const screens = query(["screen:list", "--limit", "2"]);
  assert.equal(screens.total, map.screens.length);
  assert.equal(screens.items.length, 2);
  assert.equal(query(["screen:get", "--id", start.id]).screen.id, start.id);
  assert.ok(query(["element:list", "--screen", start.id]).total > 0);
  assert.ok(query(["observation:list", "--screen", start.id]).items.some((entry) => entry.id === observation.id));
  assert.equal(query(["observation:get", "--id", observation.id]).observation.screenId, start.id);
  assert.equal(query(["attempt:list"]).total, map.actionAttempts.length);
  assert.equal(query(["attempt:get", "--id", attempt.id]).attempt.id, attempt.id);
  assert.ok(query(["transition:list", "--screen", start.id]).items.some((entry) => entry.id === transition.id));
  assert.equal(query(["transition:get", "--id", transition.id]).transition.toScreenId, transition.toScreenId);
  assert.ok(query(["neighbors", "--screen", start.id]).outgoing.length > 0);
  assert.equal(query(["path", "--from", start.id, "--to", transition.toScreenId]).found, true);
  assert.equal(query(["journey:list"]).total, map.journeys.length);
  assert.equal(query(["journey:get", "--id", "browse"]).journey.id, "browse");
  assert.equal(query(["frontier:list"]).total, map.frontier.length);
  assert.equal(typeof query(["frontier:next"]).done, "boolean");
  assert.equal(query(["gap:list"]).total, map.gaps.length);
  assert.ok(query(["search", "--query", start.title]).total > 0);
  assert.match(runFailure(root, ["journey:get", "--id", "missing", "--dir", exampleMap]).error, /journey/i);

  const exported = join(await mkdtemp(join(tmpdir(), "expo-explore-query-export-")), "map");
  query(["export", "--output", exported]);
  assert.equal(JSON.parse(await readFile(join(exported, "screen-map.json"), "utf8")).revision, map.revision);

  assert.deepEqual((await readdir(exampleMap)).sort(), before);
  assert.equal(JSON.parse(await readFile(join(exampleMap, "screen-map.json"), "utf8")).revision, map.revision);
});

test("version prints the package version", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const command of ["version", "--version", "-v"]) {
    const result = spawnSync(process.execPath, [cli, command], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  }
});

test("removed map-writing commands fail as unknown commands", () => {
  for (const command of ["init", "screen:add", "attempt:commit", "frontier:claim", "gap:add", "finish"]) {
    const result = spawnSync(process.execPath, [cli, command], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`^Unknown command: ${command}\n→ Run expo-explore help`));
    assert.match(runFailure(root, [command]).error, new RegExp(`Unknown command: ${command}`));
  }
});

test("parses representative agent-device text and Argent JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-parsers-"));
  const agent = parseFile(cwd, "agent-device", join(fixtures, "agent-device-snapshot.txt"));
  assert.equal(agent.format, "text");
  assert.equal(agent.warnings.length, 0);
  assert.equal(agent.elements.length, 5);
  const agentContinue = agent.elements.find((element) => element.label === "Continue");
  assert.equal(agentContinue.role, "button");
  assert.deepEqual(agentContinue.bounds, {
    x: 16,
    y: 80,
    width: 358,
    height: 48,
    unit: "points",
  });
  assert.ok(agent.elements.every((element) => !element.id?.startsWith("@e")));
  assert.ok(agent.elements.every((element) => !element.selector?.includes("@e")));

  const argent = parseFile(cwd, "argent", join(fixtures, "argent-describe.json"));
  assert.equal(argent.format, "json");
  const continueButton = argent.elements.find((element) => element.identifier === "continue-button");
  assert.equal(continueButton.role, "button");
  assert.equal(continueButton.selector, "id=continue-button");
  assert.equal(continueButton.bounds.unit, "normalized");
  const email = argent.elements.find((element) => element.label === "Email address");
  assert.deepEqual(email.actions, ["fill"]);

  const tree = parseFile(cwd, "argent", join(fixtures, "argent-tree.json"));
  assert.equal(tree.format, "json");
  assert.equal(tree.elements.length, 4);
  assert.equal(
    tree.elements.find((element) => element.identifier === "continue-button").actionable,
    true,
  );
  assert.equal(
    tree.elements.find((element) => element.label === "Hidden purchase").actionable,
    false,
  );
  assert.equal(tree.elements.find((element) => element.label === "Nested content").role, "text");
});

test("parses current agent-device and Argent controller output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-current-parsers-"));
  const agent = parseFile(cwd, "agent-device", join(fixtures, "agent-device-current.txt"));
  assert.equal(agent.format, "text");
  assert.equal(agent.elements.length, 8);
  assert.match(agent.warnings.join(" "), /Collapsed 2 adjacent duplicate/);
  assert.equal(agent.elements.filter((element) => element.label === "Activity log").length, 1);
  assert.equal(agent.elements.filter((element) => element.label === "Mute").length, 2);
  assert.equal(agent.elements.some((element) => element.label === "button"), false);
  assert.deepEqual(
    agent.elements.find((element) => element.label === "Search").actions,
    ["fill"],
  );
  const tabBar = agent.elements.find((element) => element.label === "Tab Bar");
  assert.equal(tabBar.role, "other");
  assert.equal(tabBar.actionable, false);
  assert.equal(agent.elements.find((element) => element.label === "Patterns").role, "tab");

  const argent = parseFile(cwd, "argent", join(fixtures, "argent-describe-current.json"));
  assert.equal(argent.format, "json");
  assert.equal(argent.elements.length, 6);
  const recordMode = argent.elements.find(
    (element) => element.label === "Switch to record mode",
  );
  assert.equal(recordMode.role, "button");
  assert.deepEqual(recordMode.bounds, {
    x: 0.828,
    y: 0.846,
    width: 0.128,
    height: 0.031,
    unit: "normalized",
  });
  const waveform = argent.elements.find((element) => element.identifier === "waveform");
  assert.equal(waveform.role, "field");
  assert.equal(waveform.selector, "id=waveform");
  assert.equal(argent.elements.find((element) => element.label === "Patterns").role, "tab");
});

test("host AX bridge nodes take their role from the element type, not the native view class", async () => {
  // Node shape from agent-device 0.21.15's host AX bridge (a Settings screen).
  const parsed = parseControllerOutput("agent-device", JSON.stringify({ success: true, data: { nodes: [
    { type: "StaticText", role: "RCTParagraphComponentView", subrole: "UIView", pid: 42, label: "YOUR ACCOUNT", rect: { x: 26, y: 129, width: 90, height: 14 } },
    { type: "Button", role: "RCTViewComponentView", subrole: "UIView", pid: 42, label: "Account", rect: { x: 12, y: 150, width: 378, height: 54 } },
    { type: "Other", role: "RCTViewComponentView", subrole: "UIView", pid: 42, label: "Settings rows", rect: { x: 0, y: 120, width: 402, height: 600 } },
  ] } }));
  const role = (label) => parsed.elements.find((element) => element.label === label)?.role;
  assert.equal(role("YOUR ACCOUNT"), "text");
  assert.equal(role("Account"), "button");
  assert.equal(role("Settings rows"), "other");
  // A known role in an earlier field still wins over the element type.
  const explicit = parseControllerOutput("argent", JSON.stringify([{ role: "link", type: "Button", label: "Terms" }]));
  assert.equal(explicit.elements[0].role, "link");
});

test("drops Android system UI nodes (status bar, keyboard) from snapshots", () => {
  const parsed = parseControllerOutput("agent-device", JSON.stringify({ success: true, data: { nodes: [
    { index: 0, type: "android.widget.FrameLayout", bundleId: "com.android.systemui", label: "Phone signal full.", rect: { x: 600, y: 10, width: 40, height: 30 } },
    { index: 1, type: "android.widget.TextView", bundleId: "com.android.systemui", label: "4:20 PM", rect: { x: 20, y: 10, width: 80, height: 30 } },
    { index: 2, type: "android.widget.TextView", bundleId: "dev.brent.euxy", label: "Activity Log", rect: { x: 100, y: 200, width: 200, height: 40 } },
    { index: 3, type: "android.widget.Button", bundleId: "com.google.android.inputmethod.latin", label: "q", rect: { x: 10, y: 1400, width: 60, height: 60 } },
  ] } }));
  assert.deepEqual(parsed.elements.map((element) => element.label), ["Activity Log"]);
  // iOS nodes carry no package and are untouched.
  const ios = parseControllerOutput("agent-device", JSON.stringify({ success: true, data: { nodes: [
    { type: "StaticText", label: "Phone signal full.", rect: { x: 0, y: 0, width: 40, height: 20 } },
  ] } }));
  assert.equal(ios.elements.length, 1);
});

test("preserves controller actionability and reports lossy parser heuristics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-parser-safety-"));
  await writeFixture(
    cwd,
    "same-parent.txt",
    '@e1 [other] "Pattern row"\n@e2 [button] [same label as parent]\n',
  );
  const inherited = parseFile(cwd, "agent-device", "same-parent.txt");
  const inheritedButton = inherited.elements.find(
    (element) => element.role === "button" && element.label === "Pattern row",
  );
  assert.equal(inheritedButton.actionable, true);

  await writeFixture(
    cwd,
    "visibility.json",
    JSON.stringify({ role: "button", label: "Hidden Buy", visible: false }),
  );
  const hidden = parseFile(cwd, "argent", "visibility.json").elements[0];
  assert.equal(hidden.visible, false);
  assert.equal(hidden.actionable, false);

  await writeFixture(
    cwd,
    "tab-scope.txt",
    '@e1 [tab-bar] "Tab Bar"\n' +
      '@e2 [button] "Home" [selected]\n' +
      '@e3 [other] "Account section"\n' +
      '@e4 [button] "Delete account"\n',
  );
  const scoped = parseFile(cwd, "agent-device", "tab-scope.txt");
  assert.equal(scoped.elements.find((element) => element.label === "Home").role, "tab");
  assert.equal(
    scoped.elements.find((element) => element.label === "Delete account").role,
    "button",
  );

  await writeFixture(
    cwd,
    "boundless-tab-scope.txt",
    '@e1 [tab-bar] "Tab Bar"\n' +
      '@e2 [button] "Home" [selected]\n' +
      '@e3 [button] "Delete account"\n',
  );
  const boundless = parseFile(cwd, "agent-device", "boundless-tab-scope.txt");
  assert.equal(boundless.elements.find((element) => element.label === "Home").role, "tab");
  assert.equal(
    boundless.elements.find((element) => element.label === "Delete account").role,
    "button",
  );
  assert.match(boundless.warnings.join(" "), /tab membership was ambiguous/);

  await writeFixture(
    cwd,
    "duplicates.json",
    JSON.stringify([
      { role: "button", label: "Delete" },
      { role: "button", label: "Delete" },
    ]),
  );
  const duplicates = parseFile(cwd, "argent", "duplicates.json");
  assert.equal(duplicates.elements.length, 1);
  assert.match(duplicates.warnings.join(" "), /Collapsed 1 exact duplicate JSON element/);

  await writeFixture(
    cwd,
    "hidden-scroll.txt",
    '@e1 [scroll-area] "Feed" [scrollable]\n  [content below scroll-area hidden]\n',
  );
  const hiddenScroll = parseFile(cwd, "agent-device", "hidden-scroll.txt");
  assert.match(hiddenScroll.warnings.join(" "), /add a swipe frontier/);
});

test("reclaims an abandoned writer lock immediately", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-lock-"));
  const store = await createMapStore(cwd, "Lock recovery");
  await writeFile(
    store.lockPath,
    `${JSON.stringify({ pid: 999_999_999, token: "abandoned", createdAt: new Date().toISOString() })}\n`,
  );
  const added = await addCoverageGap(store, {
    kind: "connection",
    message: "Recovered after the previous writer exited",
  });
  assert.equal(added.gap.status, "open");
  await assert.rejects(readFile(store.lockPath), { code: "ENOENT" });
});

test("uses revision compare-and-swap and validates artifact integrity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-cas-"));
  await writeFixture(cwd, "root.png", png);
  await writeFixture(cwd, "root.txt", '@e1 [text] "Root"\n');
  const store = await createMapStore(cwd, "CAS");
  await addScreen(store, {
    id: "root",
    title: "Root",
    screenshotPath: join(cwd, "root.png"),
    snapshotPath: join(cwd, "root.txt"),
    start: true,
  });

  const first = await store.read();
  const stale = structuredClone(first);
  first.run.environment.instructions = "first writer";
  await store.write(first);
  stale.run.environment.instructions = "stale writer";
  await assert.rejects(store.write(stale), /changed concurrently/);

  const map = await store.read();
  const screenshot = map.artifacts.find((artifact) => artifact.kind === "screenshot");
  await writeFile(join(cwd, ".explore", screenshot.path), "corrupted");
  const validation = runFailure(cwd, ["validate"]);
  assert.match(validation.errors.join(" "), /integrity validation/);
});

test("refuses cross-screen references even when the JSON schema is valid", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-references-"));
  const store = await createMapStore(cwd, "References");
  for (const id of ["first", "second"]) {
    await addScreen(store, { id, title: id, fingerprint: id, start: id === "first" });
  }

  const map = await store.read();
  const firstObservation = map.observations.find((observation) => observation.screenId === "first");
  const secondVariant = map.variants.find((variant) => variant.screenId === "second");
  firstObservation.variantId = secondVariant.id;
  await assert.rejects(store.write(map), /variant from another screen/);
  assert.equal(run(cwd, ["validate"]).ok, true);
});

test("npm package contains the action, workflow templates, compiled artifacts, and setup skill", async () => {
  const cache = await mkdtemp(join(tmpdir(), "expo-explore-npm-cache-"));
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
  assert.equal(result.status, 0, result.stderr);
  const pack = JSON.parse(result.stdout)[0];
  const files = new Set(pack.files.map((file) => file.path));
  assert.ok(files.has("LICENSE"));
  assert.ok(files.has("action.yml"));
  assert.ok(files.has("templates/explore-baseline.yml"));
  assert.ok(files.has("templates/explore-review.yml"));
  assert.ok(!files.has("templates/explore-pr.yml"));
  assert.ok(!files.has("templates/explore-public-review.yml"));
  assert.ok(files.has("dist/cli.js"));
  assert.ok(files.has("dist/config/setup.js"));
  assert.ok(files.has("dist/viewer/index.html"));
  assert.ok(files.has("dist/viewer/fonts/OFL-1.1.txt"));
  assert.ok(files.has("dist/viewer/fonts/NOTICE.txt"));
  assert.ok(files.has("schema/screen-map.v1.schema.json"));
  assert.ok(files.has("schema/build-catalog.v1.schema.json"));
  assert.ok(files.has("schema/build-comparison.v1.schema.json"));
  assert.ok([...files].every((file) => !file.startsWith(".agents/")));
  assert.ok(files.has("skills/explore-setup/SKILL.md"));
  assert.ok([...files].every((file) => !file.startsWith("examples/")));
  assert.match(
    import.meta.resolve("@expo/explore/schema/build-catalog.v1"),
    /schema\/build-catalog\.v1\.schema\.json$/,
  );
  assert.match(
    import.meta.resolve("@expo/explore/schema/build-comparison.v1"),
    /schema\/build-comparison\.v1\.schema\.json$/,
  );
});

test("compiled CLI remains directly executable after a build", async () => {
  assert.notEqual((await stat(cli)).mode & 0o111, 0);
  const result = spawnSync(cli, ["help", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Expo Explore/);
});

test("help lists the terminal and CI commands and keeps the map queries behind --all", () => {
  const short = spawnSync(cli, ["help"], { cwd: root, encoding: "utf8" });
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /Get started/);
  assert.match(short.stdout, /capture:review/);
  assert.match(short.stdout, /expo-explore help --all/);
  assert.doesNotMatch(short.stdout, /screen:get/);

  const all = spawnSync(cli, ["help", "--all"], { cwd: root, encoding: "utf8" });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /Map queries/);
  assert.match(all.stdout, /screen:get --id ID/);
});

test("export:web rejects the removed visual diff command override", () => {
  const result = raw(root, [
    "export:web",
    "--agent-device-command",
    "/tmp/agent-device",
  ]);
  assert.notEqual(result.status, 0);
  const failure = JSON.parse(result.stderr || result.stdout);
  assert.match(failure.error, /Unknown flag for export:web/);
});

test("doctor --capture accepts --platform, as its help says", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-doctor-platform-"));
  try {
    const result = raw(root, ["doctor", "--capture", "--platform", "android", "--offline", "--project", cwd]);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unknown flag for doctor/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("setup --workflows accepts --force", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-setup-force-"));
  try {
    const result = raw(root, ["setup", "--workflows", "--force", "--project", cwd]);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unknown flag for setup/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
