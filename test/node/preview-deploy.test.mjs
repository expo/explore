import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareCaptureReview } from "../../dist/review/capture-review.js";
import { createSourceCapturePlan } from "../../dist/source/capture-plan.js";
import { writeCiReportInput, exportCiReport } from "../../dist/report/artifact.js";
import { collectPlatformReports, deployExplorationReport, deployFixturePreview, deployLocalReports, deployPreview, previewProjectSlug, readReportZip, sealReport, whoamiAccounts, zipReportDirectory } from "../../dist/report/preview-deploy.js";
import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { ZipReader, Uint8ArrayReader, TextWriter, configure } from "@zip.js/zip.js";
import { viewerLinks } from "../../dist/report/viewer-links.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const pr = { repositoryId: "123", repository: "expo/explore-playground", number: 1,
  title: "</script><script>throw 1</script>", url: "https://github.com/expo/explore-playground/pull/1",
  base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/dynamic-branch", sha: "b".repeat(40) } };
const artifactUrl = "https://github.com/expo/explore-playground/actions/runs/10/artifacts/20";
const environment = { GITHUB_TOKEN: "test-token", GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: pr.repository };

async function fixture(t, { verified = true, preview = { hosting: "eas", expiresAfterDays: 7 }, presentation = pr } = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-artifact-ci-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([["app/index.tsx", "export default function Home() { return null; }"]]);
  const plan = createSourceCapturePlan({ baseSha: pr.base.sha, headSha: pr.head.sha,
    baseFiles: files, headFiles: files, changedFiles: [], mode: "all" });
  const id = plan.surfaces[0].id;
  plan.surfaces[0].sourceChange = { contract: "expo.explore.source-change-summary.v1", baseSha: pr.base.sha,
    headSha: pr.head.sha, impact: "none", summary: "No source changes.", files: [], truncated: false };
  for (const side of ["base", "head"]) {
    const directory = join(root, side); await mkdir(directory); await writeFile(join(directory, "home.png"), png);
    await writeFile(join(directory, "bundle.json"), JSON.stringify({ contract: "explore.bundle",
      side, gitCommit: pr[side].sha, easBuildId: "build", easProjectId: "project", profile: "explore:bundle", selectedSurfaceIds: [id],
      images: { [id]: { path: "home.png", sha256, width: 1, height: 1, sourceCommit: pr[side].sha,
        buildId: "build", capturedAt: "2026-09-15T00:00:00Z" } },
      outcomes: { [id]: { status: "captured", attempts: 1, landing: verified ? "verified" : "unverified" } } }));
  }
  const prepared = await prepareCaptureReview({ plan, pullRequest: presentation, baseDirectory: join(root, "base"),
    headDirectory: join(root, "head"), runId: "10", runAttempt: "1", assertCurrentHead: async () => {},
    ...(verified ? { assessments: { [id]: { review: { status: "unchanged", description: "No visible change" } } } } : {}) });
  const inputPath = join(root, "report-input.json");
  await writeCiReportInput({ inputPath, publicReview: prepared.review, assets: prepared.assets,
    commentState: { phase: "capturing", pullRequest: presentation, mode: "all", executionMode: "deterministic", configPath: ".expo-explore/config.yaml",
      startedAt: 1, updatedAt: 2, artifactOnly: true,
      links: viewerLinks({ repository: pr.repository, headSha: pr.head.sha, runId: "10", runAttempt: "1", configPath: ".expo-explore/config.yaml" }) },
    ...(preview ? { preview } : {}) });
  return { root, inputPath, prepared };
}

configure({ useWebWorkers: false });
const TOKEN_RE = /^[a-z2-7]{32}$/;

async function exportFixture(t, options) {
  const { root, inputPath } = await fixture(t, options);
  const reportPath = join(root, "report");
  await exportCiReport({ inputPath, outputPath: reportPath });
  const exportPath = join(root, "export");
  await mkdir(join(exportPath, "client/viewer"), { recursive: true });
  await mkdir(join(exportPath, "server/_expo"), { recursive: true });
  await writeFile(join(exportPath, "client/viewer/index.html"), "<!doctype html>");
  await writeFile(join(exportPath, "server/_expo/routes.json"), "{}");
  return { root, inputPath, reportPath, exportPath };
}

