import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { assertPlanConsistency, buildVerifiedPlan, scopeSourceChanges } = await tsImport("../../src/ci/verified-plan.ts", import.meta.url);
const { readSourceSnapshot } = await tsImport("../../src/source/dependency-graph.ts", import.meta.url);
const config = { mode: "deterministic", app: { platform:"ios", bundleId:"example.test", easProfile:"simulator" }, navigation:{provider:"expo-router"}, device:{name:"iPhone"}, exploration:{scope:"changes"}, capture:{maxMinutes:5,maxActions:5} };
const page = "export default function Screen(){return null;}";
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding:"utf8", stdio:["ignore","pipe","pipe"] }).trim();
async function repository(t) {
  const temp = await mkdtemp(join(tmpdir(), "explore-source-plan-"));
  t.after(() => rm(temp, {recursive:true,force:true}));
  const root=join(temp,"original"); await mkdir(root);
  git(root,"init","-q"); git(root,"config","user.email","test@example.invalid"); git(root,"config","user.name","Source plan test");
  const put=async (file, content) => { const target=join(root,file); await mkdir(dirname(target),{recursive:true}); await writeFile(target,content); };
  const commit=message => { git(root,"add","-A"); git(root,"commit","-q","-m",message); return git(root,"rev-parse","HEAD"); };
  return {root,temp,put,commit};
}
const captured=plan => plan.surfaces.filter(row=>row.headCapture).map(row=>row.headSurface.route).sort();

test("fresh processes verify app-relative plans in nested Git projects and separate checkouts", async t => {
  const {root,temp,put,commit}=await repository(t);
  await put("apps/mobile/app/one.tsx",page); await put("apps/mobile/app/two.tsx",page);
  await put("apps/mobile/.expo-explore/surfaces.json","invalid JSON cannot be an input");
  await put("apps/other/app/unrelated.tsx",page);
  const sha=commit("base");
  const checkout=join(temp,"different-location"); git(root,"worktree","add","--detach",checkout,sha);
  const a=join(root,"apps/mobile"), b=join(checkout,"apps/mobile");
  assert.equal(readSourceSnapshot(a,sha).has("apps/mobile/app/one.tsx"),true);
  assert.equal([...readSourceSnapshot(a,sha).keys()].some(path=>path.endsWith("surfaces.json")),false);
  const outputA=join(temp,"plan-a"), outputB=join(temp,"plan-b");
  const first=await buildVerifiedPlan({baseProject:a,headProject:b,baseSha:sha,headSha:sha,config,output:outputA,scope:"all"});
  await buildVerifiedPlan({baseProject:b,headProject:a,baseSha:sha,headSha:sha,config,output:outputB,scope:"all"});
  assert.deepEqual(captured(first),["/one","/two"]);
  assert.ok(first.surfaces.every(row=>row.headSurface.routeFile.startsWith("app/")));
  assert.equal(await readFile(join(outputA,"plan.json"),"utf8"),await readFile(join(outputB,"plan.json"),"utf8"));
  const proof=JSON.parse(await readFile(join(outputA,"consistency.json"),"utf8"));
  assert.equal(proof.verified,true); assert.equal(proof.processes,2); assert.match(proof.sha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(join(outputA,"plan.json"),"utf8")).headSha,undefined);
  assert.equal(JSON.parse(await readFile(join(outputA,"execution-plan.json"),"utf8")).headSha,sha);
});

test("workspace runtime changes conservatively invalidate nested app captures while docs do not", async t => {
  const {root,temp,put,commit}=await repository(t);
  await put("apps/mobile/app/one.tsx",page); await put("packages/theme/index.ts","export const color='red';");
  const base=commit("base");
  await put("README.md","documentation"); const docs=commit("docs");
  const project=join(root,"apps/mobile");
  const docPlan=await buildVerifiedPlan({baseProject:project,headProject:project,baseSha:base,headSha:docs,config,output:join(temp,"docs-plan")});
  assert.deepEqual(captured(docPlan),[]); assert.equal(docPlan.conservative,false);
  await put("packages/theme/index.ts","export const color='blue';"); const head=commit("theme");
  const changed=await buildVerifiedPlan({baseProject:project,headProject:project,baseSha:docs,headSha:head,config,output:join(temp,"theme-plan")});
  assert.equal(changed.conservative,true); assert.deepEqual(captured(changed),["/one"]);
});

test("nested app changes map to the same paths as its source snapshot", async t => {
  const {root,temp,put,commit}=await repository(t);
  await put("apps/mobile/app/one.tsx",page); await put("apps/mobile/app/two.tsx",page); const base=commit("base");
  await put("apps/mobile/app/one.tsx",page.replace("null","<View/>")); const head=commit("head");
  const project=join(root,"apps/mobile");
  const result=await buildVerifiedPlan({baseProject:project,headProject:project,baseSha:base,headSha:head,config,output:join(temp,"plan")});
  assert.deepEqual(captured(result),["/one"]); assert.equal(result.conservative,false);
  assert.ok(result.surfaces.find(row=>row.headSurface.route==="/one").reasons.includes("Source changed: app/one.tsx"));
});

test("moves across app boundaries preserve both app changes and workspace invalidation", () => {
  assert.deepEqual(scopeSourceChanges([{status:"renamed",previousPath:"packages/Screen.tsx",path:"apps/mobile/app/new.tsx"}],"apps/mobile/"),{
    internal:[{status:"added",path:"app/new.tsx"}], external:[{status:"renamed",previousPath:"packages/Screen.tsx",path:"apps/mobile/app/new.tsx"}],
  });
  assert.deepEqual(scopeSourceChanges([{status:"renamed",previousPath:"apps/mobile/app/old.tsx",path:"packages/Screen.tsx"}],"apps/mobile/").internal,[{status:"removed",path:"app/old.tsx"}]);
  assert.deepEqual(scopeSourceChanges([{status:"copied",previousPath:"apps/mobile/app/old.tsx",path:"packages/Screen.tsx"}],"apps/mobile/").internal,[]);
});

test("consistency failures write focused structural differences and retain both complete outputs", async t => {
  const temp=await mkdtemp(join(tmpdir(),"explore-plan-difference-"));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const first=JSON.stringify({surfaces:[{id:"home",status:"modified"}],diagnostics:{base:[]}});
  const second=JSON.stringify({surfaces:[{id:"home",status:"unchanged"}],diagnostics:{base:["new diagnostic"]}});
  await assert.rejects(assertPlanConsistency(first,second,temp),error=>error.code==="PLAN_NOT_DETERMINISTIC" && error.stage==="verify" && error.details.difference==="plan-diff.json");
  assert.equal(await readFile(join(temp,"plan-first.json"),"utf8"),first);
  assert.equal(await readFile(join(temp,"plan-second.json"),"utf8"),second);
  assert.deepEqual(JSON.parse(await readFile(join(temp,"plan-diff.json"),"utf8")),{differences:[
    {path:"/diagnostics/base/0",kind:"added",second:"new diagnostic"},
    {path:"/surfaces/0/status",kind:"changed",first:"modified",second:"unchanged"},
  ],truncated:false});
  await assert.rejects(assertPlanConsistency(JSON.stringify({values:Array(150).fill(0)}),JSON.stringify({values:Array(150).fill(1)}),temp),{code:"PLAN_NOT_DETERMINISTIC"});
  const bounded=JSON.parse(await readFile(join(temp,"plan-diff.json"),"utf8"));
  assert.equal(bounded.differences.length,100); assert.equal(bounded.truncated,true);
});
