import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" });
}

test("ci:report rejects obsolete catalog publication flags with an actionable failure", () => {
  const result = runCli(["ci:report", "--catalog", "old-build-catalog.json", "--output", "report"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown flag for ci:report: --catalog/);
  assert.equal(JSON.parse(result.stderr).diagnostic.code, "CLI_ARGUMENT_INVALID");
  assert.match(JSON.parse(result.stderr).diagnostic.nextAction, /Remove --catalog/);
});
