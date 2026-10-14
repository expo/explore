import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { extractSourceNavigation } = await tsImport("../../src/source/navigation.ts", import.meta.url);
const surface = (id, route = `/${id}`, routeFile = `src/app/${id}.tsx`) => ({
  id, route, routeFile, sourceFiles: [], variant: "default", kind: "screen",
  path: route, provider: "expo-router", logicalPath: route,
});
function graph(surfaces, sources) {
  const files = new Map(surfaces.map((entry) => [entry.routeFile, "export default function Screen() { return null; }"]));
  for (const [file, source] of Object.entries(sources)) files.set(file, source);
  return extractSourceNavigation(surfaces, files);
}
const edges = (result, from) => result.edges.filter((edge) => edge.from === from).map(({ to, kind }) => [to, kind]);

test("resolves bound router aliases, object destinations, imported constants and reexports", () => {
  const result = graph([surface("one"), surface("two"), surface("three")], {
    "src/app/one.tsx": "export { One as default } from '@/screens';",
    "src/screens/index.ts": "export { One } from './one'; export { Unused } from './unused';",
    "src/screens/one.tsx": `import { useRouter as getRouter } from 'expo-router'; import { ROUTES } from './routes';
      export function One() { const navigation = getRouter(); return <Button onPress={() => { navigation.push(ROUTES.two); navigation.dismissTo({pathname: '/three'}); }}/>; }`,
    "src/screens/routes.ts": "export const ROUTES = {two: '/two'} as const;",
    "src/screens/unused.tsx": "import {router} from 'expo-router'; export function Unused(){router.replace('/three'); return null;}",
  });
  assert.deepEqual(edges(result, "one"), [["three", "dismissTo"], ["two", "push"]]);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.edges.every((edge) => edge.provenance === "source" && !('attemptIds' in edge)), true);
});

test("does not infer navigation from unrelated or shadowed router objects", () => {
  const result = graph([surface("one"), surface("two")], {
    "src/app/one.tsx": `import {router} from 'expo-router';
      export default function Screen() { const router = {push() {}}; router.push('/two'); return null; }`,
  });
  assert.deepEqual(result.edges, []);
});

test("extracts Link and conditional Redirect but does not turn external links into destinations", () => {
  const result = graph([surface("one"), surface("two"), surface("three")], {
    "src/app/one.tsx": `import {Link as AppLink, Redirect} from 'expo-router'; export default function One() {
      return <><AppLink href='/two'/><AppLink href='https://example.com'/><Redirect href={ready ? '/two' : '/three'}/></>;
    }`,
  });
  assert.deepEqual(edges(result, "one"), [["three", "redirect"], ["two", "push"], ["two", "redirect"]]);
  assert.deepEqual(result.unresolved, []);
});

test("matches dynamic path patterns only to dynamic route files and prefers exact static routes", () => {
  const result = graph([surface("cats", "/cats"), surface("edit", "/cats/fixture", "src/app/cats/[id].tsx"), surface("guide", "/cats/guide")], {
    "src/app/cats.tsx": "import {router} from 'expo-router'; export default function Cats(){ return <><Button onPress={()=>router.push(`/cats/${cat.id}`)}/><Button onPress={()=>router.push('/cats/guide')}/></>; }",
  });
  assert.deepEqual(edges(result, "cats"), [["edit", "push"], ["guide", "push"]]);
  assert.equal(result.unresolved.some((message) => message.startsWith("Unresolved navigation:")), true);
  const exact = graph([surface("cats"), surface("edit", "/cats/fixture", "src/app/cats/[id].tsx"), surface("guide", "/cats/guide")], {
    "src/app/cats.tsx": "import {router} from 'expo-router'; export default function Cats(){router.push('/cats/guide');return null;}",
  });
  assert.deepEqual(edges(exact, "cats"), [["guide", "push"]]);
});

