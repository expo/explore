import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { runBlackBoxExploration } = await tsImport("../../src/binary/explorer.ts", import.meta.url);
const { assertFlowsFit, createFlowSession, parseFlowPlan } = await tsImport("../../src/binary/flows.ts", import.meta.url);
const { chooseStrategy, strategyInputs } = await tsImport("../../src/binary/strategy.ts", import.meta.url);
const { ExploreStore, validateMap } = await tsImport("../../src/map/store.ts", import.meta.url);
const { CONTRACT } = await tsImport("../../src/types.ts", import.meta.url);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SCREENS = {
  home: [{ type: "StaticText", label: "Welcome" }, { type: "Button", label: "Settings" }, { type: "Button", label: "Profile" }, { type: "Button", label: "Delete account" }],
  settings: [{ type: "StaticText", label: "Settings" }, { type: "Switch", label: "Dark mode" }, { type: "Button", label: "Back" }],
  profile: [{ type: "StaticText", label: "Profile" }, { type: "Button", label: "Edit name" }, { type: "Button", label: "Back" }],
  editor: [{ type: "StaticText", label: "Edit name" }, { type: "TextField", label: "Name" }, { type: "Button", label: "Save" }],
};
const ROUTES = { Settings: "settings", Profile: "profile", "Edit name": "editor" };

/** A device whose taps follow ROUTES, and which a relaunch returns to Home; it records what reached it. */
function device() {
  let screen = "home", frames = 0;
  const acted = [], restarts = [];
  return { acted, restarts, options: {
    observe: async includeImage => ({ nodes: SCREENS[screen], capturedAt: new Date().toISOString(),
      ...(includeImage ? { frameId: `frame-${++frames}`, png: PNG, imageSha256: `${frames}`.padStart(64, "c") } : {}) }),
    act: async action => {
      acted.push(action);
      if (action.action === "tap" && !ROUTES[action.label]) throw new Error(`No element labelled ${action.label}`);
      if (action.action === "tap") screen = ROUTES[action.label];
      if (action.action === "back") screen = "home";
    },
    flows: { restart: async () => { restarts.push(screen); screen = "home"; } },
  } };
}

async function explore(plan, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-flows-"));
  const store = new ExploreStore(root);
  const now = new Date("2026-01-01T00:00:00Z").toISOString();
  const map = { contract: CONTRACT, revision: 0, run: { id: "run-1", name: "Example", platform: "ios", controller: "agent-device", bundleId: "dev.example.app", status: "exploring",
    createdAt: now, updatedAt: now, build: { hash: "0".repeat(64), source: "local" }, environment: { deviceModel: "iPhone 17 Pro" }, limits: { maxScreens: 20, maxActions: 20, maxDurationMinutes: 5 } },
    artifacts: [], screens: [], variants: [], observations: [], elements: [], actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [] };
  await store.initialize(map, false);
  const phone = device();
  const session = options.session ?? createFlowSession(plan, "ios", { app: { name: "Example" }, ...(options.model ? { model: options.model } : {}) });
  const result = await runBlackBoxExploration({ session, store, map, app: { name: "Example", bundleId: "dev.example.app", platform: "ios" },
    deadlineMs: Date.now() + 60_000, maxScreens: 20, maxActions: 20, maxTurns: 100, loadingSettleMs: 0, budgetNote: session.budgetNote, ...phone.options, ...options.host });
  return { result, map, store, ...phone };
}

const checkpointShots = (map, flow) => flow.checkpoints.map(item => item.observationId
  ? { name: item.name, screen: map.screens.find(screen => screen.id === map.observations.find(observation => observation.id === item.observationId).screenId).title }
  : { name: item.name, missing: item.missing });

const TWO_FLOWS = { flows: [
  { name: "Settings", steps: [{ checkpoint: "Home" }, { action: "tap", label: "Settings" }, { checkpoint: "Settings" }] },
  { name: "Profile", steps: [{ checkpoint: "Home" }, { action: "tap", label: "Profile" }, { checkpoint: "Profile" }, { action: "tap", label: "Edit name" }, { checkpoint: "Editor" }] },
] };

test("each flow runs from a relaunched app, records its checkpoints in order, and becomes a journey of the map", async () => {
  const { result, map, store, restarts } = await explore(parseFlowPlan(TWO_FLOWS));
  assert.equal(result.stopReason, "finished");
  assert.match(result.summary, /^Ran 2 flows on ios: 2 completed, 0 failed\.$/);
  assert.deepEqual(restarts, ["settings"], "the second flow starts from a relaunch; the first from the app as opened");
  assert.deepEqual(result.flows.map(flow => [flow.name, flow.status]), [["Settings", "completed"], ["Profile", "completed"]]);
  assert.deepEqual(checkpointShots(map, result.flows[1]), [{ name: "Home", screen: "Home" }, { name: "Profile", screen: "Profile" }, { name: "Editor", screen: "Editor" }]);
  // Home is a checkpoint of both flows: each flow has its own picture of it.
  assert.notEqual(result.flows[0].checkpoints[0].observationId, result.flows[1].checkpoints[0].observationId);
  // A checkpoint on a screen just reached keeps the picture taken on arrival; only the relaunched Home needs a second one.
  assert.equal(map.observations.filter(observation => observation.screenshotArtifactId).length, 5);
  const journey = map.journeys.find(item => item.id === result.flows[1].journeyId);
  assert.deepEqual(journey.screenIds.map(id => map.screens.find(screen => screen.id === id).title), ["Home", "Profile", "Editor"]);
  assert.deepEqual(await validateMap(map, store), []);
});

