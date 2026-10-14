import assert from "node:assert/strict";
import { readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createBuildWorkspaceFixture } from "../helpers/build-workspace-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" });
}

test("export:web writes a static workspace payload and every referenced artifact", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const destination = join(fixture.root, "web-export");
  const result = run([
    "export:web",
    "--catalog", fixture.catalogPath,
    "--output", destination,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.builds.sort(), ["build-1.0.0", "build-2.0.0"]);

  const workspace = JSON.parse(await readFile(join(destination, "workspace.json"), "utf8"));
  assert.equal(workspace.catalog.contract, "expo.explore.build-catalog.v1");
  assert.equal(workspace.comparison.contract, "expo.explore.build-comparison.v1");
  let expected = 0;
  for (const [buildId, build] of Object.entries(workspace.builds)) {
    assert.ok(build.coverage, `coverage missing for ${buildId}`);
    for (const artifact of build.map.artifacts) {
      expected += 1;
      const copied = await stat(join(destination, "artifacts", buildId, artifact.path));
      assert.ok(copied.isFile(), `missing artifact copy: ${buildId}/${artifact.path}`);
    }
  }
  assert.equal(payload.artifacts, expected);

  const second = run([
    "export:web",
    "--catalog", fixture.catalogPath,
    "--output", destination,
  ]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr || second.stdout, /already exists/);
});

test("export:web refuses a build id that is not a safe path segment", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const evil = "../pwn";
  const rewrite = async (path) => {
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replaceAll("build-1.0.0", evil), "utf8");
  };
  await rewrite(fixture.catalogPath);
  await rewrite(join(fixture.root, "comparison.json"));
  await rewrite(join(fixture.root, "baseline", "screen-map.json"));
  const result = run([
    "export:web",
    "--catalog", fixture.catalogPath,
    "--output", join(fixture.root, "web-export"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /not usable as a path segment/);
});

test("export:web refuses an artifact that is a symlink out of the build root", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const baselineMap = JSON.parse(
    await readFile(join(fixture.root, "baseline", "screen-map.json"), "utf8"),
  );
  const linked = join(fixture.root, "baseline", baselineMap.artifacts[0].path);
  const outside = join(fixture.root, "outside-evidence.svg");
  await rename(linked, outside);
  await symlink(outside, linked);
  const result = run([
    "export:web",
    "--catalog", fixture.catalogPath,
    "--output", join(fixture.root, "web-export"),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /escapes build/);
});