test("preserves exact known query variants while including same-route state variants", () => {
  const a = surface("mood", "/scan?action=mood", "src/app/scan.tsx");
  const b = {...a, id: "mood-empty", variant: "empty"};
  const result = graph([surface("one"), a, b, surface("art", "/scan?action=art", "src/app/scan.tsx")], {
    "src/app/one.tsx": `import {router} from 'expo-router'; const destination={pathname:'/scan',params:{action:'mood'}};
      export default function One(){router.navigate(destination);return null;}`,
  });
  assert.deepEqual(edges(result, "one"), [["mood", "navigate"], ["mood-empty", "navigate"]]);
});

test("resolves local route helper templates without running the helper", () => {
  const result = graph([surface("one"), surface("mood", "/scan?action=mood", "src/app/scan.tsx"), surface("art", "/scan?action=art", "src/app/scan.tsx")], {
    "src/app/one.tsx": "import {router} from 'expo-router'; import {route} from '../route'; export default function One(){router.push(route('mood'));return null;}",
    "src/route.ts": "export function route(action:string){return `/scan?action=${action}`;}",
  });
  assert.deepEqual(edges(result, "one"), [["mood", "push"]]);
});

test("expands literal imported route catalogs in mapped press handlers without unrelated exported functions", () => {
  const result = graph([surface("one"), surface("two"), surface("three")], {
    "src/app/one.tsx": `import {router} from 'expo-router'; import {catalog} from '../catalog'; export default function One() {
      return <>{catalog.map(item=><Button onPress={()=>router.push(item.route)}/>)}</>;
    }`,
    "src/catalog.ts": "export const catalog=[{route:'/two'},{route:'/three'}];",
  });
  assert.deepEqual(edges(result, "one"), [["three", "push"], ["two", "push"]]);
  assert.deepEqual(result.unresolved, []);
});

test("tab registrations link only their layout descendants, while Stack modal registration is metadata", () => {
  const result = graph([surface("one", "/one", "src/app/(tabs)/one.tsx"), surface("two", "/two", "src/app/(tabs)/two.tsx"), surface("hidden", "/hidden", "src/app/(tabs)/hidden.tsx"), surface("settings", "/settings", "src/app/settings/index.tsx")], {
    "src/app/(tabs)/_layout.tsx": "import {Tabs} from 'expo-router'; export default function Layout(){return <Tabs><Tabs.Screen name='one'/><Tabs.Screen name='two'/><Tabs.Screen name='hidden' options={{href:null}}/></Tabs>;}",
    "src/app/_layout.tsx": "import {Stack} from 'expo-router'; export default function Layout(){return <Stack><Stack.Screen name='settings/index' options={{presentation:'modal'}}/></Stack>;}",
  });
  assert.deepEqual(edges(result, "one"), [["two", "tab"]]);
  assert.deepEqual(edges(result, "settings"), []);
  assert.deepEqual(result.modalSurfaceIds, ["settings"]);
});

test("back and dismiss remain history diagnostics without invented reverse edges", () => {
  const result = graph([surface("one"), surface("two")], {
    "src/app/one.tsx": "import {router} from 'expo-router';export default function One(){router.push('/two');return null;}",
    "src/app/two.tsx": "import {router} from 'expo-router';export default function Two(){router.back();router.dismissAll();return null;}",
  });
  assert.deepEqual(edges(result, "two"), []);
  assert.equal(result.unresolved.length, 2);
  assert.equal(result.unresolved.every((message) => message.startsWith("History-dependent navigation:")), true);
});

test("unsupported destinations and missing route sources are diagnostics without forged links", () => {
  const result = graph([surface("one"), surface("two")], {
    "src/app/one.tsx": "import {router} from 'expo-router';export default function One(){router.push(getRemoteUrl());router.push('/missing');return null;}",
  });
  assert.deepEqual(result.edges, []);
  assert.equal(result.unresolved.length, 2);
  assert.equal(result.unresolved.every((message) => message.startsWith("Unresolved navigation:")), true);
});

