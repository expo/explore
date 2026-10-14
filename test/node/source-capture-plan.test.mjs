import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { createSourceCapturePlan, canonicalPlan, verifyDeterministicPlan } = await tsImport("../../src/source/capture-plan.ts", import.meta.url);
const { validateCapturePlan } = await tsImport("../../src/contracts/capture.ts", import.meta.url);
const page = "export default function Screen(){return null;}";
const links = (...paths) => `import {router} from 'expo-router'; export default function Screen(){${paths.map(path => `router.push(${JSON.stringify(path)});`).join("")}return null;}`;
function plan({ base = [["app/one.tsx", page], ["app/two.tsx", page]], head = base, changes = [], mode, ...rest } = {}) {
  return createSourceCapturePlan({ baseSha: "a".repeat(40), headSha: "b".repeat(40), baseFiles: new Map(base), headFiles: new Map(head), changedFiles: changes, ...(mode ? { mode } : {}), ...rest });
}
const selectedPaths = (value, side = "head") => value.surfaces.filter(row => row[`${side}Capture`]).map(row => row[`${side}Surface`].route).sort();

test("unchanged source and docs schedule no captures; all captures the source inventory", () => {
  assert.deepEqual(selectedPaths(plan({ changes: [{status:"modified",path:"README.md"}] })), []);
  assert.deepEqual(selectedPaths(plan({mode:"all"})), ["/one", "/two"]);
});

test("import closure attributes component and platform-source changes to dependent routes", () => {
  const files = [["app/one.tsx", 'export { default } from "../src/one";'], ["app/two.tsx", page], ["src/one.tsx", 'import theme from "./theme"; export default () => theme;'], ["src/theme.ios.ts", "export default 1;"], ["src/theme.android.ts", "export default 2;"]];
  assert.deepEqual(selectedPaths(plan({base:files,changes:[{status:"modified",path:"src/theme.ios.ts"}]})), ["/one"]);
  assert.deepEqual(selectedPaths(plan({base:files,platform:"android",changes:[{status:"modified",path:"src/theme.ios.ts"}]})), []);
});

test("route additions and removals are independently inventoried at each commit", () => {
  const result = plan({base:[["app/removed.tsx",page]],head:[["app/added.tsx",page]]});
  assert.deepEqual(selectedPaths(result,"base"), ["/removed"]);
  assert.deepEqual(selectedPaths(result), ["/added"]);
  assert.deepEqual(result.surfaces.map(row=>row.status).sort(), ["added","removed"]);
});

test("changed routes include ancestors and descendants without ancestor sibling branches", () => {
  const files = [["app/start.tsx",links("/changed","/sibling")],["app/changed.tsx",links("/end")],["app/end.tsx",page],["app/sibling.tsx",page]];
  const result = plan({base:files,changes:[{status:"modified",path:"app/changed.tsx"}]});
  assert.deepEqual(selectedPaths(result),["/changed","/end","/start"]);
  assert.equal(result.surfaces.find(row=>row.headSurface.route==="/changed").status,"modified");
  assert.equal(result.surfaces.find(row=>row.headSurface.route==="/end").status,"unchanged");
});

test("source snapshots detect modifications even when a caller omits a diff entry", () => {
  const result=plan({base:[["app/one.tsx",page]],head:[["app/one.tsx",page.replace("null","<View/>")]]});
  assert.equal(result.surfaces[0].status,"modified");
});

test("excluded routes stay in the inventory and navigation context but are never captured", () => {
  const files = [["app/start.tsx", links("/changed")], ["app/changed.tsx", links("/end")], ["app/end.tsx", page]];
  const changes = [{ status: "modified", path: "app/changed.tsx" }];
  const result = plan({ base: files, changes, exclude: ["/changed"] });
  assert.deepEqual(selectedPaths(result), ["/end", "/start"]);
  assert.deepEqual(selectedPaths(result, "base"), ["/end", "/start"]);
  assert.equal(result.surfaces.length, 3);
  assert.equal(result.surfaces.find(row => row.headSurface.route === "/changed").status, "modified");
  assert.deepEqual(result.excludedSurfaceIds, [result.surfaces.find(row => row.headSurface.route === "/changed").id]);
  assert.doesNotThrow(() => validateCapturePlan(result));
  // Any route name works, as for setup requiresRoute; a plan without exclusions keeps its shape.
  const byId = plan({ base: files, mode: "all", exclude: [result.excludedSurfaceIds[0]] });
  assert.deepEqual(selectedPaths(byId), ["/end", "/start"]);
  assert.equal("excludedSurfaceIds" in plan({ base: files, changes }), false);
  // The validator recomputes selection with the exclusion, and rejects a plan that drops it.
  const { excludedSurfaceIds: _dropped, ...withoutExclusion } = result;
  assert.throws(() => validateCapturePlan(withoutExclusion), /Capture selection disagrees/);
  assert.throws(() => validateCapturePlan({ ...result, excludedSurfaceIds: ["not-a-surface"] }), /Invalid excludedSurfaceIds/);
  assert.throws(() => plan({ base: files, exclude: ["/missing"] }), error => error.code === "EXCLUDE_ROUTE_UNKNOWN" && /\/missing/.test(error.message));
});

