import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { CAPTURE_OBSERVER_HASH, CAPTURE_OBSERVER_IDENTIFIER, captureCompatibility, captureDestinationMatches, captureDestinationPath, captureObserverMarkers, captureObserverParameterKeys,
  observedNavigationState, observedParameters, observedParametersComplete, parseCaptureDestination, prepareCaptureObserver } from '../../dist/capture/observer.js';
import { discoverRoutes } from '../../dist/source/route-inventory.js';
import { writeCaptureObserverPackages } from '../helpers/capture-observer-fixture.mjs';

const route = (changes = {}) => ({ id: 'screen', provider: 'expo-router', kind: 'screen', logicalPath: '/(tabs)/cats/[id]',
  route: '/cats/42', path: '/cats/42', routeFile: 'app/(tabs)/cats/[id].tsx', sourceFiles: [], variant: 'default', parameters: { id: '42' }, ...changes });
const destination = (changes = {}) => ({ provider: 'expo-router', pathname: '/cats/42', segments: ['(tabs)', 'cats', '[id]'], parameters: { id: '42' }, ...changes });
const productSource = { 'App.tsx': `import { NavigationContainer } from '@react-navigation/native';
  import { createNativeStackNavigator } from '@react-navigation/native-stack';
  const Stack = createNativeStackNavigator(); function Details() { return null; }
  export default function App() { return <NavigationContainer linking={{ config: { screens: { Details: 'products/:id/:sort?' } } }}>
    <Stack.Navigator><Stack.Screen name="Details" component={Details}/></Stack.Navigator></NavigationContainer>; }` };

async function fixture(t, provider = 'expo-router') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'explore-observer-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'app'); await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"main":"original-entry.js"}');
  await writeFile(join(project, 'original-entry.js'), '// Original application entry remains unchanged.');
  await writeCaptureObserverPackages(project, { provider });
  return { root, project, outputDirectory: join(root, 'generated'), provider };
}

test('active navigation reads only the selected nested chain and keeps the input untouched', () => {
  const state = { index: 1, routes: [{ name: 'Wrong' }, { name: 'Account', params: { tenant: 'acme' }, state: {
    index: 0, routes: [{ name: 'Details', params: { id: 42 } }, { name: 'Inactive' }],
  } }] };
  const before = JSON.stringify(state);
  const actual = observedNavigationState(state);
  assert.deepEqual(actual.segments, ['Account', 'Details']);
  assert.deepEqual({ ...actual.parameters }, { tenant: 'acme', id: 42 });
  assert.equal(JSON.stringify(state), before);
});

test('incomplete, cyclic and invalid navigation state cannot assert a destination', () => {
  const cycle = { routes: [{ name: 'Cycle' }] }; cycle.routes[0].state = cycle;
  for (const value of [undefined, {}, { routes: [] }, { routes: [{ name: 'A' }, { name: 'B' }] },
    { index: 3, routes: [{ name: 'A' }] }, { index: -1, routes: [{ name: 'A' }] }, cycle]) {
    assert.equal(observedNavigationState(value), null);
  }
  assert.deepEqual(observedNavigationState({ routes: [{ name: 'Parent', params: { screen: 'Unrendered' } }] }).segments, ['Parent']);
});

test('only requested simple parameters are published in deterministic order', () => {
  const values = { token: 'private-value', id: 7, page: true, tags: ['b', 'a'], complex: { private: true }, huge: 'x'.repeat(2049) };
  assert.equal(JSON.stringify(observedParameters(values, ['page', 'id', 'id', 'tags', 'complex', 'huge'])), '{"id":"7","page":"true","tags":["b","a"]}');
  assert.deepEqual(captureObserverParameterKeys([route({ path: '/cats/42?sort=new&sort=old' }), route({ logicalPath: '/docs/[...parts]' })]), ['id', 'parts', 'sort']);
});

