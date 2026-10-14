import assert from "node:assert/strict";
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createBuildWorkspaceFixture } from "../helpers/build-workspace-fixture.mjs";

const { tsImport } = await import("tsx/esm/api");
const workspaceModel = await tsImport("../../src/map/build-workspace.ts", import.meta.url);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("uncertain comparison states preserve missing evidence without becoming Modified", async t => {
  for (const status of ["needs-review", "source-affected", "not-compared"]) {
    await t.test(status, async () => {
      const fixture = await createBuildWorkspaceFixture();
      const path = join(fixture.root, "comparison.json");
      const comparison = JSON.parse(await readFile(path, "utf8"));
      const entry = comparison.entries.find(entry => entry.relationship === "one-to-one");
      entry.status = status;
      entry.baselineRepresentativeObservationIds = [];
      entry.currentRepresentativeObservationIds = [];
      entry.representativePairs = [];
      await writeJson(path, comparison);
      const workspace = await workspaceModel.loadBuildWorkspace(fixture.catalogPath);
      assert.equal(workspace.comparison.entries.find(candidate => candidate.id === entry.id).status, status);
      entry.currentRepresentativeObservationIds = ["invented-observation"];
      await writeJson(path, comparison);
      await assert.rejects(workspaceModel.loadBuildWorkspace(fixture.catalogPath), /unknown/);
      entry.currentRepresentativeObservationIds = [];
      entry.status = "modified";
      await writeJson(path, comparison);
      await assert.rejects(workspaceModel.loadBuildWorkspace(fixture.catalogPath), /Invalid build comparison/);
    });
  }
});

test("one-sided source presence can retain a Needs review capture verdict", async t => {
  for (const relationship of ["added", "removed"]) {
    await t.test(relationship, async () => {
      const fixture = await createBuildWorkspaceFixture();
      const path = join(fixture.root, "comparison.json");
      const comparison = JSON.parse(await readFile(path, "utf8"));
      const entry = comparison.entries.find(entry => entry.relationship === relationship);
      entry.status = "needs-review";
      entry.baselineRepresentativeObservationIds = [];
      entry.currentRepresentativeObservationIds = [];
      await writeJson(path, comparison);
      const workspace = await workspaceModel.loadBuildWorkspace(fixture.catalogPath);
      assert.equal(workspace.comparison.entries.find(candidate => candidate.id === entry.id).status, "needs-review");
    });
  }
});

test("loads two independently valid maps and a complete reviewed comparison", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const workspace = await workspaceModel.loadBuildWorkspace(fixture.catalogPath);

  assert.equal(workspace.catalog.currentBuildId, "build-2.0.0");
  assert.equal(workspace.catalog.defaultBaselineBuildId, "build-1.0.0");
  assert.deepEqual([...workspace.builds.keys()], ["build-1.0.0", "build-2.0.0"]);
  assert.notEqual(
    workspace.builds.get("build-1.0.0")?.root,
    workspace.builds.get("build-2.0.0")?.root,
  );
  assert.equal(workspace.comparison.entries.length, 6);
  assert.deepEqual(
    new Set(workspace.comparison.entries.map((entry) => entry.relationship)),
    new Set(["one-to-one", "removed", "added", "split", "merge"]),
  );
  assert.equal(workspace.builds.get("build-1.0.0")?.coverage.screens, 6);
  assert.equal(workspace.builds.get("build-2.0.0")?.coverage.screens, 6);
});

test("rejects duplicate catalog identities and paths outside the catalog", async (t) => {
  await t.test("duplicate build id", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.builds[1].id = catalog.builds[0].id;
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /build id must be unique/,
    );
  });

  await t.test("escaping map directory", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.builds[0].mapDir = "../outside";
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /escapes the build catalog directory/,
    );
  });

  await t.test("symlinked map directory", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.builds[0].mapDir = "baseline-link";
    await symlink("baseline", join(fixture.root, "baseline-link"));
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /mapDir for build build-1\.0\.0 must not traverse symbolic links/,
    );
  });

  await t.test("map directory reached through an intermediate symlink", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.builds[0].mapDir = "root-link/baseline";
    await symlink(".", join(fixture.root, "root-link"));
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /mapDir for build build-1\.0\.0 must not traverse symbolic links/,
    );
  });

  await t.test("symlinked comparison file", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.comparisons[0].path = "comparison-link.json";
    await symlink("comparison.json", join(fixture.root, "comparison-link.json"));
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /comparison build-2\.0\.0 vs build-1\.0\.0 must not traverse symbolic links/,
    );
  });

  await t.test("symlinked catalog file", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const realCatalog = join(fixture.root, "catalog-real.json");
    await rename(fixture.catalogPath, realCatalog);
    await symlink("catalog-real.json", fixture.catalogPath);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /build catalog is not a regular file/,
    );
  });

  await t.test("current build cannot also be the baseline", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.defaultBaselineBuildId = catalog.currentBuildId;
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /must be different builds/,
    );
  });
});

