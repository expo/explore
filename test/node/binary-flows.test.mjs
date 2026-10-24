import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { runBlackBoxExploration, assertFlowsFit, createFlowSession, flowsNeedModel, parseFlowPlan, hintInputs, runBoundedSession, ExploreStore, validateMap, CiError, CONTRACT } =
  await tsImport("../helpers/flows-host.ts", import.meta.url);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SCREENS = {
  home: [{ type: "StaticText", label: "Welcome" }, { type: "Button", label: "Settings" }, { type: "Button", label: "Profile" }, { type: "Button", label: "Delete account" }],
  settings: [{ type: "StaticText", label: "Settings" }, { type: "Switch", label: "Dark mode" }, { type: "Button", label: "Back" }],
  profile: [{ type: "StaticText", label: "Profile" }, { type: "Button", label: "Edit name" }, { type: "Button", label: "Back" }],
  editor: [{ type: "StaticText", label: "Edit name" }, { type: "TextField", label: "Name" }, { type: "Button", label: "Save" }],
};
const ROUTES = { Settings: "settings", Profile: "profile", "Edit name": "editor" };

/**
 * A device whose taps follow ROUTES, and which a relaunch returns to Home; it records what reached it. `failRelaunch`
 * lists the relaunches (1 is the first) that fail, `failPicture` the pictures (1 is the first) whose observation throws,
 * `withholdPicture` those the device declines to take (a blocked screenshot), and `driftOnTap` a tap that fails yet
 * moves the app, to the screen it names.
 */