test('unsupported requested values and conflicting ancestor parameters cannot assert a destination', () => {
  assert.equal(observedParametersComplete({ token: { private: true } }, ['id']), true);
  for (const id of [{ value: 42 }, undefined, null, Infinity, 'x'.repeat(2049), Array(65).fill('a')]) {
    assert.equal(observedParametersComplete({ id }, ['id']), false);
    assert.equal(observedNavigationState({ routes: [{ name: 'Product', params: { id } }] }, ['id']), null);
  }
  const nested = (parent, child) => ({ routes: [{ name: 'Tenant', params: parent, state: { routes: [{ name: 'Product', params: child }] } }] });
  assert.equal(observedNavigationState(nested({ id: 'tenant-A' }, { id: '42' }), ['id']), null);
  assert.deepEqual({ ...observedNavigationState(nested({ id: '42', token: 'a' }, { id: '42', token: 'b' }), ['id']).parameters }, { id: '42', token: 'b' });
});

test('observer parser rejects malformed, excessive or undocumented payload fields', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseCaptureDestination(JSON.stringify(destination())))), destination());
  for (const value of [null, '{}', '{', 'x'.repeat(32769), JSON.stringify({ ...destination(), expected: '/cats/42' }),
    JSON.stringify(destination({ provider: 'unknown' })), JSON.stringify(destination({ parameters: { id: {} } })),
    JSON.stringify(destination({ segments: [''] })), JSON.stringify({ provider: 'react-navigation', segments: [], parameters: {} })]) {
    assert.equal(parseCaptureDestination(value), null);
  }
});

test('Expo destinations require exact group, pathname and relevant parameters', () => {
  const target = route();
  assert.equal(captureDestinationMatches(destination(), target, [target]), true);
  for (const observed of [destination({ pathname: '/cats/43' }), destination({ segments: ['(other)', 'cats', '[id]'] }),
    destination({ parameters: { id: '43' } }), destination({ parameters: {} })]) {
    assert.equal(captureDestinationMatches(observed, target, [target]), false);
  }
  const query = route({ path: '/cats/42?sort=new' });
  assert.equal(captureDestinationMatches(destination({ parameters: { id: '42', sort: 'new', irrelevant: 'value' } }), query, [query]), true);
  assert.equal(captureDestinationMatches(destination(), query, [query]), false);
});

test('Expo index and encoded catch-all semantics match SDK57 route information', () => {
  const index = route({ path: '/cats', logicalPath: '/(tabs)/cats/index', parameters: {} });
  assert.equal(captureDestinationMatches(destination({ pathname: '/cats', segments: ['(tabs)', 'cats'], parameters: {} }), index, [index]), true);
  const catchAll = route({ path: '/docs/a%20b/c', logicalPath: '/docs/[...parts]', parameters: { parts: 'a b/c' } });
  assert.equal(captureDestinationMatches(destination({ pathname: '/docs/a b/c', segments: ['docs', '[...parts]'], parameters: { parts: ['a b', 'c'] } }), catchAll, [catchAll]), true);
});

test('React Navigation compares full active route names and rejects ambiguous root identities', () => {
  const target = route({ provider: 'react-navigation', logicalPath: 'src/nav.tsx#Root/Account/Details', path: '/account/42' });
  const observed = { provider: 'react-navigation', segments: ['Account', 'Details'], parameters: { id: '42' } };
  assert.equal(captureDestinationMatches(observed, target, [target]), true);
  assert.equal(captureDestinationMatches({ ...observed, segments: ['Details'] }, target, [target]), false);
  assert.equal(captureDestinationMatches(observed, target, [target, { ...target, id: 'second', logicalPath: 'src/other.tsx#Root/Account/Details' }]), false);
  assert.equal(captureDestinationMatches({ ...observed, segments: ['Wrong', 'Details'] }, target, [target]), false);
});