test("resolves route-relative imported constants and namespace Router bindings", () => {
  const result = graph([surface("one", "/group/one", "src/app/group/one.tsx"), surface("two", "/group/two", "src/app/group/two.tsx")], {
    "src/app/group/one.tsx": "import * as Expo from 'expo-router';export default function One(){Expo.router.push('./two');return <Expo.Link href='/group/two'/>;}",
  });
  assert.deepEqual(edges(result, "one"), [["two", "push"]]);
});

test("source and edge ordering is deterministic", () => {
  const sources = {"src/app/one.tsx": "import {router} from 'expo-router';export default function One(){router.push('/two');return null;}"};
  assert.deepEqual(graph([surface("one"),surface("two")],sources), graph([surface("two"),surface("one")],sources));
});

test("mutable variables and mutated route objects never masquerade as resolved constants", () => {
  for (const setup of ["let target='/two'; target='/three';", "const target={pathname:'/two'}; target.pathname='/three';"]) {
    const result = graph([surface("one"),surface("two"),surface("three")], {
      "src/app/one.tsx": `import {router} from 'expo-router'; export default function One(){${setup}router.push(target);return null;}`,
    });
    assert.deepEqual(result.edges, []);
    assert.equal(result.unresolved.some(message => message.startsWith("Unresolved navigation:")), true);
  }
});

test("recognizes static computed router methods and destructured or aliased router actions", () => {
  const result = graph([surface("one"), surface("two"), surface("three")], {
    "src/app/one.tsx": `import {router,useRouter} from 'expo-router';export default function One(){
      const {navigate:go}=router; const push=router.push; const {dismissTo}=useRouter();
      router['replace']('/two');go('/three');push('/two');dismissTo('/three');return null;}`,
  });
  assert.deepEqual(edges(result, "one"), [["three","dismissTo"],["three","navigate"],["two","push"],["two","replace"]]);
  assert.deepEqual(result.unresolved, []);
});

test("does not walk unreferenced nested functions or callback declarations", () => {
  const result = graph([surface("one"),surface("two")], {
    "src/app/one.tsx": `import {router} from 'expo-router';export default function One(){
      function unused(){router.push('/two');} const alsoUnused=()=>router.replace('/two');return null;}`,
  });
  assert.deepEqual(result.edges, []);
});

test("follows the create-expo-app alias @/* -> ./* without a diagnostic", () => {
  const result = graph([surface("one"),surface("two")], {
    "tsconfig.json": JSON.stringify({extends:"expo/tsconfig.base",compilerOptions:{strict:true,paths:{"@/*":["./*"]}}}),
    "src/app/one.tsx": "import {Link} from 'expo-router';import {Screen} from '@/components/screen';export default function One(){return <Screen/>;}",
    "components/screen.tsx": "import {Link} from 'expo-router';export function Screen(){return <Link href='/two'>Go</Link>;}",
  });
  assert.equal(result.edges.length, 1);
  assert.equal(result.unresolved.some(message => /module resolution|could not be resolved/.test(message)), false);
});

test("unresolved object hrefs and unsupported custom aliases remain explicit diagnostics", () => {
  const result = graph([surface("one"),surface("two")], {
    "tsconfig.json": JSON.stringify({compilerOptions:{paths:{"~/*":["src/*"]}}}),
    "src/app/one.tsx": "import {router} from 'expo-router';import {Screen} from '~/screen';export default function One(){router.push({pathname:getPath()});return <Screen/>;}",
  });
  assert.deepEqual(result.edges, []);
  assert.equal(result.unresolved.some(message => message.includes("custom module resolution")), true);
  assert.equal(result.unresolved.some(message => message.includes("destination is not a statically resolved route")), true);
  assert.equal(result.unresolved.some(message => message.includes("local imported code could not be resolved")), true);
});

