import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { discoverRoutes } = await tsImport("../../src/source/route-inventory.ts", import.meta.url);
const { validateSourceRoute } = await tsImport("../../src/contracts/source-route.ts", import.meta.url);
const { createSourceCapturePlan, canonicalPlan } = await tsImport("../../src/source/capture-plan.ts", import.meta.url);
const page = "export default function Page() { return null; }";
const snapshot = entries => new Map(entries);

test("Expo Router discovers file routes without an authored inventory and ignores poisoned inventories", () => {
  const entries = [["app/index.tsx", page], ["app/(tabs)/settings.tsx", page], ["app/_layout.tsx", page], ["app/users/[id].tsx", page],
    ["app/items+api.ts", "export function GET(){}"], ["app/+not-found.tsx", page], ["app/x.test.tsx", page], ["app/types.d.ts", ""], ["app/__explore/enter.tsx", page]];
  const plain = discoverRoutes(snapshot(entries));
  const poisoned = discoverRoutes(snapshot([...entries, [".expo-explore/surfaces.json", "not valid JSON"], ["surfaces.json", '{"surfaces":[{"id":"fake"}]}']]));
  assert.deepEqual(poisoned, plain);
  assert.deepEqual(plain.routes.map(route => route.path).sort(), ["/", "/settings", "/users/[id]"]);
  assert.ok(plain.diagnostics.some(message => message.includes("parameter id")));
  for (const route of plain.routes) { assert.equal("fixture" in route, false); assert.equal("landmark" in route, false); validateSourceRoute(route); }
});

test("platform selection and group-qualified identities remain distinct and stable", () => {
  const files = snapshot([["src/app/(one)/settings.tsx", page], ["src/app/(one)/settings.ios.tsx", page], ["src/app/(one)/settings.android.tsx", page], ["src/app/(two)/settings.tsx", page]]);
  const ios = discoverRoutes(files, { platform: "ios" });
  const android = discoverRoutes(files, { platform: "android" });
  assert.equal(ios.routes.length, 2);
  assert.equal(new Set(ios.routes.map(route => route.id)).size, 2);
  assert.deepEqual(ios.routes.map(route => route.id), android.routes.map(route => route.id));
  assert.ok(ios.routes.some(route => route.routeFile.endsWith("settings.ios.tsx")));
  assert.ok(android.routes.some(route => route.routeFile.endsWith("settings.android.tsx")));
  assert.deepEqual(ios.routes.map(route => route.path), ["/settings", "/settings"]);
});

test("shared groups expand from source; supplied params change reachability without changing route identity", () => {
  const files = snapshot([["app/(home,search)/products/[id].tsx", page]]);
  const raw = discoverRoutes(files);
  const concrete = discoverRoutes(files, { parameters: { "/products/[id]": { id: "sample id" } } });
  assert.equal(raw.routes.length, 2);
  assert.deepEqual(raw.routes.map(route => route.id), concrete.routes.map(route => route.id));
  assert.deepEqual(concrete.routes.map(route => route.path), ["/products/sample%20id", "/products/sample%20id"]);
});

test("parameters that name no dynamic segment become sorted, encoded query parameters of the app link", () => {
  const files = snapshot([["app/scan/loading.tsx", page], ["app/cats/[id].tsx", page]]);
  const result = discoverRoutes(files, { parameters: {
    "/scan/loading": { hold: "true", action: "x&y z" },
    "/cats/[id]": { id: "42", sort: "new" },
  } });
  const loading = result.routes.find(route => route.logicalPath === "/scan/loading");
  const cat = result.routes.find(route => route.logicalPath === "/cats/[id]");
  assert.equal(loading.path, "/scan/loading?action=x%26y%20z&hold=true");
  assert.deepEqual(loading.parameters, { action: "x&y z", hold: "true" });
  assert.equal(cat.path, "/cats/42?sort=new");
  assert.deepEqual(discoverRoutes(files).routes.map(route => route.id), result.routes.map(route => route.id));
});