test('agent navigation verifies unresolved source identities without inventing a deep link', () => {
  const target = route({ path: null, route: '/cats/[id]', parameters: {} });
  assert.equal(captureDestinationMatches(destination(), target, [target]), false);
  assert.equal(captureDestinationMatches(destination(), target, [target], { allowNavigationOnly: true }), true);
  assert.equal(captureDestinationMatches(destination({ segments: ['(other)', 'cats', '[id]'] }), target, [target], { allowNavigationOnly: true }), false);
  assert.equal(captureDestinationMatches(destination(), target, [target, { ...target, id: 'ambiguous' }], { allowNavigationOnly: true }), false);
  const configured = route({ path: null });
  assert.equal(captureDestinationMatches(destination({ parameters: { id: 'wrong' } }), configured, [configured], { allowNavigationOnly: true }), false);
  const navigation = route({ provider: 'react-navigation', logicalPath: 'src/nav.tsx#Root/Account', path: null, parameters: {} });
  assert.equal(captureDestinationMatches({ provider: 'react-navigation', segments: ['Account'], parameters: {} }, navigation, [navigation], { allowNavigationOnly: true }), true);
});

test('source-discovered Expo patterns bind observed values while preserving configured queries', () => {
  const [target] = discoverRoutes({ 'app/(tabs)/cats/[id].tsx': 'export default function Cat() { return null; }' },
    { parameters: { '/cats/[id]': { sort: '[new]' } } }).routes;
  const observed = destination({ pathname: '/cats/a b', parameters: { id: 'a b', sort: '[new]' } });
  assert.equal(target.path, '/cats/[id]?sort=%5Bnew%5D');
  assert.equal(captureDestinationMatches(observed, target, [target]), false);
  assert.equal(captureDestinationMatches(observed, target, [target], { allowNavigationOnly: true }), true);
  assert.equal(captureDestinationPath(observed, target), '/cats/a%20b?sort=%5Bnew%5D');
  for (const invalid of [
    { pathname: '/cats/other' }, { segments: ['(other)', 'cats', '[id]'] },
    { parameters: { sort: '[new]' } }, { parameters: { id: ['a b'], sort: '[new]' } },
    { parameters: { id: '', sort: '[new]' } }, { parameters: { id: 'a b', sort: 'old' } },
  ]) assert.equal(captureDestinationMatches({ ...observed, ...invalid }, target, [target], { allowNavigationOnly: true }), false);
  assert.equal(captureDestinationMatches(observed, target, [target, { ...target, id: 'duplicate' }], { allowNavigationOnly: true }), false);
  const [configured] = discoverRoutes({ 'app/(tabs)/cats/[id].tsx': 'export default function Cat() { return null; }' },
    { parameters: { '/cats/[id]': { id: 'different', sort: '[new]' } } }).routes;
  assert.equal(captureDestinationMatches(observed, configured, [configured], { allowNavigationOnly: true }), false);
});

test('source-discovered Expo catch-all values resolve as encoded path segments', () => {
  const [target] = discoverRoutes({ 'app/docs/[...parts].tsx': 'export default function Docs() { return null; }' }).routes;
  for (const parts of [['a b', 'c'], 'a b/c']) {
    const observed = destination({ pathname: '/docs/a b/c', segments: ['docs', '[...parts]'], parameters: { parts } });
    assert.equal(captureDestinationMatches(observed, target, [target], { allowNavigationOnly: true }), true);
    assert.equal(captureDestinationPath(observed, target), '/docs/a%20b/c');
  }
  for (const parts of [[], '', ['a', ''], ['..'], ['\ud800']]) {
    assert.equal(captureDestinationPath(destination({ pathname: '/docs/a', parameters: { parts } }), target), null);
  }
});

