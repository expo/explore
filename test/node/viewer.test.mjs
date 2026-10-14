import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createBuildWorkspaceFixture } from "../helpers/build-workspace-fixture.mjs";
import { addCoverageGap, addScreen, createMapStore } from "../helpers/map-store-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const viewerRoot = join(root, "dist", "viewer");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function createMap(cwd) {
  await writeFile(join(cwd, "home.png"), png);
  await writeFile(join(cwd, "home.txt"), '@home [button] "Open settings" identifier=open-settings\n');
  const store = await createMapStore(cwd, "Viewer fixture");
  return {
    store,
    ...await addScreen(store, {
      id: "home",
      title: "Home",
      screenshotPath: join(cwd, "home.png"),
      snapshotPath: join(cwd, "home.txt"),
      start: true,
    }),
  };
}

async function requestStatus(url, headers) {
  return await new Promise((resolveStatus, rejectStatus) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode));
    });
    request.on("error", rejectStatus);
    request.end();
  });
}


test("serves a validated local map, bundled viewer, and whitelisted artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-viewer-"));
  const created = await createMap(cwd);
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({
    root: join(cwd, ".explore"),
    viewerRoot,
    port: 0,
  });
  try {
    const index = await fetch(viewer.url);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Expo Explore/);
    assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(index.headers.get("cross-origin-resource-policy"), "same-origin");
    const sessionCookie = index.headers.get("set-cookie")?.split(";", 1)[0];
    assert.match(sessionCookie, /^expo_explore_session_[a-f0-9]{16}=/);

    const unauthenticated = await fetch(new URL("api/map", viewer.url));
    assert.equal(unauthenticated.status, 401);

    const hostileHostStatus = await requestStatus(new URL("api/map", viewer.url), {
      Host: `attacker.example:${viewer.port}`,
      Cookie: sessionCookie,
    });
    assert.equal(hostileHostStatus, 403);

    const hostileOrigin = await fetch(new URL("api/map", viewer.url), {
      headers: { Cookie: sessionCookie, Origin: "http://attacker.example" },
    });
    assert.equal(hostileOrigin.status, 403);

    const response = await fetch(new URL("api/map", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(response.status, 200);
    const etag = response.headers.get("etag");
    assert.match(etag, /^"run-.+:\d+"$/);
    const payload = await response.json();
    assert.equal(payload.map.run.name, "Viewer fixture");
    assert.equal(payload.map.screens[0].title, "Home");
    assert.equal(payload.coverage.screens, 1);

    const unchanged = await fetch(new URL("api/map", viewer.url), {
      headers: { Cookie: sessionCookie, "If-None-Match": etag },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");

    const status = await fetch(new URL("api/status", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(status.status, 200);
    const statusPayload = await status.json();
    assert.equal(statusPayload.runId, payload.map.run.id);
    assert.equal(statusPayload.revision, payload.map.revision);
    assert.equal(statusPayload.coverage.screens, 1);

    await addCoverageGap(created.store, { message: "Viewer should observe an atomic map revision" });
    const changedStatus = await fetch(new URL("api/status", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    const changedStatusPayload = await changedStatus.json();
    assert.equal(changedStatusPayload.revision, payload.map.revision + 1);
    const changedMap = await fetch(new URL("api/map", viewer.url), {
      headers: { Cookie: sessionCookie, "If-None-Match": etag },
    });
    assert.equal(changedMap.status, 200);
    assert.notEqual(changedMap.headers.get("etag"), etag);
    assert.ok((await changedMap.json()).map.gaps.some((gap) =>
      gap.message === "Viewer should observe an atomic map revision",
    ));

    const artifact = payload.map.artifacts.find((item) => item.id === created.observation.screenshotArtifactId);
    const artifactUrl = new URL(`api/artifacts/${artifact.path}`, viewer.url);
    const artifactResponse = await fetch(artifactUrl, { headers: { Cookie: sessionCookie } });
    assert.equal(artifactResponse.status, 200);
    assert.equal(artifactResponse.headers.get("cache-control"), "private, no-cache");
    assert.equal(artifactResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await artifactResponse.arrayBuffer()), png);
    const versionedArtifactUrl = new URL(artifactUrl);
    versionedArtifactUrl.searchParams.set("sha256", artifact.sha256);
    const versionedArtifact = await fetch(versionedArtifactUrl, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(versionedArtifact.status, 200);
    assert.equal(
      versionedArtifact.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
    );
    const staleArtifactUrl = new URL(artifactUrl);
    staleArtifactUrl.searchParams.set("sha256", "0".repeat(64));
    const staleArtifact = await fetch(staleArtifactUrl, { headers: { Cookie: sessionCookie } });
    assert.equal(staleArtifact.status, 409);
    assert.match((await staleArtifact.json()).error, /content hash does not match/);
    const artifactHead = await fetch(artifactUrl, {
      method: "HEAD",
      headers: { Cookie: sessionCookie },
    });
    assert.equal(artifactHead.status, 200);
    assert.equal(artifactHead.headers.get("content-length"), String(png.length));
    assert.equal(await artifactHead.text(), "");

    const traversal = await fetch(new URL("api/artifacts/%2E%2E%2Fscreen-map.json", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(traversal.status, 404);

    // The viewer routes in the path, so a page request for any app route is the app shell —
    // with the session cookie, since the app boots from it.
    for (const path of ["screens?screen=settings", "map/(tabs)/settings/apps", "flows/"]) {
      const page = await fetch(new URL(path, viewer.url));
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get("content-type"), /text\/html/);
      assert.equal(page.headers.get("cache-control"), "no-store");
      assert.match(page.headers.get("set-cookie"), /^expo_explore_session_[a-f0-9]{16}=/);
      assert.match(await page.text(), /Expo Explore/);
    }
    const pageHead = await fetch(new URL("flows", viewer.url), { method: "HEAD" });
    assert.equal(pageHead.status, 200);
    assert.equal(await pageHead.text(), "");
    // A browser navigation to a dotted route still gets the app; an asset fetch does not.
    const dottedPage = await fetch(new URL("map/settings.v2", viewer.url), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    assert.equal(dottedPage.status, 200);
    assert.match(dottedPage.headers.get("content-type"), /text\/html/);
    const missingAsset = await fetch(new URL("assets/missing.js", viewer.url));
    assert.equal(missingAsset.status, 404);
    assert.match(missingAsset.headers.get("content-type"), /application\/json/);
    const missingEndpoint = await fetch(new URL("api/nope", viewer.url), {
      headers: { Cookie: sessionCookie, Accept: "text/html" },
    });
    assert.equal(missingEndpoint.status, 404);
    assert.match(missingEndpoint.headers.get("content-type"), /application\/json/);
  } finally {
    await viewer.close();
  }
});

test("keeps simultaneous loopback viewer sessions independent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-viewer-sessions-"));
  await createMap(cwd);
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const first = await startViewerServer({ root: join(cwd, ".explore"), viewerRoot, port: 0 });
  const second = await startViewerServer({ root: join(cwd, ".explore"), viewerRoot, port: 0 });
  try {
    const firstCookie = (await fetch(first.url)).headers.get("set-cookie")?.split(";", 1)[0];
    const secondCookie = (await fetch(second.url)).headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(firstCookie);
    assert.ok(secondCookie);
    assert.notEqual(firstCookie.split("=", 1)[0], secondCookie.split("=", 1)[0]);
    const browserCookieHeader = `${firstCookie}; ${secondCookie}`;
    assert.equal(
      (await fetch(new URL("api/map", first.url), { headers: { Cookie: browserCookieHeader } })).status,
      200,
    );
    assert.equal(
      (await fetch(new URL("api/map", second.url), { headers: { Cookie: browserCookieHeader } })).status,
      200,
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("reads the current map when a revision lands before the first API request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-viewer-first-refresh-"));
  const { store } = await createMap(cwd);
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({ root: join(cwd, ".explore"), viewerRoot, port: 0 });
  try {
    const write = await addCoverageGap(store, { message: "Written before the first viewer API request" });
    const sessionCookie = (await fetch(viewer.url)).headers.get("set-cookie")?.split(";", 1)[0];
    const payload = await (await fetch(new URL("api/map", viewer.url), {
      headers: { Cookie: sessionCookie },
    })).json();
    assert.equal(payload.map.revision, write.revision);
    assert.ok(payload.map.gaps.some((gap) => gap.message === "Written before the first viewer API request"));
  } finally {
    await viewer.close();
  }
});

test("revalidates cached and newly referenced evidence while the viewer is running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-viewer-live-evidence-"));
  const created = await createMap(cwd);
  const mapRoot = join(cwd, ".explore");
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({ root: mapRoot, viewerRoot, port: 0 });
  try {
    const sessionCookie = (await fetch(viewer.url)).headers.get("set-cookie")?.split(";", 1)[0];
    const initialResponse = await fetch(new URL("api/map", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    const initial = await initialResponse.json();
    const homeArtifact = initial.map.artifacts.find(
      (artifact) => artifact.id === created.observation.screenshotArtifactId,
    );
    await writeFile(join(mapRoot, homeArtifact.path), Buffer.alloc(homeArtifact.bytes, 0x61));
    const changedExisting = await fetch(new URL("api/status", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(changedExisting.status, 500);
    assert.match((await changedExisting.json()).error, /failed integrity validation/);

    await writeFile(join(mapRoot, homeArtifact.path), png);
    assert.equal((await fetch(new URL("api/status", viewer.url), {
      headers: { Cookie: sessionCookie },
    })).status, 200);

    await writeFile(join(cwd, "second.png"), png);
    const added = await addScreen(created.store, {
      id: "second",
      title: "Second",
      screenshotPath: join(cwd, "second.png"),
    });
    const currentMap = JSON.parse(await readFile(join(mapRoot, "screen-map.json"), "utf8"));
    const newArtifact = currentMap.artifacts.find(
      (artifact) => artifact.id === added.observation.screenshotArtifactId,
    );
    await writeFile(join(mapRoot, newArtifact.path), Buffer.alloc(newArtifact.bytes, 0x62));
    const changedNew = await fetch(new URL("api/status", viewer.url), {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(changedNew.status, 500);
    assert.match((await changedNew.json()).error, /failed integrity validation/);
  } finally {
    await viewer.close();
  }
});

test("refuses to start a viewer for corrupt runtime evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "expo-explore-viewer-corrupt-"));
  await createMap(cwd);
  const map = JSON.parse(await readFile(join(cwd, ".explore", "screen-map.json"), "utf8"));
  const screenshot = map.artifacts.find((artifact) => artifact.kind === "screenshot");
  await writeFile(join(cwd, ".explore", screenshot.path), "corrupted");
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  await assert.rejects(
    startViewerServer({ root: join(cwd, ".explore"), viewerRoot, port: 0 }),
    /failed integrity validation/,
  );
});

test("serves a two-build workspace with scoped evidence and a composite revision", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const reversedRelationship = {
    "one-to-one": "one-to-one",
    added: "removed",
    removed: "added",
    split: "merge",
    merge: "split",
  };
  const reversedStatus = {
    unchanged: "unchanged",
    modified: "modified",
    added: "removed",
    removed: "added",
  };
  const reverseComparison = {
    ...fixture.comparison,
    baselineBuildId: fixture.comparison.currentBuildId,
    currentBuildId: fixture.comparison.baselineBuildId,
    baselineRunId: fixture.comparison.currentRunId,
    currentRunId: fixture.comparison.baselineRunId,
    baselineRevision: fixture.comparison.currentRevision,
    currentRevision: fixture.comparison.baselineRevision,
    entries: fixture.comparison.entries.map((entry) => ({
      ...entry,
      relationship: reversedRelationship[entry.relationship],
      status: reversedStatus[entry.status],
      baselineScreenIds: entry.currentScreenIds,
      currentScreenIds: entry.baselineScreenIds,
      baselineRepresentativeObservationIds: entry.currentRepresentativeObservationIds,
      currentRepresentativeObservationIds: entry.baselineRepresentativeObservationIds,
      representativePairs: entry.representativePairs.map((pair) => ({
        ...pair,
        baselineObservationId: pair.currentObservationId,
        currentObservationId: pair.baselineObservationId,
      })),
    })),
  };
  const reverseComparisonPath = join(fixture.root, "reverse-comparison.json");
  await writeFile(
    reverseComparisonPath,
    `${JSON.stringify(reverseComparison, null, 2)}\n`,
    "utf8",
  );
  const catalogWithSecondaryComparison = await fixture.readCatalog();
  catalogWithSecondaryComparison.comparisons.push({
    baselineBuildId: "build-2.0.0",
    currentBuildId: "build-1.0.0",
    path: "reverse-comparison.json",
  });
  await writeFile(
    fixture.catalogPath,
    `${JSON.stringify(catalogWithSecondaryComparison, null, 2)}\n`,
    "utf8",
  );
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({
    root: fixture.currentRoot,
    catalog: fixture.catalogPath,
    viewerRoot,
    port: 0,
  });
  try {
    const sessionCookie = (await fetch(viewer.url)).headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(sessionCookie);
    const headers = { Cookie: sessionCookie };

    assert.equal((await fetch(new URL("api/workspace", viewer.url))).status, 401);
    assert.equal((await fetch(new URL("api/map", viewer.url), { headers })).status, 404);

    const initialResponse = await fetch(new URL("api/workspace", viewer.url), { headers });
    assert.equal(initialResponse.status, 200);
    const initialEtag = initialResponse.headers.get("etag");
    assert.match(initialEtag, /^"workspace-[a-f0-9]{64}"$/);
    const workspace = await initialResponse.json();
    assert.equal(workspace.catalog.currentBuildId, "build-2.0.0");
    assert.equal(workspace.catalog.defaultBaselineBuildId, "build-1.0.0");
    assert.equal(workspace.catalog.comparisons.length, 2);
    assert.deepEqual(Object.keys(workspace.builds).sort(), ["build-1.0.0", "build-2.0.0"]);
    assert.equal(workspace.builds["build-1.0.0"].map.run.id, fixture.baselineMap.run.id);
    assert.equal(workspace.builds["build-2.0.0"].map.run.id, fixture.currentMap.run.id);
    assert.equal(workspace.comparison.baselineBuildId, "build-1.0.0");
    assert.equal(workspace.comparison.currentBuildId, "build-2.0.0");

    const unchanged = await fetch(new URL("api/workspace", viewer.url), {
      headers: { ...headers, "If-None-Match": initialEtag },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");

    const statusResponse = await fetch(new URL("api/workspace/status", viewer.url), { headers });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("etag"), initialEtag);
    const status = await statusResponse.json();
    assert.equal(status.currentBuildId, "build-2.0.0");
    assert.equal(status.defaultBaselineBuildId, "build-1.0.0");
    assert.deepEqual(Object.keys(status.builds).sort(), ["build-1.0.0", "build-2.0.0"]);
    assert.equal(status.builds["build-1.0.0"].revision, fixture.baselineMap.revision);
    assert.equal(status.builds["build-2.0.0"].revision, fixture.currentMap.revision);
    assert.deepEqual(status.comparison, {
      baselineBuildId: "build-1.0.0",
      currentBuildId: "build-2.0.0",
      baselineRevision: fixture.baselineMap.revision,
      currentRevision: fixture.currentMap.revision,
    });

    const sharedArtifact = "artifacts/screenshots/shared-screen.svg";
    const baselineArtifactResponse = await fetch(new URL(
      `api/builds/build-1.0.0/artifacts/${sharedArtifact}`,
      viewer.url,
    ), { headers });
    const currentArtifactResponse = await fetch(new URL(
      `api/builds/build-2.0.0/artifacts/${sharedArtifact}`,
      viewer.url,
    ), { headers });
    assert.equal(baselineArtifactResponse.status, 200);
    assert.equal(currentArtifactResponse.status, 200);
    assert.equal(baselineArtifactResponse.headers.get("cache-control"), "private, no-cache");
    const currentArtifact = workspace.builds["build-2.0.0"].map.artifacts.find(
      (artifact) => artifact.path === sharedArtifact,
    );
    assert.ok(currentArtifact);
    const versionedCurrentUrl = new URL(
      `api/builds/build-2.0.0/artifacts/${sharedArtifact}`,
      viewer.url,
    );
    versionedCurrentUrl.searchParams.set("sha256", currentArtifact.sha256);
    const versionedCurrent = await fetch(versionedCurrentUrl, { headers });
    assert.equal(versionedCurrent.status, 200);
    assert.equal(
      versionedCurrent.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
    );
    const staleCurrentUrl = new URL(versionedCurrentUrl);
    staleCurrentUrl.searchParams.set("sha256", "0".repeat(64));
    const staleCurrent = await fetch(staleCurrentUrl, { headers });
    assert.equal(staleCurrent.status, 409);
    assert.match((await staleCurrent.json()).error, /content hash does not match/);
    const baselineBytes = Buffer.from(await baselineArtifactResponse.arrayBuffer());
    const currentBytes = Buffer.from(await currentArtifactResponse.arrayBuffer());
    assert.notDeepEqual(baselineBytes, currentBytes);
    assert.deepEqual(baselineBytes, await readFile(join(fixture.baselineRoot, sharedArtifact)));
    assert.deepEqual(currentBytes, await readFile(join(fixture.currentRoot, sharedArtifact)));

    const unknownBuild = await fetch(new URL(
      `api/builds/build-9.9.9/artifacts/${sharedArtifact}`,
      viewer.url,
    ), { headers });
    assert.equal(unknownBuild.status, 404);
    assert.match((await unknownBuild.json()).error, /Build not found/);
    const traversal = await fetch(new URL(
      "api/builds/build-1.0.0/artifacts/%2E%2E%2Fscreen-map.json",
      viewer.url,
    ), { headers });
    assert.equal(traversal.status, 404);

    const expectWorkspaceChange = async (previousEtag) => {
      const response = await fetch(new URL("api/workspace", viewer.url), {
        headers: { ...headers, "If-None-Match": previousEtag },
      });
      assert.equal(response.status, 200);
      const nextEtag = response.headers.get("etag");
      assert.match(nextEtag, /^"workspace-[a-f0-9]{64}"$/);
      assert.notEqual(nextEtag, previousEtag);
      await response.arrayBuffer();
      return nextEtag;
    };

    // This reverse comparison is cataloged and fully validated but is not the one returned in
    // the singular workspace payload. Its review evidence must still invalidate the workspace.
    const reverseAfterReview = JSON.parse(await readFile(reverseComparisonPath, "utf8"));
    reverseAfterReview.entries[0].rationale = "Non-selected review rationale changed";
    await writeFile(
      reverseComparisonPath,
      `${JSON.stringify(reverseAfterReview, null, 2)}\n`,
      "utf8",
    );
    const secondaryComparisonEtag = await expectWorkspaceChange(initialEtag);

    const comparisonAfterReview = await fixture.readComparison();
    comparisonAfterReview.entries[0].rationale = "Review rationale changed";
    await writeFile(
      fixture.comparisonPath,
      `${JSON.stringify(comparisonAfterReview, null, 2)}\n`,
      "utf8",
    );
    const comparisonEtag = await expectWorkspaceChange(secondaryComparisonEtag);

    const renamedCatalog = await fixture.readCatalog();
    renamedCatalog.name = "Renamed two-build fixture";
    await writeFile(fixture.catalogPath, `${JSON.stringify(renamedCatalog, null, 2)}\n`, "utf8");
    const catalogEtag = await expectWorkspaceChange(comparisonEtag);

    // Revision is the normal invalidation mechanism, but the response ETag covers the complete
    // workspace payload as a defense against an otherwise-valid manual file rewrite.
    const contentOnlyMapPath = join(fixture.currentRoot, "screen-map.json");
    const contentOnlyMap = JSON.parse(await readFile(contentOnlyMapPath, "utf8"));
    contentOnlyMap.run.name = "Content changed without a revision bump";
    await writeFile(contentOnlyMapPath, `${JSON.stringify(contentOnlyMap, null, 2)}\n`, "utf8");
    const contentOnlyEtag = await expectWorkspaceChange(catalogEtag);

    const baselineMap = JSON.parse(
      await readFile(join(fixture.baselineRoot, "screen-map.json"), "utf8"),
    );
    const comparisonAfterBaseline = await fixture.readComparison();
    const reverseAfterBaseline = JSON.parse(await readFile(reverseComparisonPath, "utf8"));
    baselineMap.revision += 1;
    comparisonAfterBaseline.baselineRevision = baselineMap.revision;
    reverseAfterBaseline.currentRevision = baselineMap.revision;
    await Promise.all([
      writeFile(
        join(fixture.baselineRoot, "screen-map.json"),
        `${JSON.stringify(baselineMap, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        fixture.comparisonPath,
        `${JSON.stringify(comparisonAfterBaseline, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        reverseComparisonPath,
        `${JSON.stringify(reverseAfterBaseline, null, 2)}\n`,
        "utf8",
      ),
    ]);
    const baselineEtag = await expectWorkspaceChange(contentOnlyEtag);

    const currentMap = JSON.parse(
      await readFile(join(fixture.currentRoot, "screen-map.json"), "utf8"),
    );
    const comparisonAfterCurrent = await fixture.readComparison();
    const reverseAfterCurrent = JSON.parse(await readFile(reverseComparisonPath, "utf8"));
    currentMap.revision += 1;
    comparisonAfterCurrent.currentRevision = currentMap.revision;
    reverseAfterCurrent.baselineRevision = currentMap.revision;
    await Promise.all([
      writeFile(
        join(fixture.currentRoot, "screen-map.json"),
        `${JSON.stringify(currentMap, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        fixture.comparisonPath,
        `${JSON.stringify(comparisonAfterCurrent, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        reverseComparisonPath,
        `${JSON.stringify(reverseAfterCurrent, null, 2)}\n`,
        "utf8",
      ),
    ]);
    await expectWorkspaceChange(baselineEtag);
  } finally {
    await viewer.close();
  }
});

test("refuses to follow a build artifact replaced by a symlink", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({
    root: fixture.currentRoot,
    catalog: fixture.catalogPath,
    viewerRoot,
    port: 0,
  });
  const relativePath = "artifacts/screenshots/shared-screen.svg";
  const artifactPath = join(fixture.currentRoot, relativePath);
  const originalBytes = await readFile(artifactPath);
  const outsidePath = join(fixture.root, "outside-identical.svg");
  try {
    const sessionCookie = (await fetch(viewer.url)).headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(sessionCookie);
    const headers = { Cookie: sessionCookie };
    const artifactUrl = new URL(
      `api/builds/build-2.0.0/artifacts/${relativePath}`,
      viewer.url,
    );
    assert.equal((await fetch(artifactUrl, { headers })).status, 200);

    // Even identical bytes may not be reached through a new filesystem link: the map bound
    // evidence to one validated regular file, not merely to content somewhere on disk.
    await writeFile(outsidePath, originalBytes);
    await unlink(artifactPath);
    await symlink(outsidePath, artifactPath);
    const swapped = await fetch(artifactUrl, { headers });
    assert.equal(swapped.status, 500);
    assert.match((await swapped.json()).error, /not a regular file|resolves outside|ELOOP/);
  } finally {
    await unlink(artifactPath).catch(() => undefined);
    await writeFile(artifactPath, originalBytes);
    await viewer.close();
  }
});

test("refuses an intermediate artifact directory replaced by an identical symlink tree", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({
    root: fixture.currentRoot,
    catalog: fixture.catalogPath,
    viewerRoot,
    port: 0,
  });
  const relativePath = "artifacts/screenshots/shared-screen.svg";
  const screenshotsPath = join(fixture.currentRoot, "artifacts", "screenshots");
  const originalPath = join(fixture.currentRoot, "artifacts", "screenshots-original");
  const outsidePath = join(fixture.root, "outside-identical-screenshots");
  let moved = false;
  try {
    const sessionCookie = (await fetch(viewer.url)).headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(sessionCookie);
    const headers = { Cookie: sessionCookie };
    const artifactUrl = new URL(
      `api/builds/build-2.0.0/artifacts/${relativePath}`,
      viewer.url,
    );
    assert.equal((await fetch(artifactUrl, { headers })).status, 200);

    await cp(screenshotsPath, outsidePath, { recursive: true });
    await rename(screenshotsPath, originalPath);
    moved = true;
    await symlink(outsidePath, screenshotsPath, "dir");

    const swapped = await fetch(artifactUrl, { headers });
    assert.equal(swapped.status, 500);
    assert.match(
      (await swapped.json()).error,
      /outside the artifact directory|no longer the validated file|not a regular file/,
    );
  } finally {
    await unlink(screenshotsPath).catch(() => undefined);
    if (moved) await rename(originalPath, screenshotsPath).catch(() => undefined);
    await rm(outsidePath, { recursive: true, force: true });
    await viewer.close();
  }
});

test("rejects a stale content-addressed artifact URL after same-path evidence changes", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const { startViewerServer } = await import(join(root, "dist", "map", "viewer-server.js"));
  const viewer = await startViewerServer({
    root: fixture.currentRoot,
    catalog: fixture.catalogPath,
    viewerRoot,
    port: 0,
  });
  try {
    const sessionCookie = (await fetch(viewer.url)).headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(sessionCookie);
    const headers = { Cookie: sessionCookie };
    const workspaceResponse = await fetch(new URL("api/workspace", viewer.url), { headers });
    const workspaceEtag = workspaceResponse.headers.get("etag");
    assert.ok(workspaceEtag);
    await workspaceResponse.arrayBuffer();
    const mapPath = join(fixture.currentRoot, "screen-map.json");
    const currentMap = JSON.parse(await readFile(mapPath, "utf8"));
    const artifact = currentMap.artifacts.find(
      (candidate) => candidate.path === "artifacts/screenshots/shared-screen.svg",
    );
    assert.ok(artifact);
    const oldHash = artifact.sha256;
    const oldUrl = new URL(
      `api/builds/build-2.0.0/artifacts/${artifact.path}`,
      viewer.url,
    );
    oldUrl.searchParams.set("sha256", oldHash);
    const before = await fetch(oldUrl, { headers });
    assert.equal(before.status, 200);
    assert.equal(before.headers.get("cache-control"), "private, max-age=31536000, immutable");

    const newBytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="60"><rect width="30" height="60" fill="#0f766e"/></svg>',
      "utf8",
    );
    const newHash = createHash("sha256").update(newBytes).digest("hex");
    artifact.sha256 = newHash;
    artifact.bytes = newBytes.length;
    const observation = currentMap.observations.find(
      (candidate) => candidate.screenshotArtifactId === artifact.id,
    );
    assert.ok(observation);
    observation.fingerprints.visual = newHash;
    currentMap.revision += 1;
    const comparison = await fixture.readComparison();
    comparison.currentRevision = currentMap.revision;
    await Promise.all([
      writeFile(join(fixture.currentRoot, artifact.path), newBytes),
      writeFile(mapPath, `${JSON.stringify(currentMap, null, 2)}\n`, "utf8"),
      writeFile(fixture.comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8"),
    ]);

    const refreshed = await fetch(new URL("api/workspace", viewer.url), {
      headers: { ...headers, "If-None-Match": workspaceEtag },
    });
    assert.equal(refreshed.status, 200);
    await refreshed.arrayBuffer();

    const stale = await fetch(oldUrl, { headers });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /content hash does not match/);
    const newUrl = new URL(oldUrl);
    newUrl.searchParams.set("sha256", newHash);
    const current = await fetch(newUrl, { headers });
    assert.equal(current.status, 200);
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), newBytes);
  } finally {
    await viewer.close();
  }
});

