import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const sourceModel = await tsImport(
  "../../viewer/src/utils/static-source.ts",
  import.meta.url,
);

test("runtime workspace parameters override build defaults and derive sibling artifacts", () => {
  const source = sourceModel.resolveStaticViewerSource(
    "https://viewer.example/map?workspace=https%3A%2F%2Fcdn.example%2Fruns%2F42%2Fworkspace.json",
    {
      workspaceUrl: "/demo/workspace.json",
      artifactBaseUrl: "/demo/artifacts",
    },
  );

  assert.deepEqual(source, {
    mode: "static",
    workspaceUrl: "https://cdn.example/runs/42/workspace.json",
    artifactBaseUrl: "https://cdn.example/runs/42/artifacts/",
  });
});

test("runtime source parameters resolve relative to the opening viewer URL", () => {
  const source = sourceModel.resolveStaticViewerSource(
    "https://viewer.example/explore/map?workspace=./data/workspace.json&artifacts=./evidence",
  );

  assert.deepEqual(source, {
    mode: "static",
    workspaceUrl: "https://viewer.example/explore/data/workspace.json",
    artifactBaseUrl: "https://viewer.example/explore/evidence/",
  });
});

test("canonical viewer routes retain absolute runtime source parameters", () => {
  const source = sourceModel.resolveStaticViewerSource(
    "https://viewer.example/explore/map?workspace=./data/workspace.json",
  );
  const route = sourceModel.withStaticSourceParameters("/screens?baseline=main-123", source);
  const parsed = new URL(route, "https://viewer.example");

  assert.equal(parsed.pathname, "/screens");
  assert.equal(parsed.searchParams.get("baseline"), "main-123");
  assert.equal(
    parsed.searchParams.get("workspace"),
    "https://viewer.example/explore/data/workspace.json",
  );
  assert.equal(
    parsed.searchParams.get("artifacts"),
    "https://viewer.example/explore/data/artifacts/",
  );
});

test("static artifact URLs qualify builds and encode each path segment", () => {
  const source = sourceModel.resolveStaticViewerSource(
    "https://viewer.example/map?workspace=/runs/42/workspace.json&artifacts=https%3A%2F%2Fcdn.example%2Fevidence",
  );
  assert.equal(
    sourceModel.staticArtifactUrl(
      "artifacts/screenshots/Account & profile.svg",
      "a".repeat(64),
      "pr 42+abc",
      source,
    ),
    `https://cdn.example/evidence/pr%2042%2Babc/artifacts/screenshots/Account%20%26%20profile.svg?sha256=${"a".repeat(64)}`,
  );
});

test("invalid runtime sources fail closed with a useful configuration error", () => {
  const cases = [
    ["https://viewer.example/map?workspace=javascript%3Aalert(1)", /must use http or https/],
    ["https://viewer.example/map?workspace=%2Fa&workspace=%2Fb", /may appear only once/],
    ["https://viewer.example/map?artifacts=%2Fevidence", /requires a workspace/],
    ["https://viewer.example/map?workspace=%2Fworkspace.json&artifacts=%2Fevidence%3Ftoken%3Dx", /without a query string/],
  ];

  for (const [url, expected] of cases) {
    const source = sourceModel.resolveStaticViewerSource(url);
    assert.equal(source.mode, "invalid");
    assert.match(source.error, expected);
  }
});