test('source-discovered React Navigation linking names survive unresolved and optional values', () => {
  const [target] = discoverRoutes(productSource).routes;
  assert.equal(target.path, null);
  assert.deepEqual(target.pathParameters, { id: 'required', sort: 'optional' });
  const keys = captureObserverParameterKeys([target]);
  assert.deepEqual(keys, ['id', 'sort']);
  const observed = { provider: 'react-navigation', segments: ['Details'], parameters: observedParameters({ id: 42, token: 'private' }, keys) };
  assert.deepEqual({ ...observed.parameters }, { id: '42' });
  assert.equal(captureDestinationMatches(observed, target, [target], { allowNavigationOnly: true }), true);
  assert.equal(captureDestinationMatches(observed, target, [target]), false);
  for (const id of [undefined, '', {}, ['42']]) {
    assert.equal(captureDestinationMatches({ ...observed, parameters: observedParameters({ id }, keys) }, target, [target], { allowNavigationOnly: true }), false);
  }
});

test('temporary observer generation preserves source and has path-independent recipe identity', async t => {
  const options = await fixture(t);
  const first = await prepareCaptureObserver({ ...options, parameterKeys: ['sort', 'id'] });
  const second = await prepareCaptureObserver({ ...options, outputDirectory: join(options.root, 'elsewhere'), parameterKeys: ['id', 'sort', 'id'] });
  assert.match(CAPTURE_OBSERVER_HASH, /^[a-f0-9]{64}$/);
  assert.equal(first.recipeHash, second.recipeHash);
  assert.equal(first.files.length, 2);
  assert.equal(await readFile(join(options.project, 'original-entry.js'), 'utf8'), '// Original application entry remains unchanged.');
  assert.equal(await readFile(join(options.project, 'package.json'), 'utf8'), '{"main":"original-entry.js"}');
  assert.equal(first.environment.EXPO_OVERRIDE_METRO_CONFIG, join(options.outputDirectory, 'metro.config.cjs'));
  assert.notEqual((await prepareCaptureObserver({ ...options, outputDirectory: join(options.root, 'other-params'), parameterKeys: ['id'] })).recipeHash, first.recipeHash);
  await assert.rejects(prepareCaptureObserver({ ...options, outputDirectory: join(options.project, '.observer') }), /outside the application checkout/);
});

test('unsupported SDKs and missing actual override hooks fail before generation', async t => {
  const options = await fixture(t);
  await writeCaptureObserverPackages(options.project, { expoVersion: '56.0.0' });
  await assert.rejects(prepareCaptureObserver(options), /requires Expo SDK 57 or newer/);
  await writeCaptureObserverPackages(options.project, { expoVersion: '58.0.0' });
  assert.equal((await captureCompatibility(options.project, 'expo-router')).expoVersion, '58.0.0', 'newer SDKs are accepted');
  await writeCaptureObserverPackages(options.project);
  await writeFile(join(options.project, 'node_modules/@expo/cli/build/src/start/server/metro/instantiateMetro.js'), '// unrelated');
  await assert.rejects(prepareCaptureObserver(options), /does not support/);
});

test('a temporary output symlink cannot cause a write inside the application checkout', async t => {
  const options = await fixture(t);
  const alias = join(options.root, 'alias');
  await symlink(options.project, alias, 'dir');
  await assert.rejects(prepareCaptureObserver({ ...options, outputDirectory: join(alias, 'generated') }), /outside the application checkout/);
  await assert.rejects(lstat(join(options.project, 'generated')), { code: 'ENOENT' });
  const leaf = join(options.root, 'leaf'); await symlink(options.project, leaf, 'dir');
  await assert.rejects(prepareCaptureObserver({ ...options, outputDirectory: leaf }), /regular temporary directory/);
});

