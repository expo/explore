import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { stageViewer } from "../scripts/stage-viewer.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "explore-stage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, "dist", "viewer");
  const hosted = join(root, "viewer-host", "public", "viewer");
  await mkdir(local, { recursive: true });
  await mkdir(hosted, { recursive: true });
  await writeFile(join(local, "index.html"), '<script src="/assets/local.js"></script>');
  await writeFile(join(local, "local-only.txt"), "local bundle must survive hosting builds");
  await writeFile(join(hosted, "index.html"), "previous hosted bundle");
  return { root, local, hosted };
}

function builder(root, fail) {
  let output;
  const run = (_command, args, options) => {
    assert.equal(options.cwd, root);
    if (args.includes("tsc")) return { status: 0 };
    assert.equal(args[1], "build:viewer");
    assert.equal(args[args.indexOf("--base") + 1], "/viewer/");
    assert.ok(args.includes("--outDir"), "hosting must override Vite's local output directory");
    output = args[args.indexOf("--outDir") + 1];
    assert.ok(relative(root, output).startsWith(".."), "build scratch directory must be outside the repository");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "index.html"), '<script src="/viewer/bundle.js"></script><link href="/viewer/style.css" rel="stylesheet">');
    writeFileSync(join(output, "style.css"), "body{color:black}");
    writeFileSync(join(output, "bundle.js"), 'fetch("/api/workspace",{credentials:"same-origin"})');
    return { status: fail === "build" ? 1 : 0 };
  };
  return { run, output: () => output };
}

async function assertLocalBundle(local) {
  assert.equal(await readFile(join(local, "index.html"), "utf8"), '<script src="/assets/local.js"></script>');
  assert.equal(await readFile(join(local, "local-only.txt"), "utf8"), "local bundle must survive hosting builds");
  assert.deepEqual((await readdir(local)).sort(), ["index.html", "local-only.txt"]);
}

test("host staging uses an isolated build and leaves the local Viewer bundle unchanged", async t => {
  const { root, local, hosted } = await fixture(t);
  const build = builder(root);
  const installed = await stageViewer(root, build.run);
  assert.equal(installed.root, hosted);
  assert.match(await readFile(join(hosted, "index.html"), "utf8"), /\/viewer\/bundle\.js/);
  const generated = await readFile(join(root, "viewer-host", "src", "generated", "viewer-entry.js"), "utf8");
  assert.ok(generated.includes("export const viewerIndexHtml = "));
  assert.equal(generated.includes("viewerBundleDigest"), false);
  await assertLocalBundle(local);
  await assert.rejects(access(dirname(build.output())), { code: "ENOENT" });
  assert.deepEqual(await readdir(dirname(hosted)), ["viewer"]);
});

test("failed hosted builds preserve both installed bundles and clean temporary output", async t => {
  const { root, local, hosted } = await fixture(t);
  const build = builder(root, "build");
  await assert.rejects(stageViewer(root, build.run), /build failed/);
  await assertLocalBundle(local);
  assert.equal(await readFile(join(hosted, "index.html"), "utf8"), "previous hosted bundle");
  await assert.rejects(access(dirname(build.output())), { code: "ENOENT" });
  assert.deepEqual(await readdir(dirname(hosted)), ["viewer"]);
});
