import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { discoverReactNavigation } = await tsImport("../../src/source/route-providers/react-navigation.ts", import.meta.url);
const { validateSourceRoute } = await tsImport("../../src/contracts/source-route.ts", import.meta.url);
const { createSourceCapturePlan, canonicalPlan } = await tsImport("../../src/source/capture-plan.ts", import.meta.url);
const named = (result, name) => result.routes.filter(route => route.route === name);
const edgeNames = result => result.edges.map(edge => [
  result.routes.find(route => route.id === edge.from).route,
  result.routes.find(route => route.id === edge.to).route,
  edge.kind,
]);

test("JSX registration is the inventory, including screens absent from linking", () => {
  const result = discoverReactNavigation({
    "src/App.tsx": `import { NavigationContainer } from '@react-navigation/native';
      import { createNativeStackNavigator as createStack } from '@react-navigation/native-stack';
      import { NAMES } from './names'; import { Home, Detail } from './screens'; import linking from './linking';
      const Stack = createStack();
      export default function App() { return <NavigationContainer linking={linking}><Stack.Navigator>
        <Stack.Screen name={NAMES.home} component={Home}/>
        <Stack.Screen name={NAMES.detail} component={Detail}/>
        <Stack.Screen name="Private" component={Detail}/>
      </Stack.Navigator></NavigationContainer>; }`,
    "src/names.ts": `export const NAMES = { home: 'Home', detail: 'Detail' } as const;`,
    "src/screens.ts": `export { Home } from './Home'; export { default as Detail } from './Detail';`,
    "src/Home.tsx": `import {NAMES} from './names'; export function Home({navigation}) { return <Button onPress={() => navigation.push(NAMES.detail)}/>; }`,
    "src/Detail.tsx": `export default function Detail() { return null; }`,
    "src/linking.ts": `const linking = { prefixes: ['demo://'], config: { screens: { Home: '', Detail: 'details/:id' } } }; export default linking;`,
    ".expo-explore/surfaces.json": `{"surfaces":[{"id":"fabricated","route":"NotReal"}]}`,
  }, { entry: "src/App.tsx", parameters: { Detail: { id: "example item" } } });
  assert.deepEqual(result.routes.map(route => route.route).sort(), ["Detail", "Home", "Private"]);
  assert.equal(named(result, "Home")[0].path, "/");
  assert.equal(named(result, "Detail")[0].path, "/details/example%20item");
  assert.equal(named(result, "Detail")[0].routeFile, "src/Detail.tsx");
  assert.deepEqual(named(result, "Detail")[0].parameters, { id: "example item" });
  assert.equal(named(result, "Private")[0].path, null);
  assert.deepEqual(edgeNames(result), [["Home", "Detail", "push"]]);
  assert.deepEqual(result.diagnostics, []);
  for (const route of result.routes) assert.match(route.id, /^[a-z0-9][a-z0-9._-]*$/);
});