/** A fake EAS CLI plus a fake deployment: `deploy` captures the sealed report and .env, then serves them like the Worker would. */
function easFixture({ origin = "https://acme-explore--1lcbdcpwn3.expo.app", aliasOrigin = "https://acme-explore--bluesky.expo.app", accounts = ["brent-org"], failDeploy = false, aliasServes = true, existingComment } = {}) {
  let deploys = 0;
  let latestComment = existingComment;
  const calls = []; const captured = {};
  const run = (node, [bin, ...args], options) => {
    calls.push({ node, command: bin.split("/").at(-1), args: [...args], cwd: options.cwd, env: options.env });
    if (args[0] === "whoami") return { status: 0, stdout: `Devin (robot) (authenticated using EXPO_TOKEN)\nAccounts:\n${accounts.map(account => `• ${account} (Role: Developer)`).join("\n")}\n`, stderr: "" };
    if (args[0] === "init") {
      captured.appJson = JSON.parse(readFileSyncUtf8(join(options.cwd, "app.json")));
      captured.packageJson = JSON.parse(readFileSyncUtf8(join(options.cwd, "package.json")));
      return { status: 0, stdout: JSON.stringify({ id: "6dbf981e" }), stderr: "" };
    }
    if (args[0] === "deploy") {
      deploys += 1;
      if (failDeploy === "alias-limit") return { status: 1, stdout: "", stderr: "✔ Created deployment\n✖ Failed to assign pr-7 alias to deployment\nThis account has reached the limit of 5 aliases from the Free plan. Upgrade your plan to raise the limit on the amount of aliases you can create for your deployments. https://expo.dev/accounts/acme/settings/billing\nRequest ID: 341b47a1\n    Error: GraphQL request failed." };
      if (failDeploy === true || deploys <= failDeploy) return { status: 1, stdout: "", stderr: "Error: GraphQL request failed.\n    Upload failed" };
      captured.env = Object.fromEntries(readFileSyncUtf8(join(options.cwd, ".env")).trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
      captured.listing = captured.env.EXPLORE_PREVIEW_REPORTS ? JSON.parse(captured.env.EXPLORE_PREVIEW_REPORTS) : [{ platform: "ios", path: captured.env.EXPLORE_PREVIEW_REPORT }];
      captured.sealedFiles = Object.fromEntries(captured.listing.map(entry => [entry.path, readFileSyncBytes(join(options.cwd, "dist", "client", entry.path))]));
      captured.sealed = captured.sealedFiles[captured.listing[0].path];
      captured.hasViewer = existsSyncLocal(join(options.cwd, "dist", "client", "viewer", "index.html"));
      const alias = args.includes("--alias") ? args[args.indexOf("--alias") + 1] : undefined;
      captured.alias = alias;
      const aliases = alias ? [{ id: "al1", url: aliasOrigin, name: alias }] : undefined;
      return { status: 0, stdout: `${JSON.stringify({ dashboardUrl: "https://expo.dev/projects/x/hosting/deployments", identifier: "1lcbdcpwn3", url: origin, ...(aliases ? { aliases } : {}) })}\n`, stderr: "" };
    }
    throw new Error(`Unexpected eas ${args.join(" ")}`);
  };
  const requests = [];
  const transport = async (input, options = {}) => {
    const url = new URL(input); requests.push({ url, options });
    // An alias that has not moved to the new deployment yet: it answers for an earlier token, so this one is 404.
    if (!aliasServes && url.origin === aliasOrigin) return new Response("Not found", { status: 404 });
    if (url.origin === origin || (captured.alias && url.origin === aliasOrigin)) {
      const match = /^\/p\/([a-z2-7]{32})(?:\/(report\.zip|reports\.json|api\/v1))?$/.exec(url.pathname);
      if (!captured.env || !match || match[1] !== captured.env.EXPLORE_PREVIEW_TOKEN) return new Response("Not found", { status: 404 });
      // The token page negotiates like the real Worker: only a request that asks for HTML gets the shell.
      if (!match[2]) return (options.headers?.accept ?? "").includes("text/html")
        ? new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("# Expo Explore report", { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
      if (match[2] === "api/v1") return new Response(JSON.stringify({ kind: "pr-review" }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      if (match[2] === "reports.json") return new Response(JSON.stringify(captured.listing.map(({ path: _path, ...rest }) => rest)), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      // Selection as the Worker does it: ?target= by id, ?platform= by id and then by platform, else the first.
      const target = url.searchParams.get("target"), platform = url.searchParams.get("platform");
      const entry = target ? captured.listing.find(candidate => candidate.target === target)
        : platform ? captured.listing.find(candidate => candidate.target === platform) ?? captured.listing.find(candidate => candidate.platform === platform) : captured.listing[0];
      if (!entry) return new Response("Not found", { status: 404 });
      const key = Buffer.from(captured.env.EXPLORE_PREVIEW_KEY, "base64"); const sealed = Buffer.from(captured.sealedFiles[entry.path]);
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from("expo-explore-preview/1")); decipher.setAuthTag(sealed.subarray(-16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]);
      return new Response(plain, { status: 200, headers: { "content-type": "application/zip" } });
    }
    const artifactNames = { 20: "explore-review-10-1", 21: "explore-review-10-1-ios", 22: "explore-review-10-1-android" };
    const byId = /\/actions\/artifacts\/(\d+)$/.exec(url.pathname);
    if (byId && artifactNames[byId[1]]) return Response.json({ id: Number(byId[1]), name: artifactNames[byId[1]], expired: false, workflow_run: { id: 10 } });
    if (url.pathname.endsWith("/actions/runs/10/artifacts")) {
      const wanted = url.searchParams.get("name");
      return Response.json({ artifacts: Object.entries(artifactNames).filter(([, name]) => name === wanted).map(([id, name]) => ({ id: Number(id), name, expired: false })) });
    }
    if (url.pathname.endsWith("/actions/runs/10/attempts/1")) return Response.json({ id: 10, run_attempt: 1, status: "in_progress", conclusion: null });
    if (url.pathname.endsWith("/pulls/1")) return Response.json({ state: "open", base: pr.base, head: { ...pr.head, repo: { full_name: pr.repository } } });
    if (url.pathname.endsWith("/issues/1/comments") && options.method === "POST") { latestComment = JSON.parse(options.body).body; return Response.json({ id: 100 }); }
    if (url.pathname.endsWith("/issues/1/comments")) return Response.json(latestComment === undefined ? [] : [{ id: 100, body: latestComment, user: { login: "github-actions[bot]" } }]);
    if (url.pathname.endsWith("/issues/comments/100") && options.method === "PATCH") { latestComment = JSON.parse(options.body).body; return Response.json({ id: 100 }); }
    throw new Error(`Unexpected request ${url}`);
  };
  return { run, transport, calls, requests, captured };
}

import { readFileSync, existsSync } from "node:fs";
const readFileSyncUtf8 = path => readFileSync(path, "utf8");
const readFileSyncBytes = path => new Uint8Array(readFileSync(path));
const existsSyncLocal = path => existsSync(path);
const deployEnvironment = { ...environment, EXPO_TOKEN: "expo-test-token" };

test("ci:deploy seals the exact report, deploys it with the preview export, verifies the gate, and links Explore report", async t => {
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  const eas = easFixture(); const secrets = [];
  const now = Date.parse("2026-09-11T03:07:00Z");
  const result = await deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: eas.transport,
    run: eas.run, now: () => now, onSecret: secret => secrets.push(secret), verifyTimeoutMs: 1 });
  assert.deepEqual(eas.calls.map(call => call.args[0]), ["whoami", "init", "deploy"]);
  assert.ok(eas.calls.every(call => call.node === process.execPath && call.command === "eas" && call.env.EXPO_TOKEN === "expo-test-token" && call.env.CI === "1"));
  assert.deepEqual(eas.calls[1].args, ["init", "--force", "--non-interactive", "--json"]);
  assert.deepEqual(eas.calls[2].args, ["deploy", "--json", "--non-interactive", "--export-dir", "dist"]);
  assert.deepEqual(eas.captured.appJson, { expo: { name: "explore-playground-explore", slug: "explore-playground-explore", owner: "brent-org", web: { output: "server" } } });
  assert.equal(eas.captured.packageJson.private, true);
  assert.ok(eas.captured.hasViewer, "the preview export ships with the deployment");
  const token = eas.captured.env.EXPLORE_PREVIEW_TOKEN;
  assert.match(token, TOKEN_RE); assert.deepEqual(secrets, [token]);
  assert.equal(Buffer.from(eas.captured.env.EXPLORE_PREVIEW_KEY, "base64").length, 32);
  assert.equal(eas.captured.env.EXPLORE_PREVIEW_EXPIRES_AT, "2026-09-18T03:07:00.000Z");
  assert.match(eas.captured.env.EXPLORE_PREVIEW_REPORT, /^\/_report\/[a-z2-7]{16}\/report\.zip\.enc$/);
  assert.equal(result.previewUrl, `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`);
  assert.deepEqual([result.project, result.owner, result.deploymentId, result.expiresAt], ["explore-playground-explore", "brent-org", "1lcbdcpwn3", "2026-09-18T03:07:00.000Z"]);
  const zip = await zipReportDirectory(reportPath);
  assert.equal(result.reportSha256, createHash("sha256").update(zip).digest("hex"));
  assert.equal(result.reportBytes, zip.byteLength);
  const sealed = eas.captured.sealed;
  assert.equal(sealed.byteLength, zip.byteLength + 12 + 16, "iv || ciphertext || tag, nothing else");
  assert.ok(!Buffer.from(sealed).includes(Buffer.from("review.json")), "the static file is ciphertext");
  // Verification hit the gate and its negatives before the comment was published.
  const previewPaths = eas.requests.filter(request => request.url.origin === "https://acme-explore--1lcbdcpwn3.expo.app").map(request => request.url.pathname);
  const wrong = token.endsWith("a") ? `${token.slice(0, -1)}b` : `${token.slice(0, -1)}a`;
  assert.deepEqual(previewPaths, [`/p/${token}`, `/p/${token}/api/v1`, `/p/${token}/report.zip`, "/", `/p/${wrong}`, `/p/${wrong}/report.zip`, `/p/${token}/viewer/index.html`]);
  assert.ok(eas.requests.every(request => request.url.origin !== "https://acme-explore--1lcbdcpwn3.expo.app" || request.options.cache === "no-store"));
  const posted = eas.requests.find(request => request.options.method === "POST");
  const body = JSON.parse(posted.options.body).body;
  assert.match(body, new RegExp(`\\| \\[Open\\]\\(<https://acme-explore--1lcbdcpwn3\\.expo\\.app/p/${token}>\\) \\|`));
  assert.match(body, /Preview links work until Sep 18, 2026 \(UTC\) for anyone who has them\./);
  assert.doesNotMatch(body, /explore-preview\.expo\.app\/\?/);
  assert.ok(eas.requests.indexOf(posted) > eas.requests.findIndex(request => request.url.pathname === `/p/${token}/viewer/index.html`), "publish after verification");
});

test("the report ZIP is deterministic and mirrors the GitHub artifact layout", async t => {
  const { reportPath } = await exportFixture(t);
  const first = await zipReportDirectory(reportPath); const second = await zipReportDirectory(reportPath);
  assert.deepEqual(first, second);
  const reader = new ZipReader(new Uint8ArrayReader(first));
  const entries = await reader.getEntries();
  assert.deepEqual(entries.map(entry => entry.filename).sort(), ["assets/" + sha256 + ".png", "review.json"]);
  const review = JSON.parse(await entries.find(entry => entry.filename === "review.json").getData(new TextWriter()));
  assert.equal(review.kind, "explore.report");
  const videoName = "assets/" + "e".repeat(64) + ".mp4";
  await writeFile(join(reportPath, videoName), "mp4");
  const withVideo = await new ZipReader(new Uint8ArrayReader(await zipReportDirectory(reportPath))).getEntries();
  assert.deepEqual(withVideo.map(entry => entry.filename).sort(), ["assets/" + sha256 + ".png", videoName, "review.json"], "launch recordings seal next to the screenshots");
  await rm(join(reportPath, videoName));
  await writeFile(join(reportPath, "index.html"), "<script>");
  await assert.rejects(zipReportDirectory(reportPath), /review\.json \(or exploration\.json\) and assets/);
  await rm(join(reportPath, "index.html"));
  await rename(join(reportPath, "review.json"), join(reportPath, "exploration.json"));
  const exploration = await new ZipReader(new Uint8ArrayReader(await zipReportDirectory(reportPath))).getEntries();
  assert.deepEqual(exploration.map(entry => entry.filename).sort(), ["assets/" + sha256 + ".png", "exploration.json"], "a standalone exploration report seals the same way");
  await writeFile(join(reportPath, "review.json"), "{}");
  await assert.rejects(zipReportDirectory(reportPath), /review\.json \(or exploration\.json\) and assets/, "a report carries exactly one root file");
});

test("sealReport produces iv || AES-256-GCM ciphertext || tag bound to the preview AAD", () => {
  const key = new Uint8Array(32).fill(7); const iv = new Uint8Array(12).fill(9); const plain = Buffer.from("PK\u0003\u0004report");
  const sealed = Buffer.from(sealReport(plain, key, iv));
  assert.deepEqual(sealed.subarray(0, 12), Buffer.from(iv));
  const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(Buffer.from("expo-explore-preview/1")); decipher.setAuthTag(sealed.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]), plain);
  const wrongAad = createDecipheriv("aes-256-gcm", key, iv); wrongAad.setAAD(Buffer.from("other")); wrongAad.setAuthTag(sealed.subarray(-16));
  wrongAad.update(sealed.subarray(12, -16)); assert.throws(() => wrongAad.final());
});

test("ci:deploy refuses to run without a preview request, EXPO_TOKEN, or the preview export, and reports EAS failures", async t => {
  const plain = await exportFixture(t, { preview: null });
  const eas = easFixture();
  await assert.rejects(deployPreview({ inputPath: plain.inputPath, reportPath: plain.reportPath, artifactUrl, exportPath: plain.exportPath,
    environment: deployEnvironment, transport: eas.transport, run: eas.run }), error => error.code === "PREVIEW_NOT_CONFIGURED");
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment, transport: eas.transport, run: eas.run }),
    error => error.code === "EXPO_TOKEN_MISSING");
  await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath: join(exportPath, "missing"), environment: deployEnvironment,
    transport: eas.transport, run: eas.run }), error => error.code === "PREVIEW_EXPORT_MISSING");
  const failing = easFixture({ failDeploy: true });
  const pauses = [];
  const quiet = process.stderr.write.bind(process.stderr); const logged = [];
  process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
  try {
    await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: failing.transport,
      run: failing.run, verifyTimeoutMs: 1, sleep: async ms => { pauses.push(ms); } }), error => error.code === "PREVIEW_DEPLOY_FAILED" && error.retryable === true
      && /failed 3 times: Upload failed/.test(error.message) && error.details.attempts === 3 && /GraphQL request failed/.test(error.details.output));
  } finally { process.stderr.write = quiet; }
  // Three attempts with a pause between them; each attempt's eas output, not just its last line, is in the job log.
  assert.deepEqual(pauses, [5_000, 15_000]);
  assert.equal(failing.calls.filter(call => call.args[0] === "deploy").length, 3);
  assert.equal(logged.filter(line => /^eas deploy attempt \d of 3 failed/.test(line) && /GraphQL request failed/.test(line)).length, 3);
  // The alias quota is not a transient error: one attempt, its own code, and the plan limit in the message.
  const quota = easFixture({ failDeploy: "alias-limit" });
  await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: quota.transport,
    run: quota.run, verifyTimeoutMs: 1, sleep: async () => { throw new Error("no retry"); } }), error => error.code === "PREVIEW_ALIAS_LIMIT" && error.retryable === false
    && /reached the limit of 5 aliases from the Free plan/.test(error.message) && /deploy:alias:delete/.test(error.nextAction));
  assert.equal(quota.calls.filter(call => call.args[0] === "deploy").length, 1);
  // An API error on one attempt does not fail the job when the next attempt deploys.
  const flaky = easFixture({ failDeploy: 1 });
  const recovered = await deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: flaky.transport,
    run: flaky.run, verifyTimeoutMs: 1, sleep: async () => {} });
  assert.equal(flaky.calls.filter(call => call.args[0] === "deploy").length, 2);
  assert.match(recovered.previewUrl, /^https:\/\/acme-explore--1lcbdcpwn3\.expo\.app\/p\//);
  // The report job's comment said the report was deploying; the failed deployment hands it back to the download-and-drop Viewer.
  const fallback = failing.requests.filter(request => request.options.method === "POST");
  assert.equal(fallback.length, 1, "a failed deployment republishes the comment once");
  const fallbackBody = JSON.parse(fallback[0].options.body).body;
  assert.match(fallbackBody, /explore-preview\.expo\.app/, "the fallback comment links the central Viewer");
  assert.doesNotMatch(fallbackBody, /deploying|acme-explore--/, "the fallback comment neither says deploying nor links the hosted preview");
  assert.equal(eas.calls.length, 0, "nothing runs before the preflight checks pass");
});

