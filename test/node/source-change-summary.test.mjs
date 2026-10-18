import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { createSourceChangeSummaries, SOURCE_CHANGE_SUMMARY_LIMITS } = await tsImport("../../src/source/change-summary.ts", import.meta.url);
const { validateSourceChangeSummary } = await tsImport("../../src/contracts/source-change.ts", import.meta.url);

function git(directory, ...args) {
  const result = spawnSync("/usr/bin/git", ["-C", directory, "-c", "user.name=Source summary fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(t, base, head) {
  const directory = mkdtempSync(join(tmpdir(), "explore-source-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, "init", "--quiet");
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
  };
  write(base);
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "-m", "base fixture");
  const baseSha = git(directory, "rev-parse", "HEAD");
  for (const path of Object.keys(base)) if (!(path in head)) rmSync(join(directory, path));
  write(head);
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "-m", "head fixture");
  return { directory, baseSha, headSha: git(directory, "rev-parse", "HEAD") };
}

function surface(id, routeFile, sourceFiles = []) {
  return { id, route: `/${id}`, routeFile, sourceFiles, path: `/${id}`, provider: "expo-router", logicalPath: id, variant: "default", kind: "screen" };
}

function plan(repo, surfaces, extra = {}) {
  return {
    contract: "explore.plan", baseSha: repo.baseSha, headSha: repo.headSha,
    mode: "changes", conservative: false, unresolved: [], surfaces,
    inventorySurfaceIds: surfaces.map(({ id }) => id),
    baseCaptureSurfaceIds: surfaces.filter(({ baseSurface, status }) => baseSurface && status !== "unchanged").map(({ id }) => id),
    headCaptureSurfaceIds: surfaces.filter(({ headSurface, status }) => headSurface && status !== "unchanged").map(({ id }) => id),
    ...extra,
  };
}

function tracked(entry, paths, status = "modified") {
  const route = { ...entry, sourceFiles: [...new Set([entry.routeFile, ...entry.sourceFiles, ...paths])].sort() };
  return { id: entry.id, status, baseSurface: route, headSurface: route, reasons: paths.map((path) => `Source changed: ${path}`), baseCapture: true, headCapture: true };
}

function summarize(repo, sourcePlan) {
  const summaries = createSourceChangeSummaries({ baseProject: repo.directory, headProject: repo.directory, plan: sourcePlan });
  for (const summary of Object.values(summaries)) validateSourceChangeSummary(summary, repo.baseSha, repo.headSha);
  return summaries;
}

test("shared dependency removal explains recapture while preserving exact catalog/export Git evidence", (t) => {
  const catalog = "src/catalog.ts", barrel = "src/screens/index.ts";
  const repo = repository(t, {
    [catalog]: "export const catalog = [\n  { id: 'amber-bird', title: 'Amber Bird', route: '/play/bird' },\n  { id: 'otter', title: 'Otter', route: '/play/otter' },\n];\n",
    [barrel]: "export * from './bird';\nexport * from './otter';\n",
    "src/app/otter.tsx": "export { Otter as default } from '../screens';\n",
    "src/screens/otter.tsx": "export const Otter = () => null;\n",
  }, {
    [catalog]: "export const catalog = [\n  { id: 'otter', title: 'Otter', route: '/play/otter' },\n];\n",
    [barrel]: "export * from './otter';\n",
    "src/app/otter.tsx": "export { Otter as default } from '../screens';\n",
    "src/screens/otter.tsx": "export const Otter = () => null;\n",
  });
  const player = surface("otter", "src/app/otter.tsx", ["src/screens/otter.tsx"]);
  const dashboard = surface("dashboard", catalog);
  const sourcePlan = plan(repo, [tracked(player, [catalog, barrel]), tracked(dashboard, [catalog, barrel])]);
  const summaries = summarize(repo, sourcePlan);
  assert.equal(summaries.otter.impact, "dependency");
  assert.match(summaries.otter.summary, /^Something it imports changed\./);
  assert.match(summaries.otter.summary, /Removed entry “amber-bird” from catalog/);
  assert.match(summaries.otter.summary, /Removed re-export from “\.\/bird”/);
  assert.doesNotMatch(summaries.otter.summary, /visual|pixels|screenshots? (?:are|is) (?:equal|same)/i);
  assert.equal(summaries.dashboard.impact, "direct");
  assert.ok(summaries.otter.files.every((file) => file.relation === "dependency"));
  const file = summaries.otter.files.find((file) => file.path === catalog);
  assert.equal(file.baseBlobSha, git(repo.directory, "rev-parse", `${repo.baseSha}:${catalog}`));
  assert.equal(file.headBlobSha, git(repo.directory, "rev-parse", `${repo.headSha}:${catalog}`));
  assert.deepEqual(file.hunks, [{ baseStart: 2, baseLines: 1, headStart: 1, headLines: 0 }]);
  assert.equal(file.patch, undefined, "Generated source analysis never stores the raw Git patch");
  assert.equal(file.patchTruncated, undefined);
  assert.deepEqual(file.facts[0].baseLines, { start: 2, end: 2 });
  assert.equal(file.facts[0].before, "amber-bird");
  assert.equal(file.facts.some((fact) => fact.kind === "property-changed"), false, "Removing a keyed item must not shift the remaining item's identity");
  assert.deepEqual(summaries, summarize(repo, sourcePlan), "Repeated summaries of immutable commits are deterministic");
});

test("direct label edits retain the exact source expression and new literal without inventing a translation", (t) => {
  const path = "src/settings.tsx";
  const repo = repository(t, {
    [path]: "export const groups = [{ id: 'sharing', items: [{ id: 'invite', label: t('settings.invite'), onPress: invite }] }];\n",
  }, {
    [path]: "export const groups = [{ id: 'sharing', items: [{ id: 'invite', label: 'Invite a friend', onPress: invite }] }];\n",
  });
  const result = summarize(repo, plan(repo, [tracked(surface("settings", path), [path])])).settings;
  assert.equal(result.impact, "direct");
  assert.equal(result.summary, "Its own source changed. Changed label for “invite” from t('settings.invite') to “Invite a friend”.");
  assert.equal(result.files[0].facts[0].before, "t('settings.invite')");
  assert.equal(result.files[0].facts[0].after, "'Invite a friend'");
  assert.deepEqual(result.files[0].facts[0].headLines, { start: 1, end: 1 });
});

test("monorepo app paths retain immutable source blobs and extracted facts without raw diff text", (t) => {
  const path = "src/settings.tsx";
  const repo = repository(t, { [`apps/mobile/${path}`]: "export const config = { label: 'Before' };\n" },
    { [`apps/mobile/${path}`]: "export const config = { label: 'After' };\n" });
  const app = { ...repo, directory: join(repo.directory, "apps/mobile") };
  const result = summarize(app, plan(app, [tracked(surface("settings", path), [path])])).settings;
  assert.equal(result.impact, "direct");
  assert.equal(result.files[0].path, path);
  assert.equal(result.files[0].patch, undefined);
  assert.deepEqual(result.files[0].hunks, [{ baseStart: 1, baseLines: 1, headStart: 1, headLines: 1 }]);
  assert.equal(result.files[0].facts[0].before, "'Before'");
  assert.equal(result.files[0].facts[0].after, "'After'");
  assert.equal(result.files[0].headBlobSha, git(repo.directory, "rev-parse", `${repo.headSha}:apps/mobile/${path}`));
});

test("identified JSX additions describe literal text and only an explicit inline router.push call", (t) => {
  const path = "src/profile.tsx";
  const dependency = "src/shared-guide.tsx";
  const repo = repository(t, { [path]: "export function Profile() { return <View />; }\n", [dependency]: "export function Guide() { return <View />; }\n" }, {
    [path]: "export function Profile() { return <View>\n  <Button testID=\"open-guide\" onPress={() => router.push('/profile/guide')}>\n    <Text>Care guide</Text>\n  </Button>\n</View>; }\n",
    [dependency]: "export function Guide() { return <Button testID=\"guide-back\">Back</Button>; }\n",
  });
  const result = summarize(repo, plan(repo, [tracked(surface("profile", path), [path, dependency])])).profile;
  assert.equal(result.summary, "Its own source changed. Something it imports changed. Added Button “open-guide” with text “Care guide”; onPress contains router.push('/profile/guide').");
  const fact = result.files[0].facts[0];
  assert.equal(fact.kind, "jsx-added");
  assert.equal(fact.after, "Care guide");
  assert.deepEqual(fact.headLines, { start: 2, end: 4 });
  assert.equal(fact.baseLines, undefined);
  assert.ok(result.files.find((file) => file.path === dependency).facts.some((fact) => /guide-back/.test(fact.summary)));
  assert.doesNotMatch(result.summary, /guide-back/, "A shared screen's control must not be described as this screen's direct edit");
});

test("added and removed surface summaries remain exactly Added or Removed with full source facts retained", (t) => {
  const removed = "src/app/retired.tsx", added = "src/app/new.tsx";
  const repo = repository(t, { [removed]: "export default function Retired() { return <Button nativeID=\"retire\">Retire</Button>; }\n" }, {
    [added]: "export default function New() { return <Button nativeID=\"create\">Create</Button>; }\n",
  });
  const oldSurface = surface("retired", removed), newSurface = surface("new", added);
  const result = summarize(repo, plan(repo, [
    { ...tracked(oldSurface, [removed], "removed"), headSurface: null, headCapture: false },
    { ...tracked(newSurface, [added], "added"), baseSurface: null, baseCapture: false },
  ]));
  // An added or removed screen names the route, so the note reads on its own.
  assert.equal(result.retired.summary, "Removed /retired screen.");
  assert.equal(result.new.summary, "Added /new screen.");
  assert.equal(result.retired.files[0].facts[0].kind, "jsx-removed");
  assert.equal(result.new.files[0].facts[0].kind, "jsx-added");
  assert.equal(result.retired.files[0].headBlobSha, undefined);
  assert.equal(result.new.files[0].baseBlobSha, undefined);
});

test("Git commit blobs win over dirty working files and external diff/textconv commands never execute", (t) => {
  const path = "src/config.ts";
  const repo = repository(t, { [path]: "export const config = { label: 'Before' };\n", ".gitattributes": "*.ts diff=unsafe\n" }, {
    [path]: "export const config = { label: 'After' };\n", ".gitattributes": "*.ts diff=unsafe\n",
  });
  const sentinel = join(repo.directory, "unexpected-execution");
  const script = join(repo.directory, "unsafe-diff");
  writeFileSync(script, `#!/bin/sh\ntouch '${sentinel}'\nexit 0\n`);
  chmodSync(script, 0o755);
  git(repo.directory, "config", "diff.unsafe.command", script);
  git(repo.directory, "config", "diff.unsafe.textconv", script);
  writeFileSync(join(repo.directory, path), "export const config = { label: 'Uncommitted value' };\n");
  const result = summarize(repo, plan(repo, [tracked(surface("config", path), [path])])).config;
  assert.equal(result.summary, "Its own source changed. Changed label from “Before” to “After”.");
  assert.equal(existsSync(sentinel), false);
  assert.match(readFileSync(join(repo.directory, path), "utf8"), /Uncommitted value/, "The summarizer must not alter the checkout");
});

test("unknown and ambiguous code retains exact paths and hunks without fabricated property pairing", (t) => {
  const path = "src/anonymous.ts", css = "src/theme.css";
  const repo = repository(t, {
    [path]: "export const items = [{ label: 'One' }, { label: 'Two' }];\n",
    [css]: ".title { color: red; }\n",
  }, {
    [path]: "export const items = [{ label: 'Two' }];\n",
    [css]: ".title { color: blue; }\n",
  });
  const result = summarize(repo, plan(repo, [tracked(surface("anonymous", path, [css]), [path, css])])).anonymous;
  assert.ok(result.files.every((file) => file.facts.every((fact) => fact.kind === "code")));
  assert.ok(result.files.every((file) => file.hunks.length === 1));
  assert.deepEqual(result.files.find((file) => file.path === path).hunks, [{ baseStart: 1, baseLines: 1, headStart: 1, headLines: 1 }]);
  assert.doesNotMatch(result.summary, /from “One” to “Two”/);
});

test("summary bounds retain blob identities and explicitly mark omitted source evidence", (t) => {
  const path = "src/many.ts", oversized = "src/large.ts";
  const lines = (side) => Array.from({ length: 12 }, (_, index) => `export const item${index} = { label: '${side}-${index}' };\n${'// unchanged\n'.repeat(3)}`).join("");
  const large = "x".repeat(SOURCE_CHANGE_SUMMARY_LIMITS.sourceBytesPerFile + 100);
  const base = { [path]: lines("before"), [oversized]: `export const value='${large}before';\n` };
  const head = { [path]: lines("after"), [oversized]: `export const value='${large}after';\n` };
  for (let index = 0; index < 10; index++) {
    base[`styles/${index}.css`] = ".x { color:red; }\n";
    head[`styles/${index}.css`] = ".x { color:blue; }\n";
  }
  const repo = repository(t, base, head);
  const results = summarize(repo, plan(repo, [
    tracked(surface("many", path), [path]),
    tracked(surface("large", oversized), [oversized]),
    tracked(surface("styles", "styles/0.css", Object.keys(base).filter((name) => name.startsWith("styles/"))), Object.keys(base).filter((name) => name.startsWith("styles/"))),
  ]));
  assert.equal(results.many.files[0].facts.length, SOURCE_CHANGE_SUMMARY_LIMITS.factsPerFile);
  assert.equal(results.many.files[0].hunks.length, SOURCE_CHANGE_SUMMARY_LIMITS.hunksPerFile);
  assert.equal(results.many.truncated, true);
  assert.equal(results.large.truncated, true);
  assert.match(results.large.files[0].baseBlobSha, /^[a-f0-9]{40}$/);
  assert.equal(results.large.files[0].facts[0].kind, "code");
  assert.equal(results.large.files[0].patch, undefined);
  assert.equal(results.large.files[0].patchTruncated, undefined);
  assert.equal(results.styles.files.length, SOURCE_CHANGE_SUMMARY_LIMITS.filesPerSurface);
  assert.equal(results.styles.truncated, true);
  assert.ok(Object.values(results).every((result) => result.summary.length <= SOURCE_CHANGE_SUMMARY_LIMITS.summaryCharacters));
});

test("a comment-only edit to an imported file leaves no source evidence and no imported impact", (t) => {
  const repo = repository(t,
    { "src/theme.ts": "export const tint = 'blue';\n", "src/label.ts": "export const label = 'Before';\n" },
    { "src/theme.ts": "// Palette.\nexport const tint = 'blue';\n", "src/label.ts": "export const label = 'After';\n" });
  const entry = surface("home", "src/home.tsx", ["src/theme.ts", "src/label.ts"]);
  const result = summarize(repo, plan(repo, [tracked(entry, ["src/label.ts"])])).home;
  assert.equal(result.impact, "dependency");
  assert.deepEqual(result.files.map((file) => file.path), ["src/label.ts"]);
  assert.equal(result.truncated, false);
});

test("unrelated surfaces remain unchanged and exact SHA validation rejects an ungrounded comparison", (t) => {
  const repo = repository(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const entry = surface("unrelated", "src/unrelated.tsx");
  const sourcePlan = plan(repo, [tracked(entry, [], "unchanged")]);
  const result = summarize(repo, sourcePlan).unrelated;
  assert.equal(result.impact, "none");
  assert.equal(result.summary, "No source changes affect this surface.");
  assert.deepEqual(result.files, []);
  assert.throws(() => createSourceChangeSummaries({ baseProject: repo.directory, headProject: repo.directory, plan: { ...sourcePlan, baseSha: "a".repeat(40) } }), /immutable Git|exact full/);
});