test("static object API resolves imported screens, groups and nested navigator objects", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import { createNativeStackNavigator } from '@react-navigation/native-stack';
      import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
      import { createStaticNavigation } from '@react-navigation/native';
      import Home from './Home'; import Details from './Details';
      const Tabs = createBottomTabNavigator({ screens: {
        Home: { screen: Home, linking: '' }, Account: { screen: Details, linking: 'account' }
      }});
      const Root = createNativeStackNavigator({ screens: { Main: { screen: Tabs, linking: 'app' } },
        groups: { SignedIn: { if: useIsSignedIn, screens: { Details: { screen: Details, linking: 'details/:id?' } } } }
      });
      const Navigation = createStaticNavigation(Root);
      export default function App(){ return <Navigation/>; }`,
    "Home.tsx": `import {useNavigation} from '@react-navigation/native'; export default function Home(){ const nav = useNavigation(); return <Button onPress={()=>nav.navigate('Details')}/>; }`,
    "Details.tsx": `export default function Details(){return null;}`,
  });
  assert.deepEqual(result.routes.map(route => route.route).sort(), ["Account", "Details", "Home"]);
  assert.equal(named(result, "Home")[0].logicalPath, "App.tsx#Root/Main/Home");
  assert.equal(named(result, "Home")[0].path, "/app");
  assert.equal(named(result, "Account")[0].path, "/app/account");
  assert.equal(named(result, "Details")[0].path, "/details");
  assert.ok(edgeNames(result).some(edge => edge.join("/") === "Home/Details/navigate"));
  assert.ok(edgeNames(result).some(edge => edge.join("/") === "Home/Account/tab"));
  assert.deepEqual(result.diagnostics, []);
});

test("nested JSX navigators retain scoped identity for duplicate screen names", () => {
  const files = {
    "App.tsx": `import {NavigationContainer} from '@react-navigation/native';
      import {createNativeStackNavigator} from '@react-navigation/native-stack';
      import {A} from './a'; import B from './b';
      const Root = createNativeStackNavigator();
      export default function App(){return <NavigationContainer linking={{config:{screens:{
        First:{path:'first',screens:{Home:'',Detail:'detail'}},Second:{path:'second',screens:{Home:'',Detail:'detail'}}
      }}}}><Root.Navigator><Root.Screen name="First" component={A}/><Root.Screen name="Second" component={B}/></Root.Navigator></NavigationContainer>;}`,
    "a.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; const Stack=createNativeStackNavigator();
      function Home({navigation}){navigation.navigate('Detail');return null;} function Detail(){return null;}
      export function A(){return <Stack.Navigator><Stack.Screen name="Home" component={Home}/><Stack.Screen name="Detail" component={Detail}/></Stack.Navigator>;}`,
    "b.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; const Stack=createNativeStackNavigator();
      function Home({navigation}){navigation.navigate('Detail');return null;} function Detail(){return null;}
      export default function B(){return <Stack.Navigator><Stack.Screen name="Home" component={Home}/><Stack.Screen name="Detail" component={Detail}/></Stack.Navigator>;}`,
  };
  const result = discoverReactNavigation(files);
  assert.equal(result.routes.length, 4);
  assert.equal(new Set(result.routes.map(route => route.id)).size, 4);
  assert.deepEqual(named(result, "Home").map(route => route.path).sort(), ["/first", "/second"]);
  for (const edge of result.edges) {
    const from = result.routes.find(route => route.id === edge.from);
    const to = result.routes.find(route => route.id === edge.to);
    assert.equal(from.logicalPath.split("/").slice(0, -1).join("/"), to.logicalPath.split("/").slice(0, -1).join("/"));
  }
  assert.deepEqual(result.diagnostics, []);
});

test("nested navigation respects explicit child and initialRouteName, not declaration order", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
      function Start({navigation}){ navigation.navigate('Main', {screen:'Second'}); navigation.push('Main'); return null; }
      function First(){return null;} function Second(){return null;}
      const Child=createNativeStackNavigator({initialRouteName:'Second',screens:{First,Second}});
      const Root=createNativeStackNavigator({screens:{Start,Main:Child}});`,
  });
  assert.deepEqual(edgeNames(result).sort(), [["Start", "Second", "navigate"], ["Start", "Second", "push"]]);
  assert.deepEqual(result.diagnostics, []);
});