test("resolves the playground onboarding sequence through pathname, useMemo and a static route table", () => {
  const result = graph([surface("welcome","/onboarding","src/app/onboarding/index.tsx"),surface("name","/onboarding/name","src/app/onboarding/name.tsx"),surface("age","/onboarding/age","src/app/onboarding/age.tsx")], {
    "src/app/onboarding/name.tsx": "import {Footer} from '../../footer';export default function Name(){return <Footer/>;}",
    "src/footer.tsx": `import {useRouter,usePathname} from 'expo-router';import {useMemo} from 'react';
      const ROUTES=['/onboarding','/onboarding/name','/onboarding/age'];
      export function Footer(){const router=useRouter();const pathname=usePathname();
      const current=useMemo(()=>ROUTES.findIndex(route=>route===pathname),[pathname]);
      const next=current<0?ROUTES[0]:ROUTES[current+1];return <Button onPress={()=>router.push(next)}/>;}`,
  });
  assert.deepEqual(edges(result,"name"), [["age","push"]]);
});

test("tab state variants do not acquire fabricated navigation between one another", () => {
  const first=surface("one", "/one", "src/app/(tabs)/one.tsx");
  const second={...first,id:"one-empty",variant:"empty"};
  const result=graph([first,second,surface("two","/two","src/app/(tabs)/two.tsx")],{
    "src/app/(tabs)/_layout.tsx":"import {Tabs} from 'expo-router';export default function Layout(){return <Tabs><Tabs.Screen name='one'/><Tabs.Screen name='two'/></Tabs>;}",
  });
  assert.deepEqual(edges(result,"one"),[["two","tab"]]);
  assert.deepEqual(edges(result,"one-empty"),[["two","tab"]]);
});

test("object and array alias writes, escaping helper arguments and Object.assign prevent stale destinations", () => {
  for (const setup of [
    "const target={pathname:'/two'};const alias=target;alias.pathname='/three';",
    "const routes=['/two'];const alias=routes;alias[0]='/three';const target=routes[0];",
    "function mutate(value){value.pathname='/three';}const target={pathname:'/two'};mutate(target);",
    "const target={pathname:'/two'};Object.assign(target,{pathname:'/three'});",
  ]) {
    const result=graph([surface("one"),surface("two"),surface("three")],{
      "src/app/one.tsx":`import {router} from 'expo-router';export default function One(){${setup}router.push(target);return null;}`,
    });
    assert.deepEqual(result.edges,[]);
    assert.equal(result.unresolved.some(message=>message.startsWith("Unresolved navigation:")),true);
  }
});

test("explicit route groups disambiguate otherwise identical paths",()=>{
  const result=graph([surface("one"),surface("alpha","/(alpha)/details","src/app/(alpha)/details.tsx"),surface("beta","/(beta)/details","src/app/(beta)/details.tsx")],{
    "src/app/one.tsx":"import {router} from 'expo-router';export default function One(){router.push('/(alpha)/details');return null;}",
  });
  assert.deepEqual(edges(result,"one"),[["alpha","push"]]);
});

test("reexported navigator components resolve registrations relative to the owning layout",()=>{
  const result=graph([surface("one","/one","src/app/(tabs)/one.tsx"),surface("two","/two","src/app/(tabs)/two.tsx")],{
    "src/app/(tabs)/_layout.tsx":"export {default} from '../../ui/tabs';",
    "src/ui/tabs.tsx":"import {Tabs} from 'expo-router';export default function Layout(){return <Tabs><Tabs.Screen name='one'/><Tabs.Screen name='two'/></Tabs>;}",
  });
  assert.deepEqual(edges(result,"one"),[["two","tab"]]);
  assert.deepEqual(result.unresolved,[]);
});