test("ci:deploy rejects a deployment that serves the report without the token", async t => {
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  const eas = easFixture();
  const leaky = async (input, options) => {
    const url = new URL(input);
    if (url.origin === "https://acme-explore--1lcbdcpwn3.expo.app" && url.pathname === "/") return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    return eas.transport(input, options);
  };
  await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: leaky, run: eas.run, verifyTimeoutMs: 1 }),
    error => error.code === "PREVIEW_VERIFY_FAILED" && /without a valid token at \//.test(error.message));
  const posted = eas.requests.filter(request => request.options.method === "POST");
  assert.equal(posted.length, 1, "the leaky deployment is not linked; the comment falls back to the central Viewer");
  assert.doesNotMatch(JSON.parse(posted[0].options.body).body, /acme-explore--/);
});

test("a deployment that leaks past the token is named by the path's shape, never the token", async t => {
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  const eas = easFixture();
  const leaky = async (input, options) => {
    const url = new URL(input);
    if (/^\/p\/[a-z2-7]{32}\/viewer\/index\.html$/.test(url.pathname)) return new Response("<!doctype html>", { status: 200 });
    return eas.transport(input, options);
  };
  await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: leaky, run: eas.run, verifyTimeoutMs: 1 }), error => {
    const token = eas.captured.env.EXPLORE_PREVIEW_TOKEN;
    assert.equal(error.code, "PREVIEW_VERIFY_FAILED");
    assert.match(error.message, /at \/p\/<token>\/viewer\/index\.html\.$/);
    assert.ok(!JSON.stringify({ message: error.message, details: error.details }).includes(token.slice(0, 31)), "neither the token nor its near miss");
    return true;
  });
});