test('generated scene proxy marks only the focused leaf scene, preserves props, and disposes listeners', async t => {
  for (const provider of ['expo-router', 'react-navigation']) {
    const options = await fixture(t, provider);
    const inventory = discoverRoutes(provider === 'react-navigation' ? productSource
      : { 'app/cats/[id].tsx': 'export default function Cat() { return null; }' }).routes;
    const generated = await prepareCaptureObserver({ ...options, parameterKeys: captureObserverParameterKeys(inventory) });
    const source = await readFile(generated.files[0], 'utf8');
    const Scene = function Original() {};
    const context = {};
    const events = [], disposed = [], unsubscribes = [];
    let activeState = { routes: [{ name: 'Details', params: { id: '42', token: 'private' } }] };
    let routerParameters = { id: '42', token: 'private' };
    const container = { isReady: () => true, getRootState: () => activeState,
      addListener: (event) => { events.push(event); return () => disposed.push(event); } };
    const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props, children }),
      useContext: value => { assert.equal(value, context); return container; }, useCallback: fn => fn,
      useSyncExternalStore: (subscribe, snapshot) => { unsubscribes.push(subscribe(() => {})); return snapshot(); } };
    const exports = {};
    vm.runInNewContext(source, { exports, require: name => {
      if (name === 'react') return React;
      if (name === 'react-native') return { View: 'NativeView' };
      if (name === 'expo-router') return { usePathname: () => '/cats/42', useSegments: () => ['cats', '[id]'], useGlobalSearchParams: () => routerParameters };
      if (name.endsWith('/SceneView.js')) return { SceneView: Scene, otherExport: 'preserved' };
      if (name.endsWith('/NavigationContainerRefContext.js')) return { NavigationContainerRefContext: context };
      throw new Error(name);
    } });
    assert.equal(exports.otherExport, 'preserved');
    const sceneNavigation = focused => ({ isFocused: () => focused, addListener: (event) => { events.push(event); return () => disposed.push(event); } });
    const props = (focused, routeState) => ({ screen: { name: 'Details' }, route: { key: 'Details-1', name: 'Details' }, navigation: sceneNavigation(focused),
      routeState, getState: () => ({ routes: [] }), setState: () => {}, options: { title: 'Details' }, clearOptions: () => {} });
    // The focused leaf renders the original scene untouched, followed by exactly one marker.
    const leaf = props(true, undefined);
    const tree = exports.SceneView(leaf);
    assert.equal(tree.type, 'Fragment');
    assert.equal(tree.children[0].type, Scene); assert.equal(tree.children[0].props, leaf);
    const marker = tree.children[1].type();
    assert.equal(marker.props.testID, CAPTURE_OBSERVER_IDENTIFIER);
    assert.equal(marker.props.pointerEvents, 'none');
    assert.equal(marker.props.style.width, 1); assert.equal(marker.props.style.height, 1);
    assert.equal(marker.props.style.backgroundColor, undefined); assert.equal(marker.children.length, 0);
    const label = JSON.parse(marker.props.accessibilityLabel);
    assert.equal(label.provider, provider); assert.deepEqual(label.parameters, { id: '42' });
    // A blurred scene and a scene hosting a nested navigator never carry the marker.
    assert.equal(exports.SceneView(props(false, undefined)).children[1], null);
    assert.equal(exports.SceneView(props(true, { routes: [{ name: 'Nested' }] })).children[1], null);
    assert.deepEqual(events.slice(0, 4), ['focus', 'blur', 'ready', 'state']);
    unsubscribes.forEach(unsubscribe => unsubscribe());
    assert.deepEqual(disposed.slice(0, 4), ['focus', 'blur', 'ready', 'state']);
    // Optional linked values are never silently dropped before a context comparison.
    if (provider === 'react-navigation') {
      activeState = { routes: [{ name: 'Details', params: { id: '42', sort: { private: true } } }] };
    } else routerParameters = { id: { private: true } };
    assert.equal(tree.children[1].type(), null);
    if (provider === 'react-navigation') {
      activeState = { routes: [{ name: 'Tenant', params: { id: 'tenant-A' }, state: { routes: [{ name: 'Details', params: { id: '42' } }] } }] };
      assert.equal(tree.children[1].type(), null);
    }
  }
});