test("conditional hidden tabs remain possible links and runtime registration names are diagnosed",()=>{
  const result=graph([surface("one","/one","src/app/(tabs)/one.tsx"),surface("two","/two","src/app/(tabs)/two.tsx")],{
    "src/app/(tabs)/_layout.tsx":"import {Tabs} from 'expo-router';export default function Layout(){return <Tabs><Tabs.Screen name='one'/><Tabs.Screen name='two' options={condition?{href:null}:{title:'Two'}}/><Tabs.Screen name={getName()}/></Tabs>;}",
  });
  assert.deepEqual(edges(result,"one"),[["two","tab"]]);
  assert.equal(result.unresolved.some(message=>message.includes("runtime-computed navigator registration")),true);
});

const nativeTabSurfaces = () => [surface("home","/home","src/app/(tabs)/home.tsx"),surface("search","/search","src/app/(tabs)/search.tsx"),surface("settings","/settings","src/app/(tabs)/settings/index.tsx"),surface("about","/about","src/app/about.tsx")];

test("native tab triggers link their layout descendants like Tabs registrations",()=>{
  const result=graph(nativeTabSurfaces(),{
    "src/app/(tabs)/_layout.tsx":`import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs>
      <NativeTabs.Trigger name='home'><NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label><NativeTabs.Trigger.Icon sf='house'/></NativeTabs.Trigger>
      <NativeTabs.Trigger name='search'/><NativeTabs.Trigger name='settings'/></NativeTabs>;}`,
    // In a tab screen a trigger only sets that screen's options; it registers nothing.
    "src/app/(tabs)/home.tsx":"import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Home(){return <NativeTabs.Trigger><NativeTabs.Trigger.Badge>3</NativeTabs.Trigger.Badge></NativeTabs.Trigger>;}",
  });
  assert.deepEqual(edges(result,"home"),[["search","tab"],["settings","tab"]]);
  assert.deepEqual(edges(result,"search"),[["home","tab"],["settings","tab"]]);
  assert.deepEqual(edges(result,"settings"),[["home","tab"],["search","tab"]]);
  assert.deepEqual(edges(result,"about"),[]);
  assert.equal(result.edges.every(edge=>edge.sourceFile==="src/app/(tabs)/_layout.tsx"),true);
  assert.deepEqual(result.unresolved,[]);
  for (const layout of [
    "import {NativeTabs as Native} from 'expo-router/unstable-native-tabs';export default function Layout(){return <Native><Native.Trigger name='home'/><Native.Trigger name='search'/></Native>;}",
    "import * as Native from 'expo-router/unstable-native-tabs';export default function Layout(){return <Native.NativeTabs><Native.NativeTabs.Trigger name='home'/><Native.NativeTabs.Trigger name='search'/></Native.NativeTabs>;}",
    "import {NativeTabs,NativeTabTrigger} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs><NativeTabTrigger name='home'/><NativeTabTrigger name='search'/></NativeTabs>;}",
    "import {NativeTabs} from 'expo-router/unstable-native-tabs';const TABS=['home','search'];export default function Layout(){return <NativeTabs>{TABS.map(name=><NativeTabs.Trigger key={name} name={name}/>)}</NativeTabs>;}",
    // NativeTabs flattens arrays of triggers, however they reach its children.
    "import {NativeTabs} from 'expo-router/unstable-native-tabs';const TABS=['home','search'];export default function Layout(){const triggers=TABS.map(name=><NativeTabs.Trigger key={name} name={name}/>);return <NativeTabs>{triggers}</NativeTabs>;}",
    "import {NativeTabs} from 'expo-router/unstable-native-tabs';function triggers(){return [<NativeTabs.Trigger key='home' name='home'/>,<NativeTabs.Trigger key='search' name='search'/>];}export default function Layout(){return <NativeTabs>{triggers()}</NativeTabs>;}",
    "import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/>{flags.search&&<NativeTabs.Trigger name='search'/>}</NativeTabs>;}",
    "import {Stack} from 'expo-router';import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/><Stack.Protected guard={signedIn}><NativeTabs.Trigger name='search'/></Stack.Protected></NativeTabs>;}",
  ]) {
    const variant=graph(nativeTabSurfaces(),{"src/app/(tabs)/_layout.tsx":layout});
    assert.deepEqual(edges(variant,"home"),[["search","tab"]],layout);
    assert.deepEqual(variant.unresolved,[],layout);
  }
  const lookalike=graph(nativeTabSurfaces(),{
    "src/app/(tabs)/_layout.tsx":"const NativeTabs={Trigger:()=>null};export default function Layout(){return <><NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='search'/></>;}",
  });
  assert.deepEqual(lookalike.edges,[]);
  assert.deepEqual(lookalike.unresolved,[]);
});

