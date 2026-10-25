import assert from "node:assert/strict";
import test from "node:test";
import { enableProgramStatus, lastReportedStatus, programStatusSequence, reportFinished, reportStatus, terminalReportsStatus } from "../../dist/shared/program-status.js";
import { stderrProgress } from "../../dist/shared/progress.js";

const decode = sequence => {
  assert.match(sequence, /^\x1b\]7501;.*\x1b\\$/);
  return Object.fromEntries(sequence.slice(7, -2).split(":").map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
};
const message = sequence => {
  const { msg } = decode(sequence);
  return msg === undefined ? undefined : Buffer.from(msg, "base64").toString("utf8");
};

test("a report names the state and the app, and carries its message as base64", () => {
  assert.equal(programStatusSequence("done"), "\x1b]7501;state=done:app=expo-explore\x1b\\");
  const pairs = decode(programStatusSequence("working", { message: "capturing Home — ✓" }));
  assert.equal(pairs.state, "working");
  assert.equal(Buffer.from(pairs.msg, "base64").toString("utf8"), "capturing Home — ✓");
});

test("only a blocked report carries its kind", () => {
  assert.equal(decode(programStatusSequence("blocked", { kind: "question" })).kind, "question");
  assert.equal(decode(programStatusSequence("working", { kind: "question" })).kind, undefined);
});

test("a message becomes one line without control characters, within the spec's size", () => {
  const pairs = decode(programStatusSequence("error", { message: "build failed\n\x1b[31mexit 1\x1b[0m\t" }));
  assert.equal(Buffer.from(pairs.msg, "base64").toString("utf8"), "build failed [31mexit 1 [0m");
  assert.ok(Buffer.from(decode(programStatusSequence("working", { message: "あ".repeat(5000) })).msg, "base64").byteLength <= 2048);
  // Cut by code points: an emoji at the limit is kept whole or dropped, never halved.
  assert.equal(message(programStatusSequence("working", { message: `${"a".repeat(511)}😀😀` })), `${"a".repeat(511)}😀`);
  assert.ok(Buffer.from(decode(programStatusSequence("working", { message: "😀".repeat(5000) })).msg, "base64").byteLength <= 2048);
  assert.equal(decode(programStatusSequence("working", { message: " \n " })).msg, undefined);
  assert.ok(programStatusSequence("working", { message: "x".repeat(5000) }).length <= 4096);
});

test("a message is redacted as stderr's diagnostics are", () => {
  const environment = { EXPO_TOKEN: "expo-secret-value", SIGNING_PRIVATE_KEY: "private-key-value" };
  const text = message(programStatusSequence("error", {
    message: "git failed: https://user:ghp_abcdefghijklmnop@github.com/o/r expo-secret-value private-key-value",
  }, environment));
  assert.doesNotMatch(text, /ghp_|expo-secret-value|private-key-value/);
  assert.match(text, /\[REDACTED\]/);
});

test("only an interactive stderr that is not a dumb terminal or CI gets reports", () => {
  assert.equal(terminalReportsStatus({ isTTY: true }, { TERM: "xterm-ghostty" }), true);
  assert.equal(terminalReportsStatus({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(terminalReportsStatus({ isTTY: true }, { TERM: "xterm-256color", CI: "true" }), false);
  assert.equal(terminalReportsStatus({ isTTY: false }, {}), false);
  assert.equal(terminalReportsStatus({}, {}), false);
});

test("progress lines become the working status once reports are on", () => {
  const written = [];
  stderrProgress({ write: () => {} })("before");
  enableProgramStatus({ write: text => written.push(text) });
  stderrProgress({ write: () => {} })("planning routes");
  reportStatus("done");
  assert.deepEqual(written.map(decode).map(({ state, msg }) => [state, msg && Buffer.from(msg, "base64").toString("utf8")]),
    [["working", "planning routes"], ["done", undefined]]);
  assert.equal(lastReportedStatus(), "done");
});

test("a finished command reports done, or error once it has set a failing exit code", t => {
  const written = [];
  enableProgramStatus({ write: text => written.push(text) });
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  process.exitCode = undefined;
  reportFinished();
  process.exitCode = 1;
  reportFinished("No report for ios");
  assert.deepEqual(written.map(text => [decode(text).state, message(text)]), [["done", undefined], ["error", "No report for ios"]]);
});