test("redirect-only routes are classified separately while conditional routes stay screens", () => {
  const files = snapshot([["app/index.tsx", 'import {Redirect} from "expo-router"; export default () => <Redirect href="/home"/>;'], ["app/home.tsx", page], ["app/account.tsx", 'import {Redirect} from "expo-router"; export default () => ready ? <Redirect href="/home"/> : <View/>;']]);
  const result = discoverRoutes(files);
  assert.equal(result.routes.find(route => route.path === "/").kind, "redirect");
  assert.equal(result.routes.find(route => route.path === "/account").kind, "screen");
  assert.equal(result.navigation.edges.filter(edge => edge.kind === "redirect").length, 2);
});

const redirectFixture = () => [
  ["src/app/index.tsx", `import { Redirect } from 'expo-router'; import { useAtomValue } from 'jotai';
    export default function HomeRoute() { const ready = useAtomValue(state); return <Redirect href={ready ? '/(tabs)/scan' : '/onboarding'} />; }`],
  ["src/app/(tabs)/scan.tsx", page],
  ["src/app/onboarding.tsx", page],
  ["src/app/scan/take-photo.tsx", page],
  ["src/app/scan/select-photo.tsx", `import { SelectPhoto } from '@/screens/scan'; export default function Route() { return <SelectPhoto />; }`],
  ["src/screens/scan/index.ts", `export * from './select-photo';`],
  ["src/screens/scan/select-photo.tsx", `import { useEffect, useMemo } from 'react'; import { View } from 'react-native';
    import { useRouter, useLocalSearchParams } from 'expo-router'; import { createTakePhotoRoute } from './routes';
    export function SelectPhoto() { const router = useRouter(); const params = useLocalSearchParams();
      const action = useMemo(() => params.action, [params.action]);
      useEffect(() => { router.replace(createTakePhotoRoute(action, params.target)); }, [action, router, params.target]);
      return <View />; }`],
  ["src/screens/scan/routes.ts", "export const createTakePhotoRoute = (action, target) => `/scan/take-photo?action=${action}&target=${target}`;"],
  ["src/app/scan/confirm.tsx", `import { Redirect } from 'expo-router'; import { View, Text } from 'react-native';
    export default function Confirm() { const photo = usePhoto(); if (!photo) return <Redirect href='/scan/take-photo' />;
      return <View><Text>Confirm photo</Text></View>; }`],
];

test("state-selected Redirect destinations and re-exported effect redirects retain their exact navigation operations", () => {
  const result = discoverRoutes(snapshot(redirectFixture()));
  const byPath = new Map(result.routes.map(route => [route.path, route]));
  const root = byPath.get("/");
  assert.equal(root.kind, "redirect");
  assert.deepEqual(root.redirectTargets, ["/(tabs)/scan", "/onboarding"]);
  assert.equal(root.redirectTo, undefined, "state-selected destinations must not invent a single target");
  const select = byPath.get("/scan/select-photo");
  assert.equal(select.kind, "redirect");
  assert.deepEqual(select.redirectTargets, ["/scan/take-photo"]);
  assert.equal(select.redirectTo, "/scan/take-photo");
  assert.equal(byPath.get("/scan/confirm").kind, "screen", "a conditional redirect does not remove the actual screen");
  const destinations = from => result.navigation.edges.filter(edge => edge.from === from).map(edge => ({
    path: result.routes.find(route => route.id === edge.to).path, kind: edge.kind, file: edge.sourceFile,
  })).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(destinations(root.id), [
    { path: "/onboarding", kind: "redirect", file: "src/app/index.tsx" },
    { path: "/scan", kind: "redirect", file: "src/app/index.tsx" },
  ]);
  assert.deepEqual(destinations(select.id), [
    { path: "/scan/take-photo", kind: "replace", file: "src/screens/scan/select-photo.tsx" },
  ]);
  assert.ok(result.diagnostics.some(message => message.includes("runtime-computed destination")), "query values remain unknown rather than fabricated");
});