test("native tab registrations come only from expo-router's native tabs module, and Tabs.Screen only from expo-router",()=>{
  for (const layout of [
    "import {NativeTabs} from 'react-native-bottom-tabs';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='search'/></NativeTabs>;}",
    "import {NativeTabs} from 'expo-router';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='search'/></NativeTabs>;}",
    "import * as Native from 'react-native-bottom-tabs';export default function Layout(){return <Native.NativeTabs><Native.NativeTabs.Trigger name='home'/><Native.NativeTabs.Trigger name='search'/></Native.NativeTabs>;}",
    "import {NativeTabs} from 'expo-router/unstable-native-tabs';import {NativeTabTrigger} from 'react-native-bottom-tabs';export default function Layout(){return <NativeTabs><NativeTabTrigger name='home'/><NativeTabTrigger name='search'/></NativeTabs>;}",
    "import {Tabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <Tabs><Tabs.Screen name='home'/><Tabs.Screen name='search'/></Tabs>;}",
    "import * as Router from 'expo-router/unstable-native-tabs';export default function Layout(){return <Router.Tabs><Router.Tabs.Screen name='home'/><Router.Tabs.Screen name='search'/></Router.Tabs>;}",
  ]) {
    const result=graph(nativeTabSurfaces(),{"src/app/(tabs)/_layout.tsx":layout});
    assert.deepEqual(result.edges,[],layout);
    assert.deepEqual(result.unresolved,[],layout);
  }
});

test("a nameless trigger in a tab's nested layout sets that tab's options and registers nothing",()=>{
  const surfaces=[surface("home","/home","src/app/(tabs)/home.tsx"),surface("inbox","/inbox","src/app/(tabs)/inbox/index.tsx"),surface("thread","/inbox/thread","src/app/(tabs)/inbox/thread.tsx")];
  const tabs="import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='inbox'/></NativeTabs>;}";
  const plain=graph(surfaces,{"src/app/(tabs)/_layout.tsx":tabs,"src/app/(tabs)/inbox/_layout.tsx":"import {Stack} from 'expo-router';export default function Layout(){return <Stack/>;}"});
  // A tab holding a Stack can only set a runtime badge from its own layout; expo-router throws elsewhere in the stack.
  const badged=graph(surfaces,{"src/app/(tabs)/_layout.tsx":tabs,
    "src/app/(tabs)/inbox/_layout.tsx":"import {Stack} from 'expo-router';import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){const unread=useUnread();return <><NativeTabs.Trigger><NativeTabs.Trigger.Badge>{unread}</NativeTabs.Trigger.Badge></NativeTabs.Trigger><Stack/></>;}"});
  assert.deepEqual(edges(badged,"home"),[["inbox","tab"]]);
  assert.deepEqual(edges(badged,"thread"),[["home","tab"],["inbox","tab"]]);
  assert.deepEqual(badged.edges,plain.edges);
  assert.deepEqual(badged.unresolved,[]);
});