test("rejects incomplete, conflicting, or wrong-side screen correspondence evidence", async (t) => {
  await t.test("uncovered canonical screen", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    comparison.entries = comparison.entries.filter((entry) => entry.id !== "added-card");
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /current screen is not resolved by any comparison entry: current-added/,
    );
  });

  await t.test("screen owned by two comparison entries", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    const removed = comparison.entries.find((entry) => entry.id === "removed-legacy");
    removed.baselineScreenIds.push("shared-home");
    removed.baselineRepresentativeObservationIds.push(
      "observation-build-1.0.0-shared-home-primary",
    );
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /baseline screen shared-home appears in both entries/,
    );
  });

  await t.test("representative observation from the other build", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    const updated = comparison.entries.find((entry) => entry.id === "updated-profile");
    updated.baselineRepresentativeObservationIds = [
      "observation-build-2.0.0-current-profile-reviewed",
    ];
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /baseline representative observation is unknown/,
    );
  });

  await t.test("split pair omits one current screen", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    const split = comparison.entries.find((entry) => entry.id === "split-settings");
    split.representativePairs[1] = { ...split.representativePairs[0] };
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /current screen is absent from representative pairs: current-split-b/,
    );
  });

  await t.test("status contradicts relationship cardinality", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    const added = comparison.entries.find((entry) => entry.id === "added-card");
    added.status = "modified";
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /Invalid build comparison schema/,
    );
  });

  await t.test("change summary must contain visible text when present", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    comparison.entries[0].changeSummary = "   ";
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /Invalid build comparison schema/,
    );
  });
});

test("rejects stale comparison revisions and corrupt evidence in either build", async (t) => {
  await t.test("catalog build label does not match map provenance", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.builds[0].version = "9.9.9";
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /run\.build\.version 1\.0\.0 does not match catalog version 9\.9\.9/,
    );
  });

  await t.test("catalog build id does not match map provenance", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const catalog = await fixture.readCatalog();
    catalog.builds[0].id = "build-baseline";
    catalog.defaultBaselineBuildId = "build-baseline";
    catalog.comparisons[0].baselineBuildId = "build-baseline";
    await writeJson(fixture.catalogPath, catalog);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /run\.build\.id build-1\.0\.0 does not match the catalog descriptor/,
    );
  });

  await t.test("stale current revision", async () => {
    const fixture = await createBuildWorkspaceFixture();
    const comparison = await fixture.readComparison();
    comparison.currentRevision += 1;
    await writeJson(fixture.comparisonPath, comparison);
    await assert.rejects(
      workspaceModel.loadBuildWorkspace(fixture.catalogPath),
      /currentRevision .* does not match map/,
    );
  });

  for (const side of ["baseline", "current"]) {
    await t.test(`corrupt ${side} screenshot`, async () => {
      const fixture = await createBuildWorkspaceFixture();
      const map = side === "baseline" ? fixture.baselineMap : fixture.currentMap;
      const root = side === "baseline" ? fixture.baselineRoot : fixture.currentRoot;
      await writeFile(join(root, map.artifacts[0].path), "corrupt", "utf8");
      await assert.rejects(
        workspaceModel.loadBuildWorkspace(fixture.catalogPath),
        new RegExp(`Invalid map for build build-${side === "baseline" ? "1" : "2"}\\.0\\.0:.*failed integrity validation`),
      );
    });
  }
});

test("fixture uses colliding artifact paths with distinct bytes", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const path = "artifacts/screenshots/shared-screen.svg";
  const baseline = await readFile(join(fixture.baselineRoot, path));
  const current = await readFile(join(fixture.currentRoot, path));
  assert.notDeepEqual(baseline, current);
});