function device(behaviour = {}) {
  let screen = "home", frames = 0, pictures = 0;
  const acted = [], restarts = [];
  return { acted, restarts, options: {
    observe: async includeImage => {
      if (includeImage) pictures += 1;
      if (includeImage && behaviour.failPicture?.includes(pictures)) throw new CiError({ code: "OBSERVATION_FAILED", stage: "session", message: "The accessibility snapshot failed.", nextAction: "Retry." });
      if (includeImage && behaviour.withholdPicture?.includes(pictures)) return { nodes: SCREENS[screen], capturedAt: new Date().toISOString(), imageUnavailable: { code: "SCREENSHOT_FAILED", message: "The screenshot was blocked." } };
      return { nodes: SCREENS[screen], capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${++frames}`, png: PNG, imageSha256: `${frames}`.padStart(64, "c") } : {}) };
    },
    act: async action => {
      acted.push(action);
      if (action.action === "tap" && behaviour.driftOnTap?.[action.label]) { screen = behaviour.driftOnTap[action.label]; throw new Error(`${action.label} timed out`); }
      if (action.action === "tap" && !ROUTES[action.label]) throw new Error(`No element labelled ${action.label}`);
      if (action.action === "tap") screen = ROUTES[action.label];
      if (action.action === "back") screen = "home";
    },
    restart: async () => {
      restarts.push(screen);
      if (behaviour.failRelaunch?.includes(restarts.length)) throw new CiError({ code: "APP_RELAUNCH_FAILED", stage: "session", message: "agent-device could not relaunch the app.", nextAction: "Retry." });
      screen = "home";
    },
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
  const { acted, restarts, options: { restart, ...phone } } = device(options.device);
  const session = options.session ?? createFlowSession(plan, "ios", { app: { name: "Example" }, ...(options.model ? { model: options.model } : {}) });
  const result = await runBlackBoxExploration({ session, store, map, app: { name: "Example", bundleId: "dev.example.app", platform: "ios" },
    deadlineMs: Date.now() + 60_000, maxScreens: 20, maxActions: 20, maxTurns: 100, loadingSettleMs: 0, budgetNote: session.budgetNote,
    ...phone, flows: { restart, notReached: session.notReached }, ...options.host });
  return { result, map, store, acted, restarts };
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
  const journey = map.journeys.find(item => item.id === result.flows[1].journeyIds[0]);
  assert.deepEqual(journey.screenIds.map(id => map.screens.find(screen => screen.id === id).title), ["Home", "Profile", "Editor"]);
  assert.deepEqual(await validateMap(map, store), []);
});

test("the same flows in two runs pair up by flow and checkpoint name", async () => {
  const first = await explore(parseFlowPlan(TWO_FLOWS));
  const second = await explore(parseFlowPlan(TWO_FLOWS));
  const pairs = run => run.result.flows.map(flow => ({ journeyIds: flow.journeyIds, checkpoints: flow.checkpoints.map(item => item.name) }));
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
  const journey = map.journeys.find(item => item.id === result.flows[0].journeyIds[0]);
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
  assert.deepEqual(checkpointShots(map, result.flows[1]), [{ name: "Home", screen: "Home" }, { name: "Profile", screen: "Profile" }, { name: "Editor", missing: "The run stopped before it." }]);
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
  assert.throws(() => assertFlowsFit(parseFlowPlan({ flows: [{ name: "A", steps: [{ checkpoint: "Home", platforms: ["android"] }] }] }), "ios", { maxScreens: 10, maxActions: 10, maxTurns: 100 }),
    error => error.code === "FLOWS_PLAN_EMPTY");
  assert.throws(() => assertFlowsFit(parseFlowPlan(TWO_FLOWS), "ios", { maxScreens: 5, maxActions: 10, maxTurns: 100 }), error => error.code === "FLOWS_PLAN_OVER_BUDGET" && /--max-screens 6/.test(error.nextAction));
});

test("a {{secret:NAME}} in a described step must be set before any device starts, as one in the hints must", () => {
  const plan = parseFlowPlan({ flows: [{ name: "Sign in", steps: [{ do: "Sign in with {{secret:TEST_PASSWORD}}" }, { checkpoint: "Home" }] }] });
  assert.throws(() => hintInputs(undefined, {}, undefined, plan), error => error.code === "EXPLORATION_SECRET_MISSING" && /TEST_PASSWORD/.test(error.nextAction));
  assert.deepEqual(hintInputs(undefined, { TEST_PASSWORD: "hunter2" }, undefined, plan).names, ["TEST_PASSWORD"]);
});

test("a checkpoint after a relaunch takes a new picture, even of the screen the previous flow ended on untouched", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "First", steps: [{ checkpoint: "Home" }] }, { name: "Second", steps: [{ checkpoint: "Home" }] }] });
  const { result, restarts } = await explore(plan);
  assert.deepEqual(restarts, ["home"]);
  assert.notEqual(result.flows[0].checkpoints[0].observationId, result.flows[1].checkpoints[0].observationId);
});

test("a checkpoint after a described step's model looked at the screen again takes a new picture", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Settings", steps: [{ do: "Open the settings" }, { checkpoint: "Settings" }] }] });
  const model = { async run(request) {
    try {
      await request.callTool("act", { action: "tap", label: "Settings" }, request.signal);
      await request.callTool("observe", { includeImage: true }, request.signal);
      await request.callTool("step_done", {}, request.signal);
    } catch (error) { if (!request.signal.aborted) throw error; }
    return { inputTokens: 0, outputTokens: 0 };
  } };
  const { result, map } = await explore(plan, { model });
  const settings = map.screens.find(screen => screen.title === "Settings");
  const pictures = map.observations.filter(observation => observation.screenId === settings.id && observation.screenshotArtifactId);
  assert.equal(pictures.length, 2, "the picture on arrival, and the checkpoint's");
  assert.equal(result.flows[0].checkpoints[0].observationId, pictures[1].id);
});

test("a flow whose relaunch fails is recorded as failed with its checkpoints missing, and the next flow is still relaunched", async () => {
  const plan = parseFlowPlan({ flows: [
    { name: "Home", steps: [{ checkpoint: "Home" }] },
    { name: "Settings", steps: [{ action: "tap", label: "Settings" }, { checkpoint: "Settings" }] },
    { name: "Profile", steps: [{ action: "tap", label: "Profile" }, { checkpoint: "Profile" }] },
  ] });
  const { result, map, store, restarts } = await explore(plan, { device: { failRelaunch: [1] } });
  assert.equal(restarts.length, 2);
  assert.deepEqual(result.flows.map(flow => [flow.name, flow.status]), [["Home", "completed"], ["Settings", "failed"], ["Profile", "completed"]]);
  assert.equal(result.flows[1].reason, "The flow could not start: agent-device could not relaunch the app.");
  assert.deepEqual(result.flows[1].checkpoints, [{ name: "Settings", missing: "The flow did not reach it." }]);
  assert.deepEqual(await validateMap(map, store), []);
});

test("two relaunches failing in a row stop the run, and the flows after them are recorded as stopped", async () => {
  const flow = name => ({ name, steps: [{ checkpoint: name }] });
  const { result } = await explore(parseFlowPlan({ flows: [flow("A"), flow("B"), flow("C"), flow("D")] }), { device: { failRelaunch: [1, 2] } });
  assert.equal(result.stopReason, "blocked");
  assert.match(result.summary, /could not be relaunched for two flows running/);
  assert.deepEqual(result.flows.map(item => [item.name, item.status]), [["A", "completed"], ["B", "failed"], ["C", "failed"], ["D", "stopped"]]);
  assert.deepEqual(result.flows[3].checkpoints, [{ name: "D", missing: "The run stopped before it." }]);
  assert.equal(result.flows[3].reason, "The run stopped (blocked) before this flow.");
});

test("a checkpoint whose picture throws is recorded as missing with the error, and fails its flow", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Home", steps: [{ checkpoint: "Home" }, { action: "wait", milliseconds: 1 }, { checkpoint: "Still home" }, { checkpoint: "After" }] }] });
  const { result } = await explore(plan, { device: { failPicture: [2] } });
  assert.match(result.summary, /0 completed, 1 failed/);
  assert.equal(result.flows[0].status, "failed");
  assert.match(result.flows[0].reason, /^Checkpoint "Still home" could not be taken: The accessibility snapshot failed\./);
  assert.deepEqual(result.flows[0].checkpoints.slice(1), [{ name: "Still home", missing: "The accessibility snapshot failed." }, { name: "After", missing: "The flow did not reach it." }]);
});

test("when the app moves without a transition, the flow's walk goes on as a second journey", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Drift", steps: [
    { action: "tap", label: "Settings" }, { action: "tap", label: "Profile", optional: true }, { action: "tap", label: "Edit name" }, { checkpoint: "Editor" },
  ] }] });
  const { result, map, store } = await explore(plan, { device: { driftOnTap: { Profile: "profile" } } });
  assert.equal(result.flows[0].status, "completed");
  const titles = id => map.journeys.find(journey => journey.id === id).screenIds.map(screen => map.screens.find(item => item.id === screen).title);
  assert.equal(result.flows[0].journeyIds.length, 2);
  assert.match(result.flows[0].journeyIds[1], /^jrn_[0-9a-f]{16}-2$/);
  assert.deepEqual(result.flows[0].journeyIds.map(titles), [["Screen 1", "Screen 2"], ["Screen 3", "Editor"]]);
  assert.deepEqual(await validateMap(map, store), []);
});

test("a described step limited to another platform needs no model, and its secrets need not be set", () => {
  const plan = parseFlowPlan({ flows: [{ name: "A", steps: [{ do: "Sign in with {{secret:ANDROID_PASSWORD}}", platforms: ["android"] }, { action: "tap", label: "Settings" }, { checkpoint: "Settings" }] }] });
  assert.equal(flowsNeedModel(plan, "ios"), false);
  assert.equal(flowsNeedModel(plan, "android"), true);
  assert.doesNotThrow(() => createFlowSession(plan, "ios", { app: { name: "Example" } }));
  assert.deepEqual(hintInputs(undefined, {}, undefined, plan, "ios").names, []);
  assert.throws(() => hintInputs(undefined, {}, undefined, plan), error => error.code === "EXPLORATION_SECRET_MISSING", "without a platform, every step's secrets are needed");
});

test("flows whose tool calls cannot fit the turn budget are refused before any device starts", () => {
  const flows = count => parseFlowPlan({ flows: Array.from({ length: count }, (_, index) => ({ name: `Flow ${index}`, steps: [{ checkpoint: "Home" }] })) });
  const limits = { maxScreens: 51, maxActions: 1, maxTurns: 125 };
  assert.throws(() => assertFlowsFit(flows(50), "ios", limits), error => error.code === "FLOWS_PLAN_OVER_BUDGET" && /at least 151 tool calls, more than the 125/.test(error.message));
  assert.doesNotThrow(() => assertFlowsFit(flows(41), "ios", limits), "41 flows take 124 calls");
});

test("a checkpoint whose screen withholds its picture is recorded as missing, its flow goes on, and the summary names it", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Home", steps: [{ checkpoint: "Home" }, { action: "wait", milliseconds: 1 }, { checkpoint: "Still home" }, { action: "tap", label: "Settings" }, { checkpoint: "Settings" }] }] });
  const { result, map } = await explore(plan, { device: { withholdPicture: [2] } });
  assert.equal(result.flows[0].status, "completed");
  assert.deepEqual(checkpointShots(map, result.flows[0]), [{ name: "Home", screen: "Home" }, { name: "Still home", missing: "The screenshot was blocked." }, { name: "Settings", screen: "Settings" }]);
  assert.match(result.summary, /1 completed, 0 failed\. Checkpoints without a picture: Home › Still home\.$/);
});

test("a checkpoint that a screen or turn budget stops is recorded as not reached, not dropped", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Settings", steps: [{ checkpoint: "Home" }, { action: "tap", label: "Settings" }, { action: "wait", milliseconds: 1 }, { checkpoint: "Settings" }] }] });
  // Home and the arrival at Settings use the two screens; the wait means the checkpoint needs a third.
  const screens = await explore(plan, { host: { maxScreens: 2 } });
  assert.equal(screens.result.stopReason, "budget-screens");
  assert.equal(screens.result.flows[0].status, "stopped");
  assert.deepEqual(checkpointShots(screens.map, screens.result.flows[0]), [{ name: "Home", screen: "Home" }, { name: "Settings", missing: "The run stopped before it." }]);
  // start_flow is the one tool call the turn budget allows.
  const turns = await explore(plan, { host: { maxTurns: 1 } });
  assert.deepEqual(turns.result.flows[0].checkpoints, [{ name: "Home", missing: "The run stopped before it." }, { name: "Settings", missing: "The run stopped before it." }]);
});

test("a described step that a real session ends with AGENT_CANCELLED after step_done still counts as done", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Settings", steps: [{ do: "Open the settings" }, { checkpoint: "Settings" }] }] });
  // runBoundedSession rejects once the step's signal is aborted, as the Claude and Codex sessions do.
  const model = { run: request => runBoundedSession({ provider: "openai", model: "test" }, request, async bounded => {
    await bounded.callTool("act", { action: "tap", label: "Settings" });
    await bounded.callTool("step_done", {});
    return { inputTokens: 1, outputTokens: 1 };
  }) };
  await assert.rejects(model.run({ instructions: "x", prompt: "x", tools: [{ name: "step_done", inputSchema: { type: "object" } }], deadlineMs: Date.now() + 1000,
    signal: AbortSignal.abort(), callTool: async () => ({ content: [] }) }), error => error.code === "AGENT_CANCELLED");
  const { result } = await explore(plan, { model });
  assert.equal(result.flows[0].status, "completed", result.flows[0].reason);
});

test("a described step whose model keeps going past its 40 tool calls fails, and the next flow still runs", async () => {
  const plan = parseFlowPlan({ flows: [{ name: "Loop", steps: [{ do: "Find the hidden screen" }, { checkpoint: "Hidden" }] }, { name: "Home", steps: [{ checkpoint: "Home" }] }] });
  let calls = 0;
  // A session that ignores maxTurns, as the Codex one has no equivalent of it.
  const model = { async run(request) {
    while (!request.signal.aborted) { await request.callTool("observe", { includeImage: false }, request.signal); calls += 1; }
    return { inputTokens: 0, outputTokens: 0 };
  } };
  const { result } = await explore(plan, { model, host: { maxTurns: 1000 } });
  assert.equal(calls, 41, "40 calls reach the explorer, and the 41st is refused");
  assert.equal(result.flows[0].status, "failed");
  assert.match(result.flows[0].reason, /used its 40 tool calls without finishing the step/);
  assert.equal(result.flows[1].status, "completed");
});

test("a flow with no checkpoint on the platform is skipped, and its steps need no model or secrets", async () => {
  const plan = parseFlowPlan({ flows: [
    { name: "Android only", steps: [{ do: "Sign in with {{secret:ANDROID_PASSWORD}}" }, { checkpoint: "Signed in", platforms: ["android"] }] },
    { name: "Settings", steps: [{ action: "tap", label: "Settings" }, { checkpoint: "Settings" }] },
  ] });
  assert.equal(flowsNeedModel(plan, "ios"), false);
  assert.deepEqual(hintInputs(undefined, {}, undefined, plan, "ios").names, []);
  const { result } = await explore(plan);
  assert.deepEqual(result.flows.map(flow => flow.name), ["Settings"]);
  assert.match(result.summary, /^Ran 1 flow on ios/);
});

test("explore:session without --platform needs only the secrets of the flows' steps on the session's platform", async () => {
  const { runSessionExploration } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const environment = { EXPO_TOKEN: "token", EAS_SIMULATOR_SESSION_ID: "01a1-mine", AGENT_DEVICE_DAEMON_BASE_URL: "https://daemon.example", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "t" };
  const looked = [];
  // The session is an iOS one; any device work after looking it up ends the test.
  const runner = request => {
    if (request.args.includes("simulator:get")) {
      looked.push(true);
      return { stdout: JSON.stringify({ id: "01a1-mine", type: "agent-device", status: "IN_PROGRESS", platform: "IOS", name: "Session",
        remoteConfig: { agentDeviceRemoteSessionUrl: "https://daemon.example", agentDeviceRemoteSessionToken: "t" } }), stderr: "", status: 0 };
    }
    throw new Error("device work started");
  };
  const run = steps => runSessionExploration({ output: join(tmpdir(), `explore-flows-session-${Math.random()}`), bundleId: "dev.example.app", environment, runner,
    flows: parseFlowPlan({ flows: [{ name: "Sign in", steps }] }) });
  await assert.rejects(run([{ action: "fill", label: "Password", text: "{{secret:ANDROID_PASSWORD}}", platforms: ["android"] }, { checkpoint: "Home" }]),
    error => error.code !== "EXPLORATION_SECRET_MISSING" && /device work started/.test(error.message), "a secret only Android steps type is not needed on iOS");
  await assert.rejects(run([{ action: "fill", label: "Password", text: "{{secret:IOS_PASSWORD}}" }, { checkpoint: "Home" }]),
    error => error.code === "EXPLORATION_SECRET_MISSING" && /IOS_PASSWORD/.test(error.message));
  assert.equal(looked.length, 2, "the platform comes from the session");
});
