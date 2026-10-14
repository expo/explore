import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

export async function standaloneReportFixture() {
  const directory = await mkdtemp(join(tmpdir(), "expo-explore-report-"));
  const png = new PNG({ width: 32, height: 64 });
  png.data.fill(255);
  const bytes = PNG.sync.write(png);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, "capture.png");
  await writeFile(path, bytes);
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const entry = { id: "home", route: "/home", routeFile: "app/home.tsx", sourceFiles: [], provider: "expo-router", logicalPath: "/home", path: "/home",
    variant: "default", kind: "screen" };
  const publicReview = {
    contract: "explore.review",
    pullRequest: { repositoryId: "1", repository: "expo/example", number: 8,
      title: "Update home </script><script>window.reportInjection = true</script>",
      url: "https://github.com/expo/example/pull/8", base: { ref: "main", sha: baseSha },
      head: { ref: "feature/dynamic-home", sha: headSha } },
    mode: "all", createdAt: "2026-09-15T00:00:00.000Z", runId: "1", runAttempt: "1",
    runtime: { projectId: "eas-project", buildId: "eas-head", gitCommit: headSha },
    surfaces: [{ id: "home", status: "modified", base: { ...entry }, head: { ...entry },
      review: { status: "modified", description: "Home greeting changed", facts: [{
        category: "text", templateId: "text.changed", bullet: "Greeting changed from Hello to Welcome",
      }] },
      sourceChange: { contract: "expo.explore.source-change-summary.v1", baseSha, headSha, impact: "direct",
        summary: "Home greeting changed", truncated: false, files: [{ path: "app/home.tsx", status: "modified",
          relation: "route", hunks: [{ baseStart: 1, baseLines: 1, headStart: 1, headLines: 1 }], facts: [], truncated: false,
          patch: 'diff --git a/app/home.tsx b/app/home.tsx\n--- a/app/home.tsx\n+++ b/app/home.tsx\n@@ -1 +1 @@\n-<Text>Hello</Text>\n+<Text>Welcome</Text>\n',
        }] },
    }],
  };
  for (const side of ["base", "head"]) publicReview.surfaces[0][`${side}Image`] = {
    url: `https://embedded.expo-explore.invalid/${sha256}.png`, sha256, width: 32, height: 64,
    capturedAt: publicReview.createdAt, sourceCommit: publicReview.pullRequest[side].sha, buildId: `eas-${side}`,
  };
  for (const side of ["base", "head"]) publicReview.surfaces[0][`${side}Outcome`] = { status: "captured", attempts: 1, landing: "verified" };
  return { directory, publicReview, assets: [{ sha256, path }],
    onboarding: { repository: "expo/example", cloneUrl: "https://github.com/expo/example.git",
      head: { ...publicReview.pullRequest.head }, appDirectory: ".", packageManager: "npm" },
    bytes };
}
