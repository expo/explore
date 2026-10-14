import assert from "node:assert/strict";
import test from "node:test";
import { parseArtifactIdentity, publicViewerResponse } from "../src/server/public-viewer";

const origin = "https://explore-preview.expo.app";

test("the Viewer shell answers only the report page", () => {
  const html = '<!doctype html><script type="module" src="/viewer/assets/main.js"></script>';
  for (const path of ["/map?panel=live", "/map/home", "/screens", "/flows", "/graph", "/r/private-review",
    "/api/session", "/api/artifacts", "/api/public/unknown", "/not-found"]) {
    assert.equal(publicViewerResponse(new Request(origin + path), html).status, 404, path);
  }
});

test("the root and /r serve the staged Viewer for a linked run and a bare drop page, and reject partial identities", async () => {
  const html = '<script type="module" src="/viewer/assets/main.js"></script>';
  const query = "repo=Expo%2Fexplore&run=123&attempt=2&artifact=456";
  // The root is the report page; /r is its address in earlier pull-request comments.
  for (const page of ["/", "/r"]) for (const search of [`?${query}&screen=home&focus=modified&inspect=diff`, `?${query.replace("&artifact=456", "")}`, "", "?screen=home&panel=live"]) {
    const response = publicViewerResponse(new Request(`${origin}${page}${search}#selection`), html);
    assert.equal(response.status, 200, search);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const search of [`?${query}&run=5`, "?repo=expo%2Fexplore", "?run=123&attempt=2", `?${query.replace("run=123", "run=0123")}`,
    `?${query.replace("attempt=2", "attempt=-1")}`, `?${query.replace("artifact=456", "artifact=9007199254740993")}`,
    `?${query.replace("repo=Expo%2Fexplore", "repo=..%2Fexplore")}`, `?${query}&artifact=457`]) {
    assert.equal(publicViewerResponse(new Request(`${origin}/r${search}`), html).status, 400, search);
    assert.equal(publicViewerResponse(new Request(`${origin}/${search}`), html).status, 400, search);
  }
  assert.equal(publicViewerResponse(new Request(`${origin}/r?${query}`, { method: "POST" }), html).status, 404);
  assert.equal(publicViewerResponse(new Request(`${origin}/r/private-id`), html).status, 404);
  assert.deepEqual(parseArtifactIdentity(new URLSearchParams(`${query}&screen=home`)), { repo: "expo/explore", run: "123", attempt: "2", artifact: "456" });
  assert.deepEqual(parseArtifactIdentity(new URLSearchParams("repo=expo%2Fexplore&run=123&attempt=2")), { repo: "expo/explore", run: "123", attempt: "2" });
  assert.equal(parseArtifactIdentity(new URLSearchParams("screen=home")), undefined);
});
