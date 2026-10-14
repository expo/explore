import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { stderrProgress } = await tsImport("../../src/shared/progress.ts", import.meta.url);

test("progress lines carry the elapsed time since the first line was possible", () => {
  let now = 1_000;
  const written = [];
  const progress = stderrProgress({ now: () => now, write: text => written.push(text) });
  progress("planning");
  now += 125_000;
  progress("capturing");
  assert.deepEqual(written, ["[explore 00:00] planning\n", "[explore 02:05] capturing\n"]);
});