test("the preview owner comes from config or the token's single account; several accounts need report.preview.owner", async t => {
  assert.deepEqual(whoamiAccounts("Devin (robot) (authenticated using EXPO_TOKEN)\nAccounts:\n• brent-org (Role: Developer)\n• acme (Role: Owner)\n"), ["brent-org", "acme"]);
  assert.deepEqual(whoamiAccounts("brentvatne\n"), ["brentvatne"]);
  assert.deepEqual(whoamiAccounts("Not logged in\n"), []);
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  const several = easFixture({ accounts: ["brent-org", "acme"] });
  await assert.rejects(deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: several.transport, run: several.run, verifyTimeoutMs: 1 }),
    error => error.code === "PREVIEW_OWNER_AMBIGUOUS" && /brent-org, acme/.test(error.message) && /report\.preview\.owner/.test(error.nextAction));
  assert.deepEqual(several.calls.map(call => call.args[0]), ["whoami"]);
  const configured = await exportFixture(t, { preview: { hosting: "eas", expiresAfterDays: 7, owner: "acme", project: "wallet-explore" } });
  const eas = easFixture({ accounts: ["brent-org", "acme"] });
  const result = await deployPreview({ inputPath: configured.inputPath, reportPath: configured.reportPath, artifactUrl, exportPath: configured.exportPath,
    environment: deployEnvironment, transport: eas.transport, run: eas.run, verifyTimeoutMs: 1 });
  assert.deepEqual([result.owner, result.project, eas.captured.appJson.expo.owner, eas.captured.appJson.expo.slug], ["acme", "wallet-explore", "acme", "wallet-explore"]);
  const wrong = await exportFixture(t, { preview: { hosting: "eas", expiresAfterDays: 7, owner: "nobody" } });
  const other = easFixture();
  await assert.rejects(deployPreview({ inputPath: wrong.inputPath, reportPath: wrong.reportPath, artifactUrl, exportPath: wrong.exportPath,
    environment: deployEnvironment, transport: other.transport, run: other.run, verifyTimeoutMs: 1 }), error => error.code === "PREVIEW_OWNER_AMBIGUOUS" && /no access to the Expo account nobody/.test(error.message));
});

test("the preview project slug derives from the repository name unless configured", () => {
  assert.equal(previewProjectSlug("expo/explore-playground"), "explore-playground-explore");
  assert.equal(previewProjectSlug("Acme/My_App.iOS"), "my-app-ios-explore");
  assert.equal(previewProjectSlug("expo/explore-playground", "acme-explore"), "acme-explore");
});