test("only guaranteed redirects with empty content qualify; guarded, asynchronous, interactive and unrelated code stays capturable", () => {
  const imports = `import { useEffect } from 'react'; import { View, Text } from 'react-native'; import { router, Redirect } from 'expo-router';`;
  const cases = {
    "both-branches": [`const ready = useReady(); if (ready) return <Redirect href='/home'/>; return <Redirect href='/settings'/>;`, "redirect"],
    "empty-effect": [`useEffect(() => router.replace('/home'), []); return <View />;`, "redirect"],
    "conditional-effect": [`useEffect(() => { if (ready) router.replace('/home'); }, []); return <View />;`, "screen"],
    "return-before-replace": [`useEffect(() => { if (ready) return; router.replace('/home'); }, []); return <View />;`, "screen"],
    "both-effect-branches": [`useEffect(() => { if (ready) router.replace('/home'); else router.replace('/settings'); }, []); return null;`, "redirect"],
    "effect-with-content": [`useEffect(() => router.replace('/home'), []); return <View><Text>Loading result</Text></View>;`, "screen"],
    "interactive": [`return <View onTouchEnd={() => router.replace('/home')} />;`, "screen"],
    "async-effect": [`useEffect(async () => { await prepare(); router.replace('/home'); }, []); return null;`, "screen"],
    "unresolved-destination": [`return <Redirect href={runtimeDestination} />;`, "screen"],
    "partly-unresolved-destination": [`return <Redirect href={ready ? '/home' : runtimeDestination} />;`, "screen"],
    "unknown-path-helper": [`const destination = '/users/' + userId; return <Redirect href={destination} />;`, "screen"],
    "mutable-destination": [`let destination = '/home'; return <Redirect href={destination} />;`, "screen"],
    "escaped-object-destination": [`const paths = {home: '/home'}; const changed = mutate(paths); return <Redirect href={paths.home} />;`, "screen"],
    "shadowed-router": [`const router = {replace: () => {}}; useEffect(() => router.replace('/home'), []); return null;`, "screen"],
    "shadowed-redirect": [`const Redirect = () => <View />; return <Redirect href='/home' />;`, "screen"],
  };
  const entries = Object.entries(cases).map(([name, [body]]) => [`app/${name}.tsx`, `${imports} export default function Route() { ${body} }`]);
  entries.push(["app/home.tsx", page], ["app/settings.tsx", page]);
  const result = discoverRoutes(snapshot(entries));
  for (const [name, [, expected]] of Object.entries(cases)) {
    assert.equal(result.routes.find(route => route.path === `/${name}`).kind, expected, name);
  }
});

test("redirect proofs follow imported aliases and platform implementations without following cycles or malformed modules", () => {
  const files = snapshot([
    ["app/index.tsx", `export { default } from '../src/entry';`],
    ["src/entry.tsx", `import { Redirect as Forward } from 'expo-router'; const destination = '/home'; export default () => <Forward href={destination}/>;`],
    ["src/entry.android.tsx", `import { View } from 'react-native'; export default () => <View/>;`],
    ["app/home.tsx", page],
    ["app/cycle.tsx", `export { default } from '../src/cycle';`],
    ["src/cycle.tsx", `export { default } from '../app/cycle';`],
    ["app/broken.tsx", `export { default } from '../src/broken';`],
    ["src/broken.tsx", `import { Redirect } from 'expo-router'; export default () => <Redirect href='/home'/>; const = ;`],
    ["app/recursive.tsx", `function Again() { return <Again />; } export default Again;`],
    ["app/oversized.tsx", `import { Redirect } from 'expo-router'; export default function Route() { ${Array.from({length:300}, (_,index) => `const value${index} = ${index};`).join(" ")} return <Redirect href='/home'/>; }`],
  ]);
  const ios = discoverRoutes(files, { platform: "ios" });
  const android = discoverRoutes(files, { platform: "android" });
  assert.equal(ios.routes.find(route => route.path === "/").kind, "redirect");
  assert.equal(android.routes.find(route => route.path === "/").kind, "screen");
  assert.equal(ios.routes.find(route => route.path === "/cycle").kind, "screen");
  assert.equal(ios.routes.find(route => route.path === "/broken").kind, "screen");
  assert.equal(ios.routes.find(route => route.path === "/recursive").kind, "screen");
  assert.equal(ios.routes.find(route => route.path === "/oversized").kind, "screen");
});