test("does not guess unknown dynamic parameters, names or destination containers", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; import {NavigationContainer} from '@react-navigation/native';
      const Stack=createNativeStackNavigator();
      function Home({navigation}){navigation.navigate(server.destination);return null;} function Detail(){return null;}
      export default function App(){return <NavigationContainer linking={{config:{screens:{Home:'',Detail:'detail/:id'}}}}><Stack.Navigator>
        <Stack.Screen name="Home" component={Home}/><Stack.Screen name="Detail" component={Detail}/><Stack.Screen name={server.name} component={Detail}/>
      </Stack.Navigator></NavigationContainer>;}`,
  });
  assert.equal(named(result, "Detail")[0].path, null);
  assert.deepEqual(named(result, "Detail")[0].pathParameters, { id: "required" });
  assert.deepEqual(result.edges, []);
  assert.ok(result.diagnostics.some(message => message.startsWith("Unresolved React Navigation linking parameters:")));
  assert.ok(result.diagnostics.some(message => message.startsWith("Unresolved React Navigation screen name:")));
  assert.ok(result.diagnostics.some(message => message.startsWith("Unresolved React Navigation destination:")));
});

test("linking parameter metadata preserves parent and optional names through source plans", () => {
  const files = { "App.tsx": `import { createNativeStackNavigator } from '@react-navigation/native-stack';
    import { createStaticNavigation } from '@react-navigation/native';
    function Product() { return null; }
    const Shop = createNativeStackNavigator({ screens: { Product } });
    const Root = createNativeStackNavigator({ screens: { Shop } });
    const Navigation = createStaticNavigation(Root);
    export default function App() { return <Navigation linking={{ config: { screens: {
      Shop: { path: 'shops/:tenant', screens: { Product: 'products/:id/:sort?' } }
    } } }}/>; }` };
  const [unresolved] = discoverReactNavigation(files).routes;
  assert.equal(unresolved.path, null);
  assert.deepEqual(unresolved.pathParameters, { id: "required", sort: "optional", tenant: "required" });
  assert.deepEqual(validateSourceRoute(JSON.parse(JSON.stringify(unresolved))), unresolved);
  const [configured] = discoverReactNavigation(files, { parameters: { Product: { tenant: "acme", id: "42" } } }).routes;
  assert.equal(configured.path, "/shops/acme/products/42");
  assert.deepEqual(configured.pathParameters, unresolved.pathParameters);
  assert.equal(configured.id, unresolved.id);
  const options = { baseSha: "a".repeat(40), headSha: "b".repeat(40), baseFiles: new Map(Object.entries(files)),
    headFiles: new Map(Object.entries(files)), changedFiles: [], mode: "all" };
  const plan = createSourceCapturePlan(options);
  assert.deepEqual(plan.surfaces[0].headSurface.pathParameters, unresolved.pathParameters);
  assert.equal(canonicalPlan(plan), canonicalPlan(createSourceCapturePlan({ ...options, baseFiles: new Map([...options.baseFiles].reverse()), headFiles: new Map([...options.headFiles].reverse()) })));
  const exact = files["App.tsx"].replace("Product: 'products/:id/:sort?'", "Product: { path: 'products/:id/:sort?', exact: true }");
  assert.deepEqual(discoverReactNavigation({ "App.tsx": exact }).routes[0].pathParameters, { id: "required", sort: "optional" });
  for (const pathParameters of [[], { id: "unknown" }, { "bad-name": "required" }]) {
    assert.throws(() => validateSourceRoute({ ...unresolved, pathParameters }), /pathParameters/);
  }
  const { pathParameters: _pathParameters, ...legacy } = unresolved;
  assert.deepEqual(validateSourceRoute(legacy), legacy);
});

test("unresolved nested destinations never fall back to a navigator's initial screen", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
      function Start({navigation}) {
        navigation.navigate('Main', {screen: server.target});
        navigation.navigate('Main', server.params);
        navigation.navigate('Main', {screen: 'Nested', params: {screen: server.child}});
        navigation.navigate('Main', {screen: 'Nested', params: server.params});
        navigation.navigate('Main', {...server.params});
        navigation.navigate('Main', {screen: 'Home', ...server.params});
        navigation.navigate('Main', {[server.key]: 'Nested'});
        navigation.navigate('Detail', server.params);
        return null;
      }
      function Home(){return null;} function Detail(){return null;}
      const Inner=createNativeStackNavigator({initialRouteName:'Home',screens:{Home,Detail}});
      const Child=createNativeStackNavigator({initialRouteName:'Home',screens:{Home,Nested:Inner}});
      const Root=createNativeStackNavigator({screens:{Start,Detail,Main:Child}});`,
  });
  assert.deepEqual(edgeNames(result), [["Start", "Detail", "navigate"]]);
  assert.equal(result.diagnostics.filter(message => message.startsWith("Unresolved React Navigation destination:")).length, 7);
});

test("module aliases, namespaces and platform implementations resolve from source", () => {
  const files = {
    "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}`,
    "App.tsx": `import * as RN from '@react-navigation/native-stack'; import * as Names from '@/names'; import Home from '@/Home';
      const Root = RN.createNativeStackNavigator({ screens: { [Names.HOME]: Home }});`,
    "src/names.ts": `export const HOME = 'Home';`,
    "src/Home.tsx": `export default function Home(){ return null; }`,
    "src/Home.android.tsx": `export default function Home(){ return null; }`,
    "src/Home.ios.tsx": `export default function Home(){ return null; }`,
  };
  assert.equal(discoverReactNavigation(files, { platform: "android" }).routes[0].routeFile, "src/Home.android.tsx");
  assert.equal(discoverReactNavigation(files, { platform: "ios" }).routes[0].routeFile, "src/Home.ios.tsx");
  assert.equal(discoverReactNavigation(files, { platform: "web" }).routes[0].routeFile, "src/Home.tsx");
});