test("a trigger that is not a child of <NativeTabs> is not a tab registration, even in the navigator layout",()=>{
  for (const [children,expected] of [
    ["<View><NativeTabs.Trigger name='search'/></View>",[]],
    ["<><NativeTabs.Trigger name='search'/></>",[]],
    ["<SearchTab/>",[]],
    ["<NativeTabTrigger name='settings'><NativeTabs.Trigger name='search'/></NativeTabTrigger>",[["settings","tab"]]],
  ]) {
    const result=graph(nativeTabSurfaces(),{"src/app/(tabs)/_layout.tsx":`import {NativeTabs,NativeTabTrigger} from 'expo-router/unstable-native-tabs';
      function SearchTab(){return <NativeTabs.Trigger name='search'/>;}
      export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/>${children}</NativeTabs>;}`});
    assert.deepEqual(edges(result,"home"),expected,children);
    assert.deepEqual(result.unresolved,[],children);
  }
});

test("hidden native tab triggers are not tab links, while runtime hidden values remain possible links",()=>{
  const surfaces=["home","secret","flagged","maybe","shown","helper","guest"].map(id=>surface(id,`/${id}`,`src/app/(tabs)/${id}.tsx`));
  const result=graph(surfaces,{
    "src/app/(tabs)/_layout.tsx":`import {NativeTabs} from 'expo-router/unstable-native-tabs';const FLAGS={beta:true};
      function hideBeta(flags){if(!flags)return true;return flags.beta;}
      export default function Layout(){const flags=useFlags();const user=useUser();return <NativeTabs>
      <NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='secret' hidden/><NativeTabs.Trigger name='flagged' hidden={FLAGS.beta}/>
      <NativeTabs.Trigger name='maybe' hidden={condition}/><NativeTabs.Trigger name='shown' hidden={false}/><NativeTabs.Trigger name='retired' hidden/>
      <NativeTabs.Trigger name='helper' hidden={hideBeta(flags)}/><NativeTabs.Trigger name='guest' hidden={user.isGuest?true:user.hideGuest}/></NativeTabs>;}`,
  });
  // A value that is true on one path and runtime-computed on another may still show the tab.
  assert.deepEqual(edges(result,"home"),[["guest","tab"],["helper","tab"],["maybe","tab"],["shown","tab"]]);
  // A hidden trigger without a declared surface is not a missing registration.
  assert.deepEqual(result.unresolved,[]);
});

test("a Tabs href:null that holds only on some paths leaves the tab a possible link",()=>{
  const result=graph(nativeTabSurfaces(),{
    "src/app/(tabs)/_layout.tsx":"import {Tabs} from 'expo-router';export default function Layout(){return <Tabs><Tabs.Screen name='home'/><Tabs.Screen name='search' options={guest?{href:null}:getOptions()}/><Tabs.Screen name='settings' options={{href:null}}/></Tabs>;}",
  });
  assert.deepEqual(edges(result,"home"),[["search","tab"]]);
  assert.deepEqual(result.unresolved,[]);
});

test("runtime-computed and unmatched native tab triggers are diagnosed exactly like Tabs registrations",()=>{
  const layout=(navigator)=>navigator==="Tabs"
    ? "import {Tabs} from 'expo-router';export default function Layout(){return <Tabs><Tabs.Screen name='home'/><Tabs.Screen name='search'/><Tabs.Screen name={getName()}/><Tabs.Screen/><Tabs.Screen name='missing'/></Tabs>;}"
    : "import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='search'/><NativeTabs.Trigger name={getName()}/><NativeTabs.Trigger/><NativeTabs.Trigger name='missing'/></NativeTabs>;}";
  const tabs=graph(nativeTabSurfaces(),{"src/app/(tabs)/_layout.tsx":layout("Tabs")});
  const native=graph(nativeTabSurfaces(),{"src/app/(tabs)/_layout.tsx":layout("NativeTabs")});
  assert.deepEqual(edges(native,"home"),[["search","tab"]]);
  assert.deepEqual(native.edges,tabs.edges);
  assert.deepEqual(native.unresolved,tabs.unresolved);
  assert.deepEqual(native.unresolved,[
    "Unresolved navigation: src/app/(tabs)/_layout.tsx:1: navigator registration has no matching declared surface",
    "Unresolved navigation: src/app/(tabs)/_layout.tsx:1: runtime-computed navigator registration",
  ]);
});

