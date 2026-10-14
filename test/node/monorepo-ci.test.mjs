import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAppDirectory } from "../../dist/report/artifact.js";
import { readSourceSnapshot } from "../../dist/source/capture-plan.js";
import { readTwoDotSourceChanges } from "../../dist/source/git-diff.js";
import { buildVerifiedPlan } from "../../dist/ci/verified-plan.js";

test("a workspace app resolves its repository directory and reads exact app-relative source blobs", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-monorepo-ci-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const app = join(root, "apps/mobile");
  await mkdir(join(app, "app"), { recursive: true });
  await mkdir(join(root, "packages/shared"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "mobile" }));
  await writeFile(join(app, "app/index.tsx"), "export default 1;\n");
  await writeFile(join(app, "app/settings.tsx"), "export default function Settings() { return null; }\n");
  await writeFile(join(root, "packages/shared/theme.ts"), "export const color = 'red';\n");
  git("init", "-q", "-b", "main"); git("config", "user.name", "Explore tests"); git("config", "user.email", "test@example.invalid");
  git("add", "."); git("commit", "-qm", "base"); const baseSha = git("rev-parse", "HEAD");
  await writeFile(join(app, "app/index.tsx"), "export default 2;\n");
  await writeFile(join(root, "packages/shared/theme.ts"), "export const color = 'blue';\n");
  git("add", "."); git("commit", "-qm", "head"); const headSha = git("rev-parse", "HEAD");
  assert.equal(await readAppDirectory(app), "apps/mobile");
  const baseFiles = readSourceSnapshot(app, baseSha); const headFiles = readSourceSnapshot(app, headSha);
  assert.equal(baseFiles.get("apps/mobile/app/index.tsx"), "export default 1;\n");
  assert.equal(headFiles.get("apps/mobile/app/index.tsx"), "export default 2;\n");
  const changedFiles = readTwoDotSourceChanges({ cwd: app, baseSha, headSha });
  assert.deepEqual(changedFiles, [{ status: "modified", path: "app/index.tsx" }]);
  const repositoryChanges = readTwoDotSourceChanges({ cwd: app, baseSha, headSha, relativeToProject: false });
  assert.deepEqual(repositoryChanges.map(change => change.path), ["apps/mobile/app/index.tsx", "packages/shared/theme.ts"]);
  const plan = await buildVerifiedPlan({ baseProject: app, headProject: app, baseSha, headSha,
    config: { mode: "deterministic", app: { platform: "ios", bundleId: "example.mobile", easProfile: "simulator" },
      navigation: { provider: "expo-router" }, device: { name: "iPhone" }, exploration: { scope: "changes" },
      capture: { maxMinutes: 5, maxActions: 5 } }, output: join(root, "plan-output") });
  assert.equal(plan.conservative, true);
  assert.deepEqual(plan.surfaces.filter(surface => surface.headCapture).map(surface => surface.headSurface.path).sort(),
    ["/", "/settings"], "outside-app runtime edits cannot silently skip unrelated source-derived app routes");
  assert.ok(plan.surfaces.every(surface => surface.headSurface.routeFile.startsWith("app/")));
});