test("same source produces byte-identical inventory regardless of input enumeration", () => {
  const files = {
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; import {Screens} from './screens'; const Root=createNativeStackNavigator({screens:Screens});`,
    "screens.ts": `import Home from './Home'; import Settings from './Settings'; export const Screens={Home,Settings};`,
    "Home.tsx": `export default function Home({navigation}){ navigation.navigate('Settings'); return null; }`,
    "Settings.tsx": `export default function Settings(){return null;}`,
  };
  const expected = JSON.stringify(discoverReactNavigation(files));
  for (let offset = 0; offset < Object.keys(files).length; offset++) {
    const entries = Object.entries(files);
    assert.equal(JSON.stringify(discoverReactNavigation(Object.fromEntries([...entries.slice(offset), ...entries.slice(0, offset)].reverse()))), expected);
  }
  const withManifest = { ...files, ".expo-explore/surfaces.json": '{"surfaces": ["invented"]}' };
  assert.equal(JSON.stringify(discoverReactNavigation(withManifest)), expected);
});

test("unrelated shadowed objects do not produce navigation edges", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
      function Home(){ const navigation={navigate(){}}; navigation.navigate('Settings'); return null; }
      function Settings(){return null;} const Root=createNativeStackNavigator({screens:{Home,Settings}});`,
  });
  assert.deepEqual(result.edges, []);
});

test("static wrapper linking resolves imported aliases and nested string constants", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
      import {createStaticNavigation} from '@react-navigation/native'; import {paths} from './paths';
      const HOME='Home'; const names={home:HOME}; function Home(){return null;}
      const Root=createNativeStackNavigator({screens:{[names.home]:Home}});
      const Navigation=createStaticNavigation(Root);
      export default function App(){return <Navigation linking={{prefixes:['example://'],config:{screens:paths}}}/>;}`,
    "paths.ts": `const HOME_PATH='home'; export const paths={Home:HOME_PATH};`,
  });
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].path, "/home");
  assert.deepEqual(result.diagnostics, []);
});

test("partly dynamic static screen maps retain known screens and report missing evidence", () => {
  const result = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
      function Home(){return null;}
      const Root=createNativeStackNavigator({screens:{Home,...server.screens,[server.name]:Home}});`,
  });
  assert.deepEqual(result.routes.map(route => route.route), ["Home"]);
  assert.ok(result.diagnostics.some(message => message.startsWith("Unresolved React Navigation screens:")));
  assert.ok(result.diagnostics.some(message => message.startsWith("Unresolved React Navigation screen name:")));
});

test("opaque navigator configurations and groups report incomplete discovery", () => {
  for (const [configuration, diagnostic] of [
    ["server.config", "navigator configuration"],
    ["{groups:server.groups}", "groups"],
    ["{groups:{Dynamic:server.group}}", "group configuration"],
  ]) {
    const result = discoverReactNavigation({
      "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
        const Root=createNativeStackNavigator(${configuration});`,
    });
    assert.deepEqual(result.routes, []);
    assert.ok(result.diagnostics.some(message => message.startsWith(`Unresolved React Navigation ${diagnostic}:`)));
  }
  const partial = discoverReactNavigation({
    "App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack';
      function Home(){return null;}
      const Root=createNativeStackNavigator({...server.config, groups:{Known:{screens:{Home}},...server.groups}});`,
  });
  assert.deepEqual(partial.routes.map(route => route.route), ["Home"]);
  assert.ok(partial.diagnostics.some(message => message.startsWith("Unresolved React Navigation navigator configuration:")));
  assert.ok(partial.diagnostics.some(message => message.startsWith("Unresolved React Navigation groups:")));
});

test("entry restricts discovery to the selected application's import graph", () => {
  const result = discoverReactNavigation({
    "App.tsx": `export {default} from './navigation';`,
    "navigation.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; function Home(){return null;}
      const Root=createNativeStackNavigator({screens:{Home}}); export default Root;`,
    "other/App.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; function Other(){return null;}
      const Root=createNativeStackNavigator({screens:{Other}});`,
  }, { entry: "App.tsx" });
  assert.deepEqual(result.routes.map(route => route.route), ["Home"]);
  assert.deepEqual(result.diagnostics, []);
});

test("platform navigator files replace the generic navigator inventory", () => {
  const files = {
    "navigation.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; function Generic(){return null;}
      const Root=createNativeStackNavigator({screens:{Generic}});`,
    "navigation.android.tsx": `import {createNativeStackNavigator} from '@react-navigation/native-stack'; function Android(){return null;}
      const Root=createNativeStackNavigator({screens:{Android}});`,
  };
  assert.deepEqual(discoverReactNavigation(files, { platform: "android" }).routes.map(route => route.route), ["Android"]);
  assert.deepEqual(discoverReactNavigation(files, { platform: "ios" }).routes.map(route => route.route), ["Generic"]);
});