test("redirect-only modules remain in inventory but never become capture targets, independent of file order", () => {
  const entries = redirectFixture();
  const makePlan = files => createSourceCapturePlan({ baseSha: "a".repeat(40), headSha: "b".repeat(40),
    baseFiles: snapshot(files), headFiles: snapshot(files), changedFiles: [], mode: "all" });
  const expected = makePlan(entries);
  const redirects = expected.surfaces.filter(surface => surface.headSurface.kind === "redirect");
  assert.equal(redirects.length, 2);
  for (const redirect of redirects) {
    assert.equal(redirect.baseCapture, false);
    assert.equal(redirect.headCapture, false);
    assert.ok(expected.inventorySurfaceIds.includes(redirect.id));
  }
  assert.equal(expected.surfaces.find(surface => surface.headSurface.path === "/scan/confirm").headCapture, true);
  const canonical = canonicalPlan(expected);
  for (let seed = 1; seed <= 12; seed++) {
    const shuffled = [...entries]; let random = seed;
    for (let index = shuffled.length - 1; index > 0; index--) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const target = random % (index + 1);
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    assert.equal(canonicalPlan(makePlan(shuffled)), canonical, `seed ${seed}`);
  }
});

test("redirect-target validation canonicalizes sets and rejects contradictory or empty declarations", () => {
  const route = discoverRoutes(snapshot([["app/home.tsx", page]])).routes[0];
  assert.deepEqual(validateSourceRoute({ ...route, kind: "redirect", redirectTargets: ["/settings", "/home", "/settings"] }).redirectTargets, ["/home", "/settings"]);
  assert.throws(() => validateSourceRoute({ ...route, kind: "redirect" }), /requires redirectTo or redirectTargets/);
  assert.throws(() => validateSourceRoute({ ...route, kind: "redirect", redirectTargets: [] }), /between 1 and 64/);
  assert.throws(() => validateSourceRoute({ ...route, kind: "redirect", redirectTo: "/home", redirectTargets: ["/home", "/settings"] }), /single redirect target/);
  assert.throws(() => validateSourceRoute({ ...route, kind: "redirect", redirectTargets: ["/../secret"] }), /path|route/);
  assert.throws(() => validateSourceRoute({ ...route, redirectTargets: ["/home"] }), /cannot declare redirect targets/);
});

test("both navigation providers converge on the same source route contract", () => {
  const files = snapshot([["package.json", '{"dependencies":{"@react-navigation/native":"7"}}'], ["src/App.tsx", `import {createNativeStackNavigator} from '@react-navigation/native-stack'; import Home from './Home'; const Stack=createNativeStackNavigator({screens:{Home}});`], ["src/Home.tsx", page]]);
  const result = discoverRoutes(files);
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].provider, "react-navigation");
  assert.equal(result.routes[0].path, null);
  assert.equal(result.navigation.contract, "explore.navigation");
});

test("route graph is identical under reversed file enumeration", () => {
  const entries = [["app/b.tsx", page], ["app/a.tsx", 'import {router} from "expo-router"; export default () => <Button onPress={()=>router.push("/b")}/>;'], ["app/_layout.tsx", page]];
  assert.deepEqual(discoverRoutes(snapshot(entries)), discoverRoutes(snapshot(entries.toReversed())));
});

test("source-route validation permits registered names but rejects unsafe URL paths and labels", () => {
  const route = discoverRoutes(snapshot([["app/home.tsx",page]])).routes[0];
  for (const path of ["/../a", "//example.com", "/a/./b", "/a\\b"]) assert.throws(() => validateSourceRoute({...route,path}));
  assert.throws(() => validateSourceRoute({...route,route:"/?token=secret",path:"/"}), /credential-like query key/);
  assert.equal(validateSourceRoute({...route,route:"/users/[id]",path:"/users/[id]"}).route,"/users/[id]");
  for (const logicalPath of ["\n", "   ", "Home\u0000Screen"]) assert.throws(() => validateSourceRoute({...route,logicalPath}));
  assert.equal(validateSourceRoute({...route,provider:"react-navigation",route:"Home Screen",logicalPath:"Root/Home Screen",path:null}).route,"Home Screen");
});