test('the scene marker renders inside the focused leaf scene under real React', async t => {
  const generated = await prepareCaptureObserver(await fixture(t));
  const source = await readFile(generated.files[0], 'utf8');
  const hostRequire = createRequire(import.meta.url);
  const React = hostRequire('react');
  const { renderToStaticMarkup } = hostRequire('react-dom/server');
  const NavigationContainerRefContext = React.createContext(undefined);
  const container = { isReady: () => true, addListener: () => () => {},
    getRootState: () => ({ index: 1, routes: [{ name: '(tabs)', state: { index: 0, routes: [{ name: 'cats' }] } }, { name: 'settings/index' }] }) };
  const View = props => React.createElement('i', { id: props.testID, title: props.accessibilityLabel });
  const Scene = props => React.createElement('section', { id: props.route.key }, props.screen.name);
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    if (name === 'react') return React;
    if (name === 'react-native') return { View };
    if (name === 'expo-router') return { usePathname: () => '/settings', useSegments: () => ['settings'], useGlobalSearchParams: () => ({}) };
    if (name.endsWith('/SceneView.js')) return { SceneView: Scene };
    if (name.endsWith('/NavigationContainerRefContext.js')) return { NavigationContainerRefContext };
    throw new Error(name);
  } });
  const scene = (key, focused, routeState) => React.createElement(exports.SceneView, { key, screen: { name: key }, route: { key, name: key },
    navigation: { isFocused: () => focused, addListener: () => () => {} }, routeState, getState: () => ({ routes: [] }), setState: () => {}, options: {}, clearOptions: () => {} });
  // A root stack holding a tab navigator and a modal: only the modal's scene is a focused leaf.
  const html = renderToStaticMarkup(React.createElement(NavigationContainerRefContext.Provider, { value: container },
    scene('tabs', true, { routes: [{ name: 'cats' }] }), scene('cats', false, undefined), scene('settings', true, undefined)));
  const markers = html.match(new RegExp(`<i id="${CAPTURE_OBSERVER_IDENTIFIER}"`, 'g')) ?? [];
  assert.equal(markers.length, 1);
  assert.match(html, new RegExp(`<section id="settings">settings</section><i id="${CAPTURE_OBSERVER_IDENTIFIER}"`));
  const label = html.match(/title="([^"]+)"/)[1].replaceAll('&quot;', '"');
  assert.equal(JSON.parse(label).pathname, '/settings');
});

test('navigation can initialize before the observer imports the Router navigator factories', async t => {
  const generated = await prepareCaptureObserver(await fixture(t));
  const source = await readFile(generated.files[0], 'utf8');
  // SDK57's core barrel loads the scene renderer before assigning
  // createNavigatorFactory. The Router barrel immediately calls that factory.
  // Model actual CommonJS partial exports rather than an already loaded Router.
  const modules = new Map();
  const React = { Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props, children }),
    useContext: () => null, useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const exports = {};
    modules.set(name, exports);
    if (name === 'core') {
      exports.createNavigatorFactory = undefined;
      exports.SceneView = load('observer').SceneView;
      exports.createNavigatorFactory = () => ({ initialized: true });
    } else if (name === 'expo-router') {
      exports.navigator = load('core').createNavigatorFactory();
      exports.usePathname = () => '/'; exports.useSegments = () => [];
      exports.useGlobalSearchParams = () => ({});
    } else if (name === 'observer') {
      vm.runInNewContext(source, { exports, require: request => {
        if (request === 'react') return React;
        if (request === 'react-native') return { View: 'NativeView' };
        if (request === 'expo-router') return load(request);
        if (request.endsWith('/SceneView.js')) return { SceneView: function Original() {} };
        if (request.endsWith('/NavigationContainerRefContext.js')) return { NavigationContainerRefContext: {} };
        throw new Error(request);
      } });
    } else throw new Error(name);
    return exports;
  }
  const core = load('core');
  assert.equal(typeof core.createNavigatorFactory, 'function');
  assert.equal(modules.has('expo-router'), false);
  const tree = core.SceneView({ navigation: { isFocused: () => true, addListener: () => () => {} }, routeState: undefined });
  assert.equal(tree.children[1].type(), null);
  assert.equal(load('expo-router').navigator.initialized, true);
});

