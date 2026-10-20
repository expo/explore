import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { approveSessionUrlSchemes, simulatorControl, simulatorControlActions } = await tsImport("../../src/capture/simulator-control.ts", import.meta.url);

function easFake(listed) {
  const calls = [];
  const eas = (args, options) => {
    calls.push({ args, options });
    if (args.includes("--list")) { if (listed instanceof Error) throw listed; return { stdout: listed }; }
    return { stdout: "{}" };
  };
  return { calls, eas };
}

test("a session's control actions come from --list, by session id", () => {
  const { calls, eas } = easFake(JSON.stringify({ "appearance.set": {}, "springboard.restart": {} }));
  assert.deepEqual([...simulatorControlActions(eas, "session-1")], ["appearance.set", "springboard.restart"]);
  assert.deepEqual(calls[0].args, ["simulator:control", "--list", "--id", "session-1", "--json", "--non-interactive"]);
  assert.equal(calls[0].options.allowFailure, true);
});

test("a session that lists no actions, or whose serve-sim or EAS CLI predates the list, has none, and is asked once", () => {
  const pauses = [];
  const options = { sleep: milliseconds => pauses.push(milliseconds) };
  const empty = easFake("{}");
  assert.equal(simulatorControlActions(empty.eas, "session-1", options).size, 0);
  assert.equal(empty.calls.length, 1);
  // eas-cli 25.2.0 on a session whose serve-sim refuses `actions.describe`, and an EAS CLI without simulator:control.
  for (const reason of ["This simulator session runs a serve-sim version that does not support this action. Start a new session with `eas simulator:start` to get a newer version.",
    "The simulator did not return its list of actions. Start a new session with `eas simulator:start` to get a newer serve-sim version."]) {
    const calls = [];
    const eas = args => { calls.push(args); return { stdout: "", stderr: `${reason}\nError: simulator:control command failed.\n`, status: 1 }; };
    assert.equal(simulatorControlActions(eas, "session-1", options).size, 0);
    assert.equal(calls.length, 1);
  }
  assert.equal(simulatorControlActions(easFake(new Error("eas exited with status 2: command simulator:control not found")).eas, "session-1", options).size, 0);
  assert.deepEqual(pauses, []);
});

// One failed list made the dark session of euxy's main baseline run 39487618529 look as if it offered no actions.
function flakyList(failures, failure = () => ({ stdout: "", stderr: "The simulator preview server closed the connection before it answered.\nError: simulator:control command failed.\n", status: 1 })) {
  const calls = [];
  const eas = args => {
    calls.push(args);
    if (calls.length <= failures) return failure(calls.length);
    return { stdout: JSON.stringify({ "appearance.set": {}, "app.approveUrlScheme": {}, "springboard.restart": {} }), stderr: "", status: 0 };
  };
  return { calls, eas };
}

test("a list that fails once is asked for again after a pause, and its actions are kept", () => {
  for (const failure of [undefined, () => { throw new Error("eas simulator:control exited with status 1"); }, () => ({ stdout: "Connecting", stderr: "" })]) {
    const { calls, eas } = flakyList(1, failure);
    const pauses = [];
    assert.deepEqual([...simulatorControlActions(eas, "session-1", { sleep: milliseconds => pauses.push(milliseconds) })], ["appearance.set", "app.approveUrlScheme", "springboard.restart"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(pauses.length, 1);
  }
});

test("a list that keeps failing throws a retryable error naming the session and EAS's reason, never an empty set", () => {
  const { calls, eas } = flakyList(Infinity);
  const pauses = [];
  assert.throws(() => simulatorControlActions(eas, "session-1", { sleep: milliseconds => pauses.push(milliseconds) }), error =>
    error.code === "SIMULATOR_CONTROL_UNAVAILABLE" && error.retryable === true && error.stage === "session"
      && /session-1/.test(error.message) && /closed the connection before it answered/.test(error.message) && !/command failed/.test(error.message));
  assert.equal(calls.length, 3);
  assert.equal(pauses.length, calls.length - 1);
  assert.ok(pauses.every(milliseconds => milliseconds > 0 && milliseconds <= 10_000));
});

test("an action's values follow --, so one that starts with a dash is never read as a flag", () => {
  const { calls, eas } = easFake("{}");
  simulatorControl(eas, "session-1", "clipboard.write", ["--not-a-flag"]);
  assert.deepEqual(calls[0].args, ["simulator:control", "clipboard.write", "--id", "session-1", "--json", "--non-interactive", "--", "--not-a-flag"]);
});

test("link schemes are approved once each, lowercased, never http or https, and only when the session offers it", () => {
  const { calls, eas } = easFake("{}");
  const approved = approveSessionUrlSchemes(eas, "session-1", new Set(["app.approveUrlScheme"]), "dev.example.app", ["Example", "example", "https", "exp+example", "not a scheme"]);
  assert.deepEqual(approved, ["example", "exp+example"]);
  assert.deepEqual(calls.map(call => call.args.slice(-2)), [["dev.example.app", "example"], ["dev.example.app", "exp+example"]]);
  const none = easFake("{}");
  assert.deepEqual(approveSessionUrlSchemes(none.eas, "session-1", new Set(), "dev.example.app", ["example"]), []);
  assert.equal(none.calls.length, 0);
});

// The host can fail an action once, as `app.approveUrlScheme` did in its `simctl spawn … defaults write` (euxy run 39348933440).
function flakyEas(failures) {
  const calls = [];
  const eas = args => {
    calls.push(args);
    if (calls.length <= failures) throw new Error("eas simulator:control exited with status 1: The simulator could not run app.approveUrlScheme");
    return { stdout: "{}" };
  };
  return { calls, eas };
}

test("an action that fails once is sent again after a pause", () => {
  const { calls, eas } = flakyEas(1);
  const pauses = [];
  simulatorControl(eas, "session-1", "app.approveUrlScheme", ["dev.example.app", "example"], { sleep: milliseconds => pauses.push(milliseconds) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(pauses.length, 1);
});

test("an action that keeps failing throws EAS's reason after its last attempt, with no pause after it", () => {
  const { calls, eas } = flakyEas(Infinity);
  const pauses = [];
  assert.throws(() => simulatorControl(eas, "session-1", "app.approveUrlScheme", ["dev.example.app", "example"], { sleep: milliseconds => pauses.push(milliseconds) }),
    /could not run app\.approveUrlScheme/);
  assert.equal(calls.length, 3);
  assert.equal(pauses.length, calls.length - 1);
  assert.ok(pauses.every(milliseconds => milliseconds > 0 && milliseconds <= 10_000));
});

test("a link scheme the host fails to approve once is approved on the next attempt", () => {
  const { calls, eas } = flakyEas(1);
  const approved = approveSessionUrlSchemes(eas, "session-1", new Set(["app.approveUrlScheme"]), "dev.example.app", ["example"], { sleep: () => {} });
  assert.deepEqual(approved, ["example"]);
  assert.equal(calls.length, 2);
});