test("the same flows in two runs pair up by flow and checkpoint name", async () => {
  const first = await explore(parseFlowPlan(TWO_FLOWS));
  const second = await explore(parseFlowPlan(TWO_FLOWS));
  const pairs = run => run.result.flows.map(flow => ({ journeyId: flow.journeyId, checkpoints: flow.checkpoints.map(item => item.name) }));
  assert.deepEqual(pairs(first), pairs(second));
});

test("a failed step ends its flow with the reason and the checkpoints it did not reach, and the next flow still runs", async () => {
  const plan = parseFlowPlan({ flows: [
    { name: "Broken", steps: [{ checkpoint: "Home" }, { action: "tap", label: "Nowhere" }, { checkpoint: "Never" }, { checkpoint: "Also never" }] },
    { name: "Settings", steps: [{ action: "tap", label: "Settings" }, { checkpoint: "Settings" }] },
  ] });
  const { result, map, store } = await explore(plan);
  assert.equal(result.stopReason, "finished");
  assert.match(result.summary, /1 completed, 1 failed\. Failed: Broken\.$/);
  const [broken, settings] = result.flows;
  assert.equal(broken.status, "failed");
  assert.match(broken.reason, /^Step 2 \(tap "Nowhere"\) failed: .*No element labelled Nowhere/);
  assert.deepEqual(checkpointShots(map, broken), [{ name: "Home", screen: "Home" },
    { name: "Never", missing: "The flow did not reach it." }, { name: "Also never", missing: "The flow did not reach it." }]);
  assert.equal(settings.status, "completed");
  assert.deepEqual(await validateMap(map, store), []);
});

test("a destructive tap in a flow is refused by the explorer, which fails the flow", async () => {
  const { result, acted } = await explore(parseFlowPlan({ flows: [{ name: "Danger", steps: [{ action: "tap", label: "Delete account" }, { checkpoint: "After" }] }] }));
  assert.ok(!acted.some(action => action.label === "Delete account"));
  assert.equal(result.flows[0].status, "failed");
  assert.match(result.flows[0].reason, /looks destructive/);
});

/** A model that, given a step, taps what its script says for that step and then reports how it went. */
function scriptedModel(steps) {
  const seen = [];
  return { seen, model: { async run(request) {
    const prompt = JSON.parse(request.prompt);
    seen.push({ step: prompt.step, afterwards: prompt.afterwards, tools: request.tools.map(tool => tool.name) });
    const [taps, ending] = steps[prompt.step];
    try {
      await request.callTool("observe", { includeImage: false }, request.signal);
      for (const label of taps) await request.callTool("act", { action: "tap", label }, request.signal);
      await request.callTool(ending.done ? "step_done" : "step_blocked", ending.done ? {} : { reason: ending.reason }, request.signal);
    } catch (error) { if (!request.signal.aborted) throw error; }
    return { inputTokens: 3, outputTokens: 2 };
  } } };
}

test("a step described in words is carried out by a model that sees only observe, act and the step's own tools", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Rename", steps: [{ checkpoint: "Home" }, { do: "Open the name editor from the profile" }, { checkpoint: "Editor" }] }] });
  const { seen, model } = scriptedModel({ "Open the name editor from the profile": [["Profile", "Edit name"], { done: true }] });
  const { result, map, store } = await explore(plan, { model });
  assert.equal(result.flows[0].status, "completed");
  assert.deepEqual(seen, [{ step: "Open the name editor from the profile", afterwards: 'The flow records the checkpoint "Editor" next.', tools: ["observe", "act", "step_done", "step_blocked"] }]);
  assert.deepEqual(checkpointShots(map, result.flows[0]).map(item => item.screen), ["Home", "Editor"]);
  const journey = map.journeys.find(item => item.id === result.flows[0].journeyId);
  assert.equal(journey.attemptIds.length, 2, "the model's actions are the flow's journey");
  assert.deepEqual(await validateMap(map, store), []);
});

test("a described step the model cannot do fails the flow with what the model saw", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Sign in", steps: [{ do: "Sign in" }, { checkpoint: "Signed in" }] }] });
  const { model } = scriptedModel({ "Sign in": [[], { done: false, reason: "There is no sign-in screen." }] });
  const { result } = await explore(plan, { model });
  assert.equal(result.flows[0].status, "failed");
  assert.equal(result.flows[0].reason, 'Step 1 ("Sign in") was not done: There is no sign-in screen.');
  assert.deepEqual(result.flows[0].checkpoints, [{ name: "Signed in", missing: "The flow did not reach it." }]);
});