test("an app mixing Tabs, NativeTabs and Stack keeps each tab navigator's links inside its own layout",()=>{
  const result=graph([surface("feed","/feed","src/app/(classic)/feed.tsx"),surface("inbox","/inbox","src/app/(classic)/inbox.tsx"),
    surface("home","/home","src/app/(native)/home.tsx"),surface("profile","/profile","src/app/(native)/profile.tsx"),surface("compose","/compose","src/app/compose.tsx")],{
    "src/app/_layout.tsx":"import {Stack} from 'expo-router';export default function Layout(){return <Stack><Stack.Screen name='(classic)'/><Stack.Screen name='(native)'/><Stack.Screen name='compose' options={{presentation:'modal'}}/></Stack>;}",
    "src/app/(classic)/_layout.tsx":"import {Tabs} from 'expo-router';export default function Layout(){return <Tabs><Tabs.Screen name='feed'/><Tabs.Screen name='inbox'/></Tabs>;}",
    "src/app/(native)/_layout.tsx":"import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Layout(){return <NativeTabs><NativeTabs.Trigger name='home'/><NativeTabs.Trigger name='profile'/></NativeTabs>;}",
    "src/app/(native)/home.tsx":"import {Link} from 'expo-router';import {NativeTabs} from 'expo-router/unstable-native-tabs';export default function Home(){return <><NativeTabs.Trigger><NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label></NativeTabs.Trigger><Link href='/compose'/></>;}",
  });
  assert.deepEqual(edges(result,"feed"),[["inbox","tab"]]);
  assert.deepEqual(edges(result,"inbox"),[["feed","tab"]]);
  assert.deepEqual(edges(result,"home"),[["compose","push"],["profile","tab"]]);
  assert.deepEqual(edges(result,"profile"),[["home","tab"]]);
  assert.deepEqual(edges(result,"compose"),[]);
  assert.deepEqual(result.modalSurfaceIds,["compose"]);
  assert.deepEqual(result.unresolved,[]);
});

test("bounded source and finite template expansion failures remain explicit coverage diagnostics",()=>{
  const large=graph([surface("one")],{"src/app/one.tsx":"/*"+"x".repeat(2*1024*1024)+"*/export default function One(){return null;}"});
  assert.equal(large.unresolved.some(message=>message.includes("analysis source byte budget exceeded")),true);
  const alternatives=Array.from({length:9},(_,i)=>`c${i}?'/item/${i}':`).join('')+"'/item/9'";
  const suffixes=Array.from({length:9},(_,i)=>`d${i}?'${i}':`).join('')+"'9'";
  const expanded=graph([surface("one"),surface("item","/item/00","src/app/item/[id].tsx")],{
    "src/app/one.tsx":`import {router} from 'expo-router';const a=${alternatives};const b=${suffixes};export default function One(){router.push(\`\${a}\${b}\`);return null;}`,
  });
  assert.equal(expanded.unresolved.some(message=>message.startsWith("Unresolved navigation:")),true);
});

test("tracked CSS and assets never enter the TypeScript module graph while missing code remains diagnosed",()=>{
  const result=graph([surface("one"),surface("two")],{
    "src/app/one.tsx":"import '../../global.css';import image from '../cat.png';import data from '../data.json';import {router} from 'expo-router';import {Missing} from '../missing';export default function One(){router.push('/two');return <><Image source={image}/><Text>{data.title}</Text><Missing/></>;}",
    "global.css":"@tailwind base;",
    "src/cat.png":"",
    "src/data.json":"",
  });
  assert.deepEqual(edges(result,"one"),[["two","push"]]);
  assert.equal(result.unresolved.length,1);
  assert.equal(result.unresolved[0].includes("local imported code could not be resolved"),true);
});
