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