test('generated Metro resolver preserves existing configuration and exempts its own original import', async t => {
  const options = await fixture(t);
  const generated = await prepareCaptureObserver(options);
  const source = await readFile(generated.environment.EXPO_OVERRIDE_METRO_CONFIG, 'utf8');
  const base = join(options.project, 'node_modules/expo-router/build/react-navigation/core/SceneView.js');
  const calls = [];
  const previous = (context, name, platform) => { calls.push({ context, name, platform }); return { type: 'sourceFile', filePath: name === 'base' || name === base ? base : '/app/unchanged.js' }; };
  const original = { projectRoot: options.project, transformer: { custom: true }, serializer: { custom: true }, resolver: { custom: true, resolveRequest: previous }, watchFolders: ['/existing'] };
  const appRequire = name => {
    if (name === 'expo/metro-config') return { loadUserConfig: async params => { assert.equal(params.projectRoot, options.project); assert.equal(params.overrideConfigPath, undefined); return original; } };
    if (name === '@expo/config/paths') return { getMetroServerRoot: () => options.project };
    throw new Error(name);
  };
  appRequire.resolve = () => join(options.project, 'node_modules/expo/package.json');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, __dirname: generated.environment.EXPO_OVERRIDE_METRO_CONFIG.replace(/\/metro\.config\.cjs$/, ''), require: name => {
    if (name === 'node:module') return { createRequire: () => appRequire };
    if (name === 'node:fs') return { realpathSync: path => path };
    if (name === 'node:path') return path;
    throw new Error(name);
  } });
  const config = await module.exports;
  assert.equal(config.transformer, original.transformer); assert.equal(config.serializer, original.serializer);
  assert.equal(config.projectRoot, original.projectRoot); assert.equal(config.resolver.custom, true);
  assert.deepEqual([...config.watchFolders], ['/existing', options.outputDirectory]);
  const context = { originModulePath: '/app/entry.js' };
  assert.equal(config.resolver.resolveRequest(context, 'base', 'ios').filePath, generated.files[0]);
  assert.equal(config.resolver.resolveRequest({ originModulePath: generated.files[0] }, base, 'ios').filePath, base);
  config.resolver.resolveRequest({ originModulePath: generated.files[0] }, 'react', 'ios');
  assert.equal(calls.at(-1).context.originModulePath, join(options.project, 'package.json'));
});

test('observer markers collapse only identical copies', () => {
  const label = JSON.stringify(destination());
  const marker = (changes = {}) => ({ identifier: CAPTURE_OBSERVER_IDENTIFIER, type: 'StaticText', label, rect: { x: 0, y: 0, width: 1, height: 1 }, ...changes });
  // agent-device 0.21.x host AX bridge: two identical nodes for one observer.
  assert.equal(captureObserverMarkers([marker(), marker(), { type: 'Button', label: 'Other' }]).length, 1);
  assert.equal(captureObserverMarkers([marker({ rect: undefined }), marker({ rect: undefined })]).length, 1);
  // A different destination or a different scene position remains a separate observer.
  assert.equal(captureObserverMarkers([marker(), marker({ label: JSON.stringify(destination({ pathname: '/cats/7' })) })]).length, 2);
  assert.equal(captureObserverMarkers([marker(), marker({ rect: { x: 0, y: 72, width: 1, height: 1 } })]).length, 2);
  assert.deepEqual(captureObserverMarkers([{ type: 'StaticText', label }]), []);
});

test('a staged mount reached through a symlinked temp dir still gets a relative PROJECT_RELATIVE', async t => {
  const options = await fixture(t);
  const staged = join(options.root, 'staged'); await mkdir(staged);
  const link = join(options.root, 'link'); await symlink(options.root, link);
  const mountProject = join(link, 'staged');
  const { environment } = await prepareCaptureObserver({ ...options, mountProject, outputDirectory: join(mountProject, '.expo-explore-observer') });
  assert.match(await readFile(environment.EXPO_OVERRIDE_METRO_CONFIG, 'utf8'), /PROJECT_RELATIVE = "\.\."/);
});
