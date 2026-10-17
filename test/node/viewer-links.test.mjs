import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEWER_ORIGIN, previewLinks, viewerLinks } from "../../dist/report/viewer-links.js";

const input = {
  viewerUrl: "https://explore-preview.expo.app/map",
  repository: "expo/explore-playground",
  headSha: "b".repeat(40),
  runId: "34196199668",
  runAttempt: "1",
  configPath: ".expo-explore/config.yaml",
};
const artifactUrl = `https://github.com/${input.repository}/actions/runs/${input.runId}/artifacts/7654`;

test("artifact links retain report identity and each status/screen selection on the central Viewer", () => {
  const { viewerUrl: _viewer, ...report } = input;
  const links = viewerLinks({ ...report, artifactUrl });
  const identity = { repo: report.repository, run: report.runId, attempt: report.runAttempt, artifact: "7654" };
  const open = new URL(links.viewer.open);
  assert.equal(open.origin, DEFAULT_VIEWER_ORIGIN);
  assert.equal(open.pathname, "/");
  assert.deepEqual(Object.fromEntries(open.searchParams), identity);
  assert.equal(links.download, artifactUrl);
  for (const status of ["added", "modified", "removed"]) {
    const focused = new URL(links.viewer.focus(status));
    assert.equal(focused.origin, open.origin);
    assert.equal(focused.pathname, "/");
    assert.deepEqual(Object.fromEntries(focused.searchParams), { ...identity, focus: status, inspect: "diff" });
  }
  const selected = new URL(links.viewer.surface("route-12abc"));
  assert.deepEqual(Object.fromEntries(selected.searchParams), { ...identity, view: "compare", screen: "route-12abc" });
  assert.notEqual(selected.href, artifactUrl);
  assert.throws(() => links.viewer.surface("bad id"), /route id/);
  assert.equal(new URL(links.viewer.surface("route-12abc@dark")).searchParams.get("screen"), "route-12abc@dark");
  assert.throws(() => links.viewer.surface("route-12abc@sepia"), /route id/);
  assert.equal(new URL(viewerLinks({ ...report, artifactUrl, viewerUrl: "https://central.example" }).viewer.open).origin, "https://central.example");
  for (const invalid of [artifactUrl.replace("/artifacts/7654", "/artifacts/0"), artifactUrl + "?token=secret",
    artifactUrl.replace(report.repository, "owner/other"), artifactUrl.replace(report.runId, "123"),
    artifactUrl.replace("https://github.com", "https://attacker.example")]) {
    assert.throws(() => viewerLinks({ ...report, artifactUrl: invalid }), /artifact URL/);
  }
});

test("links exist for GitHub pages before the report is uploaded, and inputs are validated", () => {
  const links = viewerLinks(input);
  assert.equal(links.viewer, null);
  assert.equal(links.download, null);
  assert.equal(links.run, "https://github.com/expo/explore-playground/actions/runs/34196199668/attempts/1");
  assert.equal(links.artifacts, "https://github.com/expo/explore-playground/actions/runs/34196199668#artifacts");
  assert.equal(links.config, `https://github.com/expo/explore-playground/blob/${"b".repeat(40)}/.expo-explore/config.yaml`);
  // A viewer URL that already carries a path or query contributes only its origin.
  assert.equal(new URL(viewerLinks({ ...input, artifactUrl, viewerUrl: "https://viewer.example/anything?x=1" }).viewer.open).origin, "https://viewer.example");
  assert.throws(() => viewerLinks({ ...input, viewerUrl: "ftp://viewer.example" }), /HTTP URL/);
  assert.throws(() => viewerLinks({ ...input, viewerUrl: "https://user:pass@viewer.example" }), /credentials/);
  assert.throws(() => viewerLinks({ ...input, artifactUrl: "javascript:alert(1)" }), /HTTP URL/);
  assert.throws(() => viewerLinks({ ...input, headSha: "abc" }), /headSha/);
  assert.throws(() => viewerLinks({ ...input, repository: "expo" }), /owner\/name/);
  assert.throws(() => viewerLinks({ ...input, runId: "1 2" }), /run identifiers/);
  assert.throws(() => viewerLinks({ ...input, configPath: "../config.yaml" }), /configPath/);
  assert.throws(() => viewerLinks({ ...input, configPath: "/etc/passwd" }), /configPath/);
});

