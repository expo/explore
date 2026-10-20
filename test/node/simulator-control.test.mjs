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

test("a session's control actions come from --list, by session id; an older session or CLI has none", () => {
  const { calls, eas } = easFake(JSON.stringify({ "appearance.set": {}, "springboard.restart": {} }));
  assert.deepEqual([...simulatorControlActions(eas, "session-1")], ["appearance.set", "springboard.restart"]);
  assert.deepEqual(calls[0].args, ["simulator:control", "--list", "--id", "session-1", "--json", "--non-interactive"]);
  assert.equal(calls[0].options.allowFailure, true);
  assert.equal(simulatorControlActions(easFake("Unknown command simulator:control").eas, "session-1").size, 0);
  assert.equal(simulatorControlActions(easFake(new Error("eas exited 1")).eas, "session-1").size, 0);
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