test("redirect routes remain inventory but never become screenshot captures", () => {
  const result=plan({base:[["app/index.tsx",'import {Redirect} from "expo-router"; export default () => <Redirect href="/one"/>;'],["app/one.tsx",page]],mode:"all"});
  assert.equal(result.surfaces.length,2);
  assert.deepEqual(selectedPaths(result),["/one"]);
});

test("a redirect changes only when its own declaration changes", () => {
  const redirect = target => `import {Redirect} from "expo-router"; import {ready} from "../src/state"; export default () => <Redirect href="${target}"/>;`;
  const state = ["src/state.ts", "export const ready = true;\n"];
  const base = [["app/index.tsx", redirect("/one")], ["app/one.tsx", page], state];
  // An imported module changed, but the redirect still forwards to the same route.
  const imported = plan({ base, head: [["app/index.tsx", redirect("/one")], ["app/one.tsx", page], ["src/state.ts", "export const ready = false;\n"]],
    changes: [{ status: "modified", path: "src/state.ts" }] });
  const indexOf = result => result.surfaces.find(surface => (surface.headSurface ?? surface.baseSurface).route === "/");
  assert.equal(indexOf(imported).status, "unchanged");
  assert.deepEqual(indexOf(imported).reasons, []);
  // The declaration itself changed, so the redirect is a real difference.
  const retargeted = plan({ base, head: [["app/index.tsx", redirect("/two")], ["app/one.tsx", page], ["app/two.tsx", page], state],
    changes: [{ status: "modified", path: "app/index.tsx" }] });
  assert.equal(indexOf(retargeted).status, "modified");
  assert.deepEqual(indexOf(retargeted).reasons, ["Source route definition changed"]);
});

test("retargeting a redirect captures the existing destination on each revision", () => {
  const files = target => [
    ["app/index.tsx", `import { Redirect } from "expo-router"; export default () => <Redirect href="${target}" />;`],
    ["app/one.tsx", page], ["app/two.tsx", page], ["app/unrelated.tsx", page],
  ];
  const result = plan({ base: files("/one"), head: files("/two"),
    changes: [{ status: "modified", path: "app/index.tsx" }] });
  assert.deepEqual(selectedPaths(result, "base"), ["/one"]);
  assert.deepEqual(selectedPaths(result, "head"), ["/two"]);
  assert.equal(result.surfaces.find(surface => surface.headSurface.route === "/").status, "modified");
  assert.equal(validateCapturePlan(result), result);
});

test("retargeting through unchanged forwarding routes captures their first screen destinations", () => {
  const redirect = target => `import { Redirect } from "expo-router"; export default () => <Redirect href="${target}" />;`;
  const files = target => [
    ["app/index.tsx", redirect(target)], ["app/old-alias.tsx", redirect("/one")], ["app/new-alias.tsx", redirect("/two")],
    ["app/one.tsx", links("/unrelated")], ["app/two.tsx", links("/unrelated")], ["app/unrelated.tsx", page],
  ];
  const result = plan({ base: files("/old-alias"), head: files("/new-alias"),
    changes: [{ status: "modified", path: "app/index.tsx" }] });
  assert.deepEqual(selectedPaths(result, "base"), ["/one"]);
  assert.deepEqual(selectedPaths(result, "head"), ["/two"]);
  assert.equal(validateCapturePlan(result), result);
});