test("a run that stops at its budget mid-flow marks the flow stopped and names the checkpoints it did not reach", async () => {
  const { result, map } = await explore(parseFlowPlan(TWO_FLOWS), { host: { maxActions: 2 } });
  assert.equal(result.stopReason, "budget-actions");
  assert.deepEqual(result.flows.map(flow => [flow.name, flow.status]), [["Settings", "completed"], ["Profile", "stopped"]]);
  assert.ok(map.gaps.some(gap => /Not reached: Profile › Editor\./.test(gap.message)), JSON.stringify(map.gaps));
});

test("a flows file is checked before any device starts", () => {
  const refused = (value, pattern) => assert.throws(() => parseFlowPlan(value), error => error.code === "FLOWS_PLAN_INVALID" && pattern.test(error.message), String(pattern));
  refused({ steps: [] }, /no flows array/);
  refused({ flows: [] }, /no flows\./);
  refused({ flows: [{ name: "A", steps: [{ capture: "Home" }] }] }, /checkpoint, not capture/);
  refused({ flows: [{ name: "A", steps: [{ action: "tap", label: "Go" }] }] }, /has no checkpoint/);
  refused({ flows: [{ name: "A", steps: [{ checkpoint: "Home" }] }, { name: "a", steps: [{ checkpoint: "Home" }] }] }, /already named "a"/);
  refused({ flows: [{ name: "A", steps: [{ checkpoint: "Home" }, { checkpoint: "home" }] }] }, /two checkpoints "home"/);
  refused({ flows: [{ name: "A", steps: [{ checkpoint: "Home", do: "x" }] }] }, /both a checkpoint and a described step/);
  refused({ flows: [{ name: "A", steps: [{ do: "Sign in", optional: true }, { checkpoint: "Home" }] }] }, /field "optional" it does not take/);
  refused({ flows: [{ name: "A", steps: [{ do: "Type {{secret:lower}}" }, { checkpoint: "Home" }] }] }, /\{\{secret:NAME\}\}/);
  refused({ flows: [{ name: "A", steps: [{ action: "tap" }, { checkpoint: "Home" }] }] }, /exactly one of label or identifier/);
  refused({ flows: [{ name: "A", steps: [{ checkpoint: "Home" }], extra: 1 }] }, /field "extra"/);
  assert.throws(() => assertFlowsFit(parseFlowPlan({ flows: [{ name: "A", steps: [{ checkpoint: "Home", platforms: ["android"] }] }] }), "ios", { maxScreens: 10, maxActions: 10 }),
    error => error.code === "FLOWS_PLAN_EMPTY");
  assert.throws(() => assertFlowsFit(parseFlowPlan(TWO_FLOWS), "ios", { maxScreens: 5, maxActions: 10 }), error => error.code === "FLOWS_PLAN_OVER_BUDGET" && /--max-screens 6/.test(error.nextAction));
});

test("a {{secret:NAME}} in a described step must be set before any device starts, as one in the hints must", () => {
  const plan = parseFlowPlan({ flows: [{ name: "Sign in", steps: [{ do: "Sign in with {{secret:TEST_PASSWORD}}" }, { checkpoint: "Home" }] }] });
  assert.throws(() => strategyInputs({ kind: "flows", plan }, undefined, {}), error => error.code === "EXPLORATION_SECRET_MISSING" && /TEST_PASSWORD/.test(error.nextAction));
  assert.deepEqual(strategyInputs({ kind: "flows", plan }, undefined, { TEST_PASSWORD: "hunter2" }).names, ["TEST_PASSWORD"]);
});

test("the strategy is chosen before any device starts, and options that would do nothing with it are refused", () => {
  const exact = { flows: [{ name: "A", steps: [{ action: "tap", label: "Settings" }, { checkpoint: "Settings" }] }] };
  const described = { flows: [{ name: "A", steps: [{ do: "Open the settings" }, { checkpoint: "Settings" }] }] };
  assert.deepEqual(chooseStrategy({}), { kind: "model" });
  assert.equal(chooseStrategy({ flows: exact }).kind, "flows");
  assert.equal(chooseStrategy({ flows: described, provider: "openai", hints: "Use the test account" }).kind, "flows");
  assert.throws(() => chooseStrategy({ flows: exact, replay: { steps: [{ capture: "Home" }] } }), { code: "FLOWS_WITH_REPLAY" });
  assert.throws(() => chooseStrategy({ flows: exact, model: "gpt-6.1-sol" }), error => error.code === "FLOWS_OPTIONS_IGNORED" && /--model would do nothing/.test(error.message));
  assert.throws(() => chooseStrategy({ replay: { steps: [{ capture: "Home" }] }, hints: "x" }), { code: "REPLAY_OPTIONS_IGNORED" });
  assert.throws(() => chooseStrategy({ flows: { flows: [{ name: "A", steps: [{ action: "open", url: "https://example.com" }, { checkpoint: "Web" }] }] } }),
    error => error.code === "FLOWS_PLAN_INVALID" && /Flow 1 \(A\), step 1: https: URLs leave the app/.test(error.message));
});