test("preview links keep the token page and add the Viewer's deep-link grammar", () => {
  const token = "abcdefghijklmnopqrstuvwxyz234567";
  const links = previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, 1_800_000_000_000);
  assert.equal(links.open, `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`);
  assert.equal(links.expiresAt, 1_800_000_000_000);
  assert.equal(previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, null).expiresAt, null);
  assert.throws(() => previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, 0), /timestamp or null/);
  assert.equal(links.focus("modified"), `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}?focus=modified&inspect=diff`);
  assert.equal(links.surface("home.index"), `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}?view=compare&screen=home.index`);
  assert.throws(() => links.surface("a b"), /route id/);
  assert.equal(links.surface("home.index@light"), `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}?view=compare&screen=home.index%40light`);
  assert.throws(() => links.surface("home.index@"), /route id/);
  for (const bad of [`http://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, `https://acme.expo.app/p/${token}?x=1`,
    `https://acme.expo.app/p/${token}#f`, "https://acme.expo.app/p/short", `https://acme.expo.app/p/${token}/report.zip`,
    `https://user:pw@acme.expo.app/p/${token}`]) {
    assert.throws(() => previewLinks(bad, 1), /preview URL/);
  }
  assert.throws(() => previewLinks(`https://acme.expo.app/p/${token}`, Number.NaN), /expiry/);
});

test('matrix jobs add platform to the Viewer link and nothing else changes', async () => {
  const { viewerLinks } = await import('../../dist/report/viewer-links.js');
  const input = { repository: 'expo/explore-playground', headSha: 'b'.repeat(40), runId: '42', runAttempt: '1', configPath: '.expo-explore/config.yaml',
    artifactUrl: 'https://github.com/expo/explore-playground/actions/runs/42/artifacts/7654' };
  const plain = new URL(viewerLinks(input).viewer.open);
  const android = new URL(viewerLinks({ ...input, platform: "android" }).viewer.open);
  assert.equal(plain.searchParams.get('platform'), null);
  assert.equal(android.searchParams.get('platform'), 'android');
  android.searchParams.delete('platform');
  assert.equal(android.href, plain.href);
});

test("a target's links select it with ?target=, and a target named after its platform keeps ?platform=", async () => {
  const { viewerLinks, previewLinks } = await import('../../dist/report/viewer-links.js');
  const token = "abcdefghijklmnopqrstuvwxyz234567";
  const page = `https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`;
  assert.equal(previewLinks(page, null, "ios").open, `${page}?platform=ios`, "byte-identical to links from before targets");
  assert.equal(previewLinks(page, null, "android").focus("modified"), `${page}?platform=android&focus=modified&inspect=diff`);
  assert.equal(previewLinks(page, null, "duo-open").open, `${page}?target=duo-open`);
  assert.equal(previewLinks(page, null, "duo-open").surface("home"), `${page}?target=duo-open&view=compare&screen=home`);
  for (const bad of ["Duo", "report", "install-x", "a".repeat(33), "duo open"]) assert.throws(() => previewLinks(page, null, bad), /target id/, bad);
  const input = { repository: 'expo/explore-playground', headSha: 'b'.repeat(40), runId: '42', runAttempt: '1', configPath: '.expo-explore/config.yaml',
    artifactUrl: 'https://github.com/expo/explore-playground/actions/runs/42/artifacts/7654' };
  const duo = new URL(viewerLinks({ ...input, platform: "ios", target: "duo-closed" }).viewer.open);
  assert.equal(duo.searchParams.get('target'), 'duo-closed', "the target wins over its platform");
  assert.equal(duo.searchParams.get('platform'), null);
  assert.equal(viewerLinks({ ...input, target: "ios" }).viewer.open, viewerLinks({ ...input, platform: "ios" }).viewer.open);
  assert.throws(() => viewerLinks({ ...input, target: "Bad" }), /target id/);
});