test("package.json changes are app-wide unless they only touch scripts that install and build never run", () => {
  const manifest = scripts => JSON.stringify({ name: "app", dependencies: { expo: "1" }, scripts });
  const files = pkg => [["app/one.tsx", page], ["app/two.tsx", page], ["package.json", pkg]];
  const selected = (before, after) => selectedPaths(plan({ base: files(before), head: files(after), changes: [{ status: "modified", path: "package.json" }] }));
  const base = manifest({ test: "jest", postinstall: "patch-package" });
  assert.deepEqual(selected(base, manifest({ test: "jest && tsx auth", "test:auth": "tsx auth", postinstall: "patch-package" })), []);
  assert.deepEqual(selected(base, manifest({ test: "jest", postinstall: "patch-package && pods" })), ["/one", "/two"]);
  assert.deepEqual(selected(base, manifest({ test: "jest", postinstall: "patch-package", "eas-build-pre-install": "setup" })), ["/one", "/two"]);
  assert.deepEqual(selected(manifest({ gen: "a", postinstall: "npm run gen" }), manifest({ gen: "b", postinstall: "npm run gen" })), ["/one", "/two"]);
  assert.deepEqual(selected(base, JSON.stringify({ name: "app", dependencies: { expo: "2" }, scripts: { test: "jest", postinstall: "patch-package" } })), ["/one", "/two"]);
  assert.deepEqual(selected(base, "{"), ["/one", "/two"]);
  // npm runs pre<name>/post<name> around a script a hook calls, and hooks reach scripts transitively.
  const hooked = extra => manifest({ postinstall: "npm run build", build: "npm run gen", ...extra });
  assert.deepEqual(selected(hooked({ prebuild: "a" }), hooked({ prebuild: "b" })), ["/one", "/two"]);
  assert.deepEqual(selected(hooked({ gen2: "x" }), manifest({ postinstall: "npm run build", build: "npm run gen", gen: "y", gen2: "x" })), ["/one", "/two"]);
  assert.deepEqual(selected(hooked({ lint: "a" }), hooked({ lint: "b" })), []);
  // An EAS custom build can run any package script.
  const custom = [["eas.json", JSON.stringify({ build: { explore: { config: "explore.yml" } } })]];
  assert.deepEqual(selectedPaths(plan({ base: [...files(base), ...custom], head: [...files(manifest({ test: "vitest", postinstall: "patch-package" })), ...custom],
    changes: [{ status: "modified", path: "package.json" }] })), ["/one", "/two"]);
});

test("app-wide inputs that no route imports mark every surface modified", () => {
  const files = [["app/one.tsx", page], ["app/two.tsx", page], ["package.json", JSON.stringify({ main: "index.js" })], ["index.js", "import 'expo-router/entry';"]];
  for (const path of ["eas.json", ".env", ".env.production", "tailwind.config.js", "postcss.config.cjs", "index.js"]) {
    const head = files.some(([name]) => name === path) ? files.map(([name, text]) => [name, name === path ? `${text}\n` : text]) : [...files, [path, "{}"]];
    assert.deepEqual(selectedPaths(plan({ base: files, head, changes: [{ status: files.some(([name]) => name === path) ? "modified" : "added", path }] })), ["/one", "/two"], path);
  }
  assert.deepEqual(selectedPaths(plan({ base: files, head: [...files, ["docs/eas.json", "{}"]], changes: [{ status: "added", path: "docs/eas.json" }] })), []);
});

test("unresolved runtime imports conservatively expand runtime changes, never documentation changes", () => {
  const files=[["app/one.tsx",'export default function Screen(){const page=require(which);return null;}'],["app/two.tsx",page]];
  assert.equal(plan({base:files,changes:[{status:"modified",path:"src/data.ts"}]}).conservative,true);
  assert.deepEqual(selectedPaths(plan({base:files,changes:[{status:"modified",path:"docs/guide.md"}]})),[]);
});

test("old inventory bytes never influence plan membership or status", () => {
  const files=[["app/one.tsx",page],[".expo-explore/surfaces.json","invalid JSON"]];
  assert.equal(canonicalPlan(plan({base:files})),canonicalPlan(plan({base:[["app/one.tsx",page]]})));
  assert.deepEqual(selectedPaths(plan({base:files,changes:[{status:"modified",path:".expo-explore/surfaces.json"}]})),[]);
});

test("a supplied route array cannot replace the source-derived inventory", () => {
  assert.throws(() => plan({ baseRoutes: [] }), /must match the source-derived inventory/);
});

test("canonical plan excludes execution commits and committed hunk metadata", () => {
  const result=plan();
  const other={...result,baseSha:"c".repeat(40),headSha:"d".repeat(40),surfaces:result.surfaces.map(row=>({...row,sourceChange:{headSha:"d".repeat(40)}}))};
  assert.equal(canonicalPlan(result),canonicalPlan(other));
  assert.equal(canonicalPlan(result).includes("baseSha"),false);
});

test("determinism verifier recomputes a plan with shuffled source/diff enumeration", () => {
  const files = new Map([["app/two.tsx",page],["app/one.tsx",links("/two")]]);
  const result=verifyDeterministicPlan({baseSha:"a".repeat(40),headSha:"b".repeat(40),baseFiles:files,headFiles:files,changedFiles:[{status:"modified",path:"app/two.tsx"},{status:"modified",path:"app/one.tsx"}]});
  assert.equal(result.deterministic,true); assert.match(result.digest,/^[a-f0-9]{64}$/);
});