test("ci:deploy fans several platforms' reports into one sealed deployment, verifies each, and links each section to its platform", async t => {
  const ios = await exportFixture(t); const android = await exportFixture(t);
  const eas = easFixture(); const now = Date.parse("2026-09-11T03:07:00Z");
  const result = await deployPreview({ reports: [
    { platform: "ios", inputPath: ios.inputPath, reportPath: ios.reportPath, artifactUrl: artifactUrl.replace(/20$/, "21") },
    { platform: "android", inputPath: android.inputPath, reportPath: android.reportPath, artifactUrl: artifactUrl.replace(/20$/, "22") },
  ], exportPath: ios.exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  const token = eas.captured.env.EXPLORE_PREVIEW_TOKEN;
  assert.equal(eas.captured.env.EXPLORE_PREVIEW_REPORT, undefined, "multi-platform deployments use the listing only");
  assert.deepEqual(captureListing(eas.captured.listing), [
    { target: "ios", platform: "ios", label: "iOS", path: "ios.zip.enc" }, { target: "android", platform: "android", label: "Android", path: "android.zip.enc" }], "the capturing-phase fixture has no review yet, so no change count");
  assert.ok(!eas.captured.env.EXPLORE_PREVIEW_REPORTS.includes("#"), "dotenv treats # as a comment");
  const zips = [await zipReportDirectory(ios.reportPath), await zipReportDirectory(android.reportPath)];
  assert.deepEqual(result.reports.map(report => [report.platform, report.reportSha256, report.reportBytes, report.artifactUrl]),
    zips.map((zip, index) => [["ios", "android"][index], createHash("sha256").update(zip).digest("hex"), zip.byteLength, artifactUrl.replace(/20$/, String(21 + index))]));
  assert.equal(result.reportSha256, result.reports[0].reportSha256);
  const previewPaths = eas.requests.filter(request => request.url.origin === "https://acme-explore--1lcbdcpwn3.expo.app").map(request => request.url.pathname + request.url.search);
  const wrong = token.endsWith("a") ? `${token.slice(0, -1)}b` : `${token.slice(0, -1)}a`;
  assert.deepEqual(previewPaths, [`/p/${token}`, `/p/${token}/api/v1`, `/p/${token}/report.zip?platform=ios`, `/p/${token}/report.zip?platform=android`, `/p/${token}/reports.json`,
    "/", `/p/${wrong}`, `/p/${wrong}/report.zip`, `/p/${token}/viewer/index.html`]);
  const posted = eas.requests.filter(request => request.options.method === "POST" || request.options.method === "PATCH").map(request => JSON.parse(request.options.body).body);
  assert.equal(posted.length, 2, "the second platform updates the comment the first created");
  assert.match(posted[0], new RegExp(`\\| iOS \\| [^|]+\\| 🟩 [^|]+\\| \\[Open\\]\\(<https://acme-explore--1lcbdcpwn3\\.expo\\.app/p/${token}\\?platform=ios>\\)`));
  assert.doesNotMatch(posted[0], /\| Android \|/);
  assert.match(posted[1], new RegExp(`\\| iOS \\| [^|]+\\| 🟩 [^|]+\\| \\[Open\\]\\(<[^>]+/p/${token}\\?platform=ios>\\)`), 'the Android writer keeps the iOS row');
  assert.match(posted[1], new RegExp(`\\| Android \\| [^|]+\\| 🟩 [^|]+\\| \\[Open\\]\\(<[^>]+/p/${token}\\?platform=android>\\)`));
  assert.equal(posted[1].split("<summary>Validation").length, 2, 'one validation block for both platforms');
});

function captureListing(listing) {
  return listing.map(({ path, ...rest }) => ({ ...rest, path: path.replace(/^\/_report\/[a-z2-7]{16}\//, "") }));
}

test("collectPlatformReports pairs downloaded artifact directories by platform and looks up each report artifact's URL", async t => {
  const ios = await exportFixture(t); const android = await exportFixture(t);
  const root = await mkdtemp(join(tmpdir(), "explore-fanin-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { cp } = await import("node:fs/promises");
  await mkdir(join(root, "inputs", "explore-capture-10-1-ios"), { recursive: true }); await cp(ios.inputPath, join(root, "inputs", "explore-capture-10-1-ios", "report-input.json"));
  await mkdir(join(root, "inputs", "explore-capture-10-1-android"), { recursive: true }); await cp(android.inputPath, join(root, "inputs", "explore-capture-10-1-android", "report-input.json"));
  await cp(ios.reportPath, join(root, "reports", "explore-review-10-1-ios"), { recursive: true });
  await cp(android.reportPath, join(root, "reports", "explore-review-10-1-android"), { recursive: true });
  await mkdir(join(root, "reports", "unrelated-dir"));
  const eas = easFixture();
  const entries = await collectPlatformReports({ inputsPath: join(root, "inputs"), reportsPath: join(root, "reports"), environment: deployEnvironment, transport: eas.transport });
  assert.deepEqual(entries, [
    { platform: "android", target: { id: "android", platform: "android", label: "Android" }, inputPath: join(root, "inputs", "explore-capture-10-1-android", "report-input.json"), reportPath: join(root, "reports", "explore-review-10-1-android"), artifactUrl: artifactUrl.replace(/20$/, "22") },
    { platform: "ios", target: { id: "ios", platform: "ios", label: "iOS" }, inputPath: join(root, "inputs", "explore-capture-10-1-ios", "report-input.json"), reportPath: join(root, "reports", "explore-review-10-1-ios"), artifactUrl: artifactUrl.replace(/20$/, "21") },
  ]);
  const lookups = eas.requests.filter(request => request.url.pathname.endsWith("/actions/runs/10/artifacts"));
  assert.deepEqual(lookups.map(request => request.url.searchParams.get("name")), ["explore-review-10-1-android", "explore-review-10-1-ios"]);
  assert.ok(lookups.every(request => request.options.headers.authorization === "Bearer test-token"));
  await rm(join(root, "reports", "explore-review-10-1-android"), { recursive: true });
  await assert.rejects(collectPlatformReports({ inputsPath: join(root, "inputs"), reportsPath: join(root, "reports"), environment: deployEnvironment, transport: eas.transport }),
    error => error.code === "PREVIEW_REPORTS_INCOMPLETE");
});

const now = Date.UTC(2026, 8, 11, 3, 7);
const STALE_COMMENT = `<!-- expo-explore-ci -->
Explore review for abc · Managed via config
## iOS · iPhone 17 · 2 changes

[Explore report](<https://acme-explore--oldid1.expo.app/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa>) · [Download report](<https://github.com/x/y/artifacts/1>) · [View run](<https://github.com/x/y/runs/1>)
Preview link works until Sep 11, 2026 (UTC) for anyone who has it.
<ul><li><a href="https://acme-explore--oldid1.expo.app/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?view=compare&amp;screen=s1"><code>/home</code></a> — Added text.</li></ul>
[Explore report](<https://other-explore--notours.expo.app/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb>) · [Explore report](<https://acme-explore--oldid2.expo.app/p/cccccccccccccccccccccccccccccccc?platform=android>)
`;

test("ci:deploy leaves the deployments the previous comment linked alone; developers delete them by hand", async t => {
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  const eas = easFixture({ existingComment: STALE_COMMENT.replaceAll("acme-explore--", "explore-playground-explore--").replace("oldid2", "1lcbdcpwn3") });
  const result = await deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.deepEqual(eas.calls.map(call => call.args.slice(0, 2)), [["whoami"], ["init", "--force"], ["deploy", "--json"]]);
  assert.equal("deletedDeployments" in result, false);
  assert.ok(eas.requests.find(request => request.options.method === "PATCH"), "the comment was updated to link the new deployment");
});

test("a never-expiring preview seals no EXPLORE_PREVIEW_EXPIRES_AT and the comment says the link lasts until the deployment is deleted", async t => {
  const { inputPath, reportPath, exportPath } = await exportFixture(t, { preview: { hosting: "eas", expiresAfterDays: null } });
  const eas = easFixture();
  const result = await deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.equal("EXPLORE_PREVIEW_EXPIRES_AT" in eas.captured.env, false);
  assert.equal(result.expiresAt, null);
  const body = JSON.parse(eas.requests.find(request => request.options.method === "PATCH" || request.options.method === "POST").options.body).body;
  assert.match(body, /^Preview links work for anyone who has them until the deployment is deleted\. · Managed via /m);
  assert.doesNotMatch(body, /works until/);
});

test("a standalone report deploys to a fixed alias with a fixed token, verifies both hosts, and prints the alias link", async t => {
  const { reportPath, exportPath } = await exportFixture(t);
  await rename(join(reportPath, "review.json"), join(reportPath, "exploration.json"));
  const eas = easFixture();
  const token = "b".repeat(32);
  const result = await deployExplorationReport({ reportPath, project: "acme-explore", owner: "brent-org", expiresAfterDays: null, exportPath, alias: "bluesky", token,
    environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.deepEqual(eas.calls[2].args, ["deploy", "--json", "--non-interactive", "--export-dir", "dist", "--alias", "bluesky"]);
  assert.equal(eas.captured.env.EXPLORE_PREVIEW_TOKEN, token, "the caller's token is sealed into the deployment");
  assert.equal(result.previewUrl, `https://acme-explore--bluesky.expo.app/p/${token}`);
  assert.equal(result.aliasUrl, "https://acme-explore--bluesky.expo.app");
  assert.equal(result.deploymentUrl, "https://acme-explore--1lcbdcpwn3.expo.app");
  const origins = new Set(eas.requests.filter(request => request.url.pathname.startsWith("/p/")).map(request => request.url.origin));
  assert.deepEqual([...origins].sort(), ["https://acme-explore--1lcbdcpwn3.expo.app", "https://acme-explore--bluesky.expo.app"], "the report is verified on the deployment and on the alias");

  const plain = await deployExplorationReport({ reportPath, project: "acme-explore", owner: "brent-org", expiresAfterDays: 7, exportPath,
    environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.equal(eas.captured.alias, undefined);
  assert.equal(plain.aliasUrl, undefined);
  assert.match(plain.previewUrl, /^https:\/\/acme-explore--1lcbdcpwn3\.expo\.app\/p\/[a-z2-7]{32}$/);
  assert.notEqual(plain.previewUrl, result.previewUrl, "without a fixed token the link is random");

  await assert.rejects(deployExplorationReport({ reportPath, project: "acme-explore", owner: "brent-org", expiresAfterDays: null, exportPath, alias: "Blue Sky",
    environment: deployEnvironment, transport: eas.transport, run: eas.run, verifyTimeoutMs: 1 }), error => error.code === "PREVIEW_ALIAS_INVALID");
  await assert.rejects(deployExplorationReport({ reportPath, project: "acme-explore", owner: "brent-org", expiresAfterDays: null, exportPath, token: "short",
    environment: deployEnvironment, transport: eas.transport, run: eas.run, verifyTimeoutMs: 1 }), error => error.code === "PREVIEW_TOKEN_INVALID");
});

test("a fixture preview seals each platform's ZIP as is behind one alias and lists them for the platform switch", async t => {
  const { root, reportPath, exportPath } = await exportFixture(t);
  const zip = await zipReportDirectory(reportPath);
  await writeFile(join(root, "ios.zip"), zip);
  await writeFile(join(root, "android.zip"), new Uint8Array([...zip, 0]));
  const eas = easFixture({ aliasOrigin: "https://explore-viewer-pr--pr-12.expo.app" });
  const token = "c".repeat(32);
  const result = await deployFixturePreview({ reports: [
    { platform: "android", zipPath: join(root, "android.zip"), changes: 12, device: "Pixel · light + dark" },
    { platform: "ios", zipPath: join(root, "ios.zip") },
  ], project: "explore-viewer-pr", owner: "brent-org", alias: "pr-12", token, exportPath,
  // A workflow that passes an earlier link's token through the environment sets it empty on the first run.
  environment: { ...deployEnvironment, EXPLORE_PREVIEW_TOKEN: "" }, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.equal(result.previewUrl, `https://explore-viewer-pr--pr-12.expo.app/p/${token}`);
  // @expo/env lets the CLI's own environment win over the sealed .env, even when empty; the CLI must not inherit it.
  assert.ok(eas.calls.every(call => !Object.keys(call.env).some(name => name.startsWith("EXPLORE_PREVIEW_"))));
  assert.equal(eas.captured.alias, "pr-12");
  assert.equal("EXPLORE_PREVIEW_EXPIRES_AT" in eas.captured.env, false, "a fixture preview does not expire");
  assert.deepEqual(captureListing(eas.captured.listing), [
    { target: "android", platform: "android", label: "Android", changes: 12, device: "Pixel · light + dark", path: "android.zip.enc" },
    { target: "ios", platform: "ios", label: "iOS", path: "ios.zip.enc" },
  ]);
  const served = eas.requests.filter(request => request.url.pathname === `/p/${token}/report.zip`).map(request => request.url.searchParams.get("platform"));
  assert.deepEqual([...new Set(served)].sort(), ["android", "ios"], "both platforms' bytes are verified");

  // The alias lagging the deployment past the budget is not a failed deployment: the deployment is verified, so the
  // link is the deployment's own origin and the job log carries a warning (every 2026-10-14 "HTTP 404" failure was this).
  const behind = easFixture({ aliasOrigin: "https://explore-viewer-pr--pr-12.expo.app", aliasServes: false });
  let clock = now; const ticking = () => (clock += 31_000);
  const quiet = process.stderr.write.bind(process.stderr); const logged = [];
  process.stderr.write = chunk => { logged.push(String(chunk)); return true; };
  let linked;
  try {
    linked = await deployFixturePreview({ reports: [{ platform: "ios", zipPath: join(root, "ios.zip") }], project: "explore-viewer-pr", owner: "brent-org", alias: "pr-12", token,
      exportPath, environment: deployEnvironment, transport: behind.transport, run: behind.run, now: ticking, verifyTimeoutMs: 60_000 });
  } finally { process.stderr.write = quiet; }
  assert.equal(linked.previewUrl, `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`);
  assert.equal(linked.aliasUrl, "https://explore-viewer-pr--pr-12.expo.app");
  assert.equal(logged.filter(line => /^Deployment https:\/\/acme-explore--1lcbdcpwn3\.expo\.app serves this run's report \(\d+ s after eas deploy returned\)\./.test(line)).length, 1);
  assert.equal(logged.filter(line => /^::warning::The alias https:\/\/explore-viewer-pr--pr-12\.expo\.app still answers HTTP 404 \d+ s after eas deploy returned\. The pull request links the deployment https:\/\/acme-explore--1lcbdcpwn3\.expo\.app instead\./.test(line)).length, 1);
  assert.ok(behind.requests.some(request => request.url.origin === "https://explore-viewer-pr--pr-12.expo.app"), "the alias was polled");

  await assert.rejects(deployFixturePreview({ reports: [{ platform: "ios", zipPath: join(root, "ios.zip") }, { platform: "ios", zipPath: join(root, "ios.zip") }],
    project: "explore-viewer-pr", alias: "pr-12", exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, verifyTimeoutMs: 1 }),
  error => error.code === "PREVIEW_REPORTS_INVALID");
  await assert.rejects(deployFixturePreview({ reports: [{ platform: "ios", zipPath: join(root, "ios.zip") }],
    project: "explore-viewer-pr", alias: "PR 12", exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, verifyTimeoutMs: 1 }),
  error => error.code === "PREVIEW_ALIAS_INVALID");
});

test("a deployment that does not report the requested alias is a retryable deploy failure", async t => {
  const { reportPath, exportPath } = await exportFixture(t);
  await rename(join(reportPath, "review.json"), join(reportPath, "exploration.json"));
  const eas = easFixture();
  const run = (node, [bin, ...args], options) => {
    const result = eas.run(node, [bin, ...args], options);
    if (args[0] !== "deploy") return result;
    const { aliases: _aliases, ...rest } = JSON.parse(result.stdout);
    return { ...result, stdout: `${JSON.stringify(rest)}\n` };
  };
  await assert.rejects(deployExplorationReport({ reportPath, project: "acme-explore", owner: "brent-org", expiresAfterDays: null, exportPath, alias: "bluesky",
    environment: deployEnvironment, transport: eas.transport, run, now: () => now, verifyTimeoutMs: 1 }),
    error => error.code === "PREVIEW_DEPLOY_FAILED" && error.retryable === true && /did not report the alias bluesky/.test(error.message));
});

const MARKED_COMMENT = `<!-- expo-explore-ci -->
<!-- expo-explore-deployments:explore-playground-explore--oldid1,other-explore--notours -->
Explore review for abc · Managed via config
<!-- expo-explore-platform:ios -->
## iOS · iPhone 17 · in progress
<!-- /expo-explore-platform:ios -->`;

test("ci:deploy writes its own deployments line over the one report jobs carried, without deleting what it named", async t => {
  const { inputPath, reportPath, exportPath } = await exportFixture(t);
  const eas = easFixture({ origin: "https://explore-playground-explore--1lcbdcpwn3.expo.app", existingComment: MARKED_COMMENT });
  await deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.equal(eas.calls.some(call => call.args[0] === "deploy:delete"), false);
  const patched = eas.requests.find(request => request.options.method === "PATCH");
  assert.match(JSON.parse(patched.options.body).body, /^<!-- expo-explore-ci -->\n<!-- expo-explore-deployments:explore-playground-explore--1lcbdcpwn3 -->\n/);
});


test("a comparison of two commits deploys the same way and links its report from the run summary, not a pull request", async t => {
  const comparison = { origin: "compare", repositoryId: "123", repository: pr.repository,
    base: { ref: "v1.3.0", sha: pr.base.sha }, head: { ref: "v1.4.0", sha: pr.head.sha } };
  const { root, inputPath, reportPath, exportPath } = await exportFixture(t, { presentation: comparison });
  const summaryPath = join(root, "summary.md");
  const eas = easFixture(); const secrets = [];
  const result = await deployPreview({ inputPath, reportPath, artifactUrl, exportPath, environment: { ...deployEnvironment, GITHUB_STEP_SUMMARY: summaryPath },
    transport: eas.transport, run: eas.run, now: () => Date.parse("2026-09-11T03:07:00Z"), verifyTimeoutMs: 1, onSecret: secret => secrets.push(secret) });
  // The runner masks registered secrets in job summaries as well; a masked token would make the summary link ***.
  assert.deepEqual(secrets, [], "a comparison's token is not registered as a mask");
  assert.equal(result.linkedFromRunSummary, true, "so the CLI keeps the link out of the log");
  assert.deepEqual(eas.calls.map(call => call.args[0]), ["whoami", "init", "deploy"]);
  assert.equal(eas.requests.filter(request => request.url.origin === "https://api.github.com").length, 0, "no pull request to read or comment on");
  const summary = readFileSyncUtf8(summaryPath);
  assert.match(summary, /^### Explore: `v1\.4\.0` vs `v1\.3\.0`$/m);
  assert.ok(summary.includes(`[Open the report](${result.previewUrl})`));
  assert.ok(summary.includes(`(https://github.com/${pr.repository}/compare/${pr.base.sha}..${pr.head.sha})`));
  assert.match(summary, /link expires 2026-09-18/);
});

test("readReportZip reads a review ZIP's platform, run and labels, and rejects anything that is not a report", async t => {
  const { reportPath } = await exportFixture(t);
  const zip = await zipReportDirectory(reportPath);
  const { platform, device: _device, target, ...summary } = await readReportZip(zip);
  assert.ok(["ios", "android"].includes(platform));
  assert.deepEqual(target, { id: platform, platform, label: platform === "ios" ? "iOS" : "Android" }, "a report from before targets is its platform's target");
  assert.deepEqual(summary, { kind: "review", repository: pr.repository, runId: "10", base: pr.base.sha, head: pr.head.sha, changes: 0 });

  // GitHub's artifact download lists directories as entries of their own.
  const { ZipWriter, Uint8ArrayWriter } = await import("@zip.js/zip.js");
  const entries = new ZipReader(new Uint8ArrayReader(zip));
  const withDirectory = new ZipWriter(new Uint8ArrayWriter());
  await withDirectory.add("assets/", undefined, { directory: true });
  for (const entry of await entries.getEntries()) await withDirectory.add(entry.filename, new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())));
  const extra = new ZipWriter(new Uint8ArrayWriter());
  for (const entry of await entries.getEntries()) await extra.add(entry.filename, new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())));
  await extra.add("notes.txt", new Uint8ArrayReader(new TextEncoder().encode("hi")));
  await entries.close();
  assert.equal((await readReportZip(await withDirectory.close())).kind, "review");
  await assert.rejects(readReportZip(await extra.close()), /review.json \(or exploration.json\) and assets/);
  await assert.rejects(readReportZip(new Uint8Array([1, 2, 3])));

  // Commits are full SHAs and the names are text: what the CLI hands to git and prints is never anything else.
  const original = await readFile(join(reportPath, "review.json"), "utf8");
  for (const [field, value] of [["head", { ref: "x", sha: "--output=/tmp/explore-victim" }], ["title", 42]]) {
    const report = JSON.parse(original);
    report.review.pullRequest[field] = value;
    await writeFile(join(reportPath, "review.json"), JSON.stringify(report));
    await assert.rejects(readReportZip(await zipReportDirectory(reportPath)), /does not name its repository, title and commits/, field);
  }
  await writeFile(join(reportPath, "review.json"), original);

  // A review renamed to exploration.json is neither.
  await rename(join(reportPath, "review.json"), join(reportPath, "exploration.json"));
  await assert.rejects(readReportZip(await zipReportDirectory(reportPath)), /not an Explore exploration report/);
  await writeFile(join(reportPath, "exploration.json"), JSON.stringify({ kind: "explore.exploration-report",
    exploration: { app: { name: "Acme", bundleId: "com.acme", platform: "android" }, device: { model: "Pixel 9", osVersion: "16" } } }));
  assert.deepEqual(await readReportZip(await zipReportDirectory(reportPath)), { kind: "exploration", platform: "android", target: { id: "android", platform: "android", label: "Android" }, device: "Pixel 9 16" });
});

test("deployLocalReports hosts one review's platforms behind one link, labelled from each ZIP", async t => {
  const { reportPath, exportPath } = await exportFixture(t);
  const zip = await zipReportDirectory(reportPath);
  const eas = easFixture();
  const result = await deployLocalReports({ reports: [{ platform: "ios", zip, changes: 3, device: "iPhone 17 26.5" }, { platform: "android", zip }],
    project: "acme-explore", expiresAfterDays: null, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.match(result.previewUrl, /^https:\/\/acme-explore--1lcbdcpwn3\.expo\.app\/p\/[a-z2-7]{32}$/);
  assert.equal(result.owner, "brent-org", "the only account of the login holds the project");
  assert.equal(result.expiresAt, null);
  assert.deepEqual(captureListing(eas.captured.listing), [
    { target: "ios", platform: "ios", label: "iOS", changes: 3, device: "iPhone 17 26.5", path: "ios.zip.enc" },
    { target: "android", platform: "android", label: "Android", path: "android.zip.enc" },
  ]);
  await assert.rejects(deployLocalReports({ reports: [{ platform: "ios", zip }, { platform: "ios", zip }], project: "acme-explore", expiresAfterDays: 7, exportPath,
    environment: deployEnvironment, transport: eas.transport, run: eas.run }), error => error.code === "PREVIEW_REPORTS_INVALID");

  // One Android report is still listed, so the Worker does not take it for iOS; a label with `#` cannot cut the sealed .env short.
  await deployLocalReports({ reports: [{ platform: "android", zip, changes: 1, device: "Pixel #9 <Pro>\n" }], project: "acme-explore", expiresAfterDays: 7, exportPath,
    environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.equal(eas.captured.env.EXPLORE_PREVIEW_REPORT, undefined);
  assert.deepEqual(captureListing(eas.captured.listing), [{ target: "android", platform: "android", label: "Android", changes: 1, device: "Pixel 9 Pro", path: "android.zip.enc" }]);
  // eas deploy expands $VARIABLES in that .env, even single-quoted: a label never carries one in, nor a backslash.
  await deployLocalReports({ reports: [{ platform: "ios", zip, device: "iPhone ${EXPO_TOKEN} $EXPLORE_PREVIEW_KEY \\$ · light + dark" }], project: "acme-explore",
    expiresAfterDays: 7, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.deepEqual(captureListing(eas.captured.listing), [{ target: "ios", platform: "ios", label: "iOS", device: "iPhone EXPO_TOKEN EXPLORE_PREVIEW_KEY · light + dark", path: "ios.zip.enc" }]);
});

test("an explore:binary report names its platform, so an Android exploration is not served as iOS", async t => {
  const { reportPath, exportPath } = await exportFixture(t);
  await rename(join(reportPath, "review.json"), join(reportPath, "exploration.json"));
  const eas = easFixture();
  await deployExplorationReport({ reportPath, platform: "android", project: "acme-explore", owner: "brent-org", expiresAfterDays: 7, exportPath,
    environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.deepEqual(captureListing(eas.captured.listing), [{ target: "android", platform: "android", label: "Android", path: "android.zip.enc" }]);
});

test("readReportZip stops inflating a report file once it passes the size its header declares", async () => {
  const { deflateRawSync } = await import("node:zlib");
  const name = Buffer.from("review.json");
  const data = deflateRawSync(Buffer.alloc(32 * 1024 * 1024, 32));
  const header = size => {
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    return local;
  };
  // The directory claims 10 bytes of JSON; the entry inflates to 32 MiB.
  const local = Buffer.concat([header(10), name, data]);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(10, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(local.length, 16);
  const zip = new Uint8Array(Buffer.concat([local, central, name, end]));
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(readReportZip(zip), /review\.json is unreadable or larger than 64 MiB/);
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024, "the inflated bytes were never all held");
});

test("report:upload checks its reports before it deploys anything", async t => {
  const { root, reportPath } = await exportFixture(t);
  const cli = join(import.meta.dirname, "../../dist/cli.js");
  const upload = (...args) => {
    const result = spawnSync(process.execPath, [cli, "report:upload", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, EXPO_TOKEN: "", EXPLORE_CACHE_DIR: join(root, "cache") } });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const zip = await zipReportDirectory(reportPath);
  await writeFile(join(root, "one.zip"), zip); await writeFile(join(root, "two.zip"), zip);
  await writeFile(join(root, "notes.txt"), "not a report");
  const other = JSON.parse(await readFile(join(reportPath, "review.json"), "utf8"));
  other.review.runtime.platform = other.review.runtime.platform === "ios" ? "android" : "ios";
  await mkdir(join(root, "other")); await writeFile(join(root, "other/review.json"), JSON.stringify({ ...other, review: { ...other.review, runId: "11" } }));
  await cp(join(reportPath, "assets"), join(root, "other/assets"), { recursive: true });

  assert.match(upload().output, /Pass the report to host/);
  assert.match(upload("missing.zip").output, /There is no report at missing\.zip/);
  assert.match(upload("notes.txt").output, /notes\.txt is not an Explore report/);
  assert.match(upload("one.zip", "--expires-in", "7d", "two.zip").output, /More than one (ios|android) report/, "a value flag between paths is not read as a path");
  assert.match(upload("one.zip", "other").output, /one\.zip and other are not the same review's (platforms|targets)/, "another run's report of the other platform");
  assert.match(upload("one.zip", "--alias", "x").output, /Unknown flag for report:upload: --alias/);
  for (const result of [upload(), upload("one.zip", "two.zip")]) assert.equal(result.status, 1);
});

const TARGETS = [
  { id: "iphone", platform: "ios", label: "iPhone 17" },
  { id: "duo-closed", platform: "ios", label: "iPhone Duo (closed)" },
  { id: "duo-open", platform: "ios", label: "iPhone Duo (open)" },
  { id: "android", platform: "android", label: "Android" },
];

/** Rewrites a fixture's report input (and exported review.json) as one target's report of a run with several targets. */
async function asTarget(fixturePaths, target) {
  const input = JSON.parse(await readFile(fixturePaths.inputPath, "utf8"));
  input.publicReview.runtime = { ...input.publicReview.runtime, platform: target.platform, target, targets: TARGETS };
  await writeFile(fixturePaths.inputPath, JSON.stringify(input));
  const report = JSON.parse(await readFile(join(fixturePaths.reportPath, "review.json"), "utf8"));
  report.review.runtime = { ...report.review.runtime, platform: target.platform, target, targets: TARGETS };
  await writeFile(join(fixturePaths.reportPath, "review.json"), JSON.stringify(report));
  return fixturePaths;
}

test("readReportZip names the report's target from review.runtime.target, and ignores one that does not fit", async t => {
  const { reportPath } = await asTarget(await exportFixture(t), TARGETS[2]);
  const summary = await readReportZip(await zipReportDirectory(reportPath));
  assert.deepEqual([summary.platform, summary.target], ["ios", TARGETS[2]]);
  const report = JSON.parse(await readFile(join(reportPath, "review.json"), "utf8"));
  for (const target of [{ id: "Bad Id", platform: "ios", label: "x" }, { id: "install-x", platform: "ios", label: "x" }, { id: "pixel", platform: "android", label: "Pixel" }]) {
    report.review.runtime.target = target;
    await writeFile(join(reportPath, "review.json"), JSON.stringify(report));
    assert.deepEqual((await readReportZip(await zipReportDirectory(reportPath))).target, { id: "ios", platform: "ios", label: "iOS" }, target.id);
  }
  report.review.runtime.target = { id: "duo-open", platform: "ios", label: "Duo ${HOME} [open] #1" };
  await writeFile(join(reportPath, "review.json"), JSON.stringify(report));
  assert.equal((await readReportZip(await zipReportDirectory(reportPath))).target.label, "Duo HOME open 1", "a label is plain text, safe in the sealed .env");
});

test("deployLocalReports hosts four targets, three of them iOS, as <target>.zip.enc selected by ?target=", async t => {
  const { reportPath, exportPath } = await exportFixture(t);
  const zip = await zipReportDirectory(reportPath);
  const eas = easFixture();
  await deployLocalReports({ reports: TARGETS.map((target, index) => ({ platform: target.platform, target, zip: new Uint8Array([...zip, ...new Array(index).fill(0)]), changes: index })),
    project: "acme-explore", expiresAfterDays: 7, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 });
  assert.deepEqual(captureListing(eas.captured.listing), TARGETS.map((target, index) => ({ target: target.id, platform: target.platform, label: target.label, path: `${target.id}.zip.enc`, changes: index })));
  const served = eas.requests.filter(request => request.url.pathname === `/p/${eas.captured.env.EXPLORE_PREVIEW_TOKEN}/report.zip`).map(request => request.url.search);
  assert.deepEqual([...new Set(served)], ["?target=iphone", "?target=duo-closed", "?target=duo-open", "?platform=android"],
    "a target named after its platform keeps the ?platform= link it always had");
  for (const reports of [[{ platform: "ios", target: TARGETS[0], zip }, { platform: "ios", target: TARGETS[0], zip }],
    [{ platform: "ios", target: { id: "Bad", platform: "ios", label: "x" }, zip }],
    Array.from({ length: 9 }, (_, index) => ({ platform: "ios", target: { id: `t${index}`, platform: "ios", label: "x" }, zip }))]) {
    await assert.rejects(deployLocalReports({ reports, project: "acme-explore", expiresAfterDays: 7, exportPath, environment: deployEnvironment, transport: eas.transport, run: eas.run }),
      error => error.code === "PREVIEW_REPORTS_INVALID");
  }
});

test("ci:deploy pairs target-named artifacts, deploys them in config order, and seals each as its target", async t => {
  const fixtures = [];
  for (const target of TARGETS) fixtures.push(await asTarget(await exportFixture(t), target));
  const root = await mkdtemp(join(tmpdir(), "explore-fanin-targets-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, target] of TARGETS.entries()) {
    await mkdir(join(root, "inputs", `explore-capture-10-1-${target.id}`), { recursive: true });
    await cp(fixtures[index].inputPath, join(root, "inputs", `explore-capture-10-1-${target.id}`, "report-input.json"));
    await cp(fixtures[index].reportPath, join(root, "reports", `explore-review-10-1-${target.id}`), { recursive: true });
  }
  const eas = easFixture();
  const names = { "explore-review-10-1-iphone": 31, "explore-review-10-1-duo-closed": 32, "explore-review-10-1-duo-open": 33, "explore-review-10-1-android": 34 };
  const transport = async (input, options) => {
    const url = new URL(input);
    const name = url.searchParams.get("name");
    if (url.pathname.endsWith("/actions/runs/10/artifacts") && names[name]) return new Response(JSON.stringify({ artifacts: [{ id: names[name], name }] }), { status: 200 });
    return eas.transport(input, options);
  };
  const entries = await collectPlatformReports({ inputsPath: join(root, "inputs"), reportsPath: join(root, "reports"), environment: deployEnvironment, transport });
  assert.deepEqual(entries.map(entry => [entry.target.id, entry.platform, entry.artifactUrl.split("/").at(-1)]),
    [["iphone", undefined, "31"], ["duo-closed", undefined, "32"], ["duo-open", undefined, "33"], ["android", "android", "34"]], "config order, not directory order");
  const sealed = await deployPreview({ reports: entries.map(({ platform: _platform, ...entry }) => entry), exportPath: fixtures[0].exportPath, environment: deployEnvironment, transport, run: eas.run, now: () => now, verifyTimeoutMs: 1 })
    .catch(error => error);
  // Publishing each target's comment section after the deployment is the comment code's (publishCiReportComment, which needs
  // the target to name the artifact); the deployment itself must have been sealed per target either way.
  assert.deepEqual(captureListing(eas.captured.listing).map(entry => [entry.target, entry.platform, entry.label, entry.path]),
    TARGETS.map(target => [target.id, target.platform, target.label, `${target.id}.zip.enc`]), String(sealed?.message ?? ""));

  // An artifact named for one target that holds another's report is refused.
  await rm(join(root, "inputs", "explore-capture-10-1-duo-open"), { recursive: true });
  await mkdir(join(root, "inputs", "explore-capture-10-1-duo-open"));
  await cp(fixtures[0].inputPath, join(root, "inputs", "explore-capture-10-1-duo-open", "report-input.json"));
  await assert.rejects(collectPlatformReports({ inputsPath: join(root, "inputs"), reportsPath: join(root, "reports"), environment: deployEnvironment, transport }),
    error => error.code === "PREVIEW_REPORTS_INVALID" && /holds the report of iphone/.test(error.message));
});
