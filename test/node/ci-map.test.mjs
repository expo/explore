import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { argentToolServerDirectory } from '../../dist/shared/controller-cache.js';
import { AGENT_DEVICE_VERSION, captureDeepLink, controllerCommandFailure, revisionSetup, runCiMap, runControllerRead, runControllerReadAsync, runAgentControllerCommand } from '../../dist/capture/run.js';
import { CiError, serializeCiError } from '../../dist/shared/ci-errors.js';
import { createSourceCapturePlan } from '../../dist/source/capture-plan.js';
import { CAPTURE_OBSERVER_IDENTIFIER } from '../../dist/capture/observer.js';
import { parseRuntimeExecutionContext } from '../../dist/review/runtime-adapter.js';
import { assertCompleteCaptures, hasVerifiedCapture } from '../../dist/capture/health.js';
import { readCaptureBundle } from '../../dist/review/capture-review.js';
import { writeCaptureObserverPackages } from '../helpers/capture-observer-fixture.mjs';
import { sheetDismissGesture } from '../../dist/capture/route-capture.js';

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const DAEMON_TOKEN = 'private-controller-token-value';
const LOCAL_UDID = '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D';
// The ABI this machine's emulator runs, as Explore picks it.
const HOST_ABI = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';

/** An APK-shaped zip with native libraries for these ABIs: enough for the local emulator's ABI check. */
async function apkWithAbis(abis) {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  for (const abi of abis) await zip.add(`lib/${abi}/libapp.so`, new BlobReader(new Blob(['so'])));
  return Buffer.from(await zip.close());
}
const PREVIEW_TOKEN = 'private-preview-token-value';
const PREVIEW_ID = '5f1e08dd0defd834caf6908fe5ebd38b';
const HEADER = '# Do not commit this file.\n# Do not modify these values manually. They are managed by eas-cli.\n# It holds configuration only for the current simulator session.\n\n';
const png = PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4, 255) });
const splashPng = PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4, 32) });
const route = (id, path = `/${id}`) => ({ id, kind: 'screen', route: path ?? '/item/[id]', path,
  routeFile: path === null ? `app/item/[id].tsx` : `app/${id}.tsx`, sourceFiles: [`app/${id}.tsx`], variant: 'default', provider: 'expo-router', logicalPath: id });
const ok = data => ({ stdout: JSON.stringify({ success: true, data }), stderr: '' });
const json = value => ({ stdout: JSON.stringify(value), stderr: '' });
// agent-device 0.21.15 iOS RunnerTests+Alert.swift uses message/items for alerts. When none
// exists, the runner reports ALERT_NOT_FOUND and the CLI maps it to this public envelope.
const noAlert = () => json({ success: false, error: { code: 'COMMAND_FAILED', message: 'alert not found',
  details: { runnerErrorCode: 'ALERT_NOT_FOUND' } } });
const busyRead = (changes = {}) => json({ success: false, error: { code: 'COMMAND_FAILED',
  message: 'The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen).',
  details: { runnerErrorCode: 'RUNNER_BUSY', retriable: true }, ...changes } });
// A fresh helper's first XCTest-backed snapshot reports its quality; the fixture's plain snapshots do not.
const recoveredSnapshot = result => {
  const value = JSON.parse(result.stdout);
  return { ...result, stdout: JSON.stringify({ ...value, data: { ...value.data, snapshotQuality: { state: 'recovered', backend: 'tree' } } }) };
};
// agent-device 0.21.15 raises this before sending a command when the remote daemon's /health check fails.
const daemonUnavailable = () => json({ success: false, error: { code: 'COMMAND_FAILED', message: 'Remote daemon is unavailable',
  details: { daemonBaseUrl: 'https://daemon.example.invalid', hint: 'Verify AGENT_DEVICE_DAEMON_BASE_URL points to a reachable daemon.' } } });
const value = (request, name) => request.args[request.args.indexOf(name) + 1];
// agent-device 0.21.15 while its XCTest snapshot tiers are deferred and iOS shows the Save Password
// prompt, which com.apple.SafariViewService hosts.
const unreadableSurface = () => json({ success: false, error: { code: 'COMMAND_FAILED',
  message: 'snapshot: regular iOS snapshot presentation requires a valid viewport',
  details: { hint: 'com.apple.SafariViewService hosts the surface presented over the app, and this capture targeted that surface. No snapshot backend could read this screen (XCTest-backed snapshot tiers were deferred after recent slow accessibility work on this screen).' } } });


function agentFixture(actions, observedRequests = []) {
  return { instructions: 'Capture each selected route in its normal loaded state.', contexts: {},
    provider: { provider: 'anthropic', model: 'test-model', preflight: async () => {}, run: async request => {
      const signal = new AbortController().signal;
      for (const original of actions) {
        const observation = await request.callTool('observe', {}, signal);
        const state = JSON.parse(observation.content[0].text);
        const content = [{ type: 'text', text: JSON.stringify({ ...JSON.parse(request.prompt), ...state }) }, ...observation.content.filter(block => block.type === 'image')];
        observedRequests.push({ ...request, messages: [{ role: 'user', content }] });
        const input = typeof original === 'function' ? await original(state, request, content) : original;
        if (!input || input.action === 'observe') continue;
        if (input.action === 'done') await request.callTool('finish', { procedureSummary: 'Completed the instructed review flow.' }, signal);
        else if (input.action === 'capture') {
          const { action: _action, ...args } = input;
          await request.callTool('capture', { ...args, frameId: input.frameId ?? state.frameId }, signal);
        } else await request.callTool('act', input, signal);
      }
      return { inputTokens: 1, outputTokens: 1 };
    } } };
}

// One clock for every fixture, so a run restored from an earlier fixture's cache is still older than the run that reads it.
let clockMs = Date.now();
async function fixture(t, settings = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'explore-source-capture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A local emulator reads the SDK's system images and checks the APK's native libraries.
  const sdk = join(root, 'android-sdk');
  if (settings.local && settings.android) {
    await mkdir(join(sdk, 'system-images', 'android-35', 'google_apis', HOST_ABI), { recursive: true });
    await writeFile(join(sdk, 'system-images', 'android-35', 'google_apis', HOST_ABI, 'system.img'), '');
  }
  const apk = settings.local && settings.android ? await apkWithAbis(settings.abis ?? ['arm64-v8a', 'x86_64']) : 'apk';
  const project = join(root, 'app'); await mkdir(project);
  await writeCaptureObserverPackages(project);
  await writeFile(join(project, 'package.json'), '{"name":"example","main":"index.js"}\n');
  await writeFile(join(project, 'app.json'), JSON.stringify({ expo: { name: 'Example', slug: 'example' } }));
  const routes = settings.routes ?? [route('home'), route('settings')];
  const files = new Map(routes.map(item => [item.routeFile, 'export default function Screen(){return null;}']));
  const plan = createSourceCapturePlan({ baseSha: SHA, headSha: HEAD, baseFiles: files, headFiles: files,
    changedFiles: [], mode: 'all', provider: 'expo-router' });
  const ids = Object.fromEntries(routes.map(item => [item.id, plan.surfaces.find(row => row.baseSurface.routeFile === item.routeFile).id]));
  const planPath = join(root, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  const requests = [];
  let current = '/'; let snapshots = 0; let sessionName; let screenshotAttempts = 0; let splashLeft = 0; let recordingPath = ''; let alert = null; let appearance = 'light'; let alertReads = 0;
  let enteredName = false; let scrolledToContinue = false; let finishHidden = false; let wedgeCleared = false; let deviceLost = false; let relaunchedAfterForeign = false; let serverStarts = 0; let unreadableLeft = settings.unreadableAfterFold ?? 0;
  const deviceName = settings.android ? 'Pixel 7' : 'iPhone 17 Pro';
  const platform = settings.android ? 'android' : 'ios';
  // A local simulator is the one the capture created, named for Explore.
  const deviceId = settings.local ? (settings.android ? settings.serial ?? 'emulator-5556' : LOCAL_UDID) : 'device-1';
  const openedName = settings.deviceMismatch ? 'Wrong device' : settings.local && !settings.android ? `Explore ${deviceName} (base ${SHA.slice(0, 8)})` : deviceName;
  const identity = () => ({ session: 'expo-explore-runtime', appBundleId: 'com.example.app',
    // agent-device 0.20.2 reports no runtime or OS version for a simulator.
    device: { id: deviceId, name: openedName, platform, target: 'mobile',
      locale: 'en-US', orientation: 'portrait', colorScheme: 'light' },
    identifiers: { session: 'expo-explore-runtime', appBundleId: 'com.example.app', deviceId, deviceName: openedName } });
  const runner = request => {
    requests.push(request);
    const command = request.args[0];
    if (request.command === 'git') {
      if (command === 'ls-files') return { stdout: readdirSync(project, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && !relative(project, entry.parentPath).split(sep).includes('node_modules'))
        .map(entry => relative(project, join(entry.parentPath, entry.name))).join('\0') + '\0', stderr: '' };
      return { stdout: command === 'rev-parse' ? `${SHA}\n` : settings.dirty ? ' M app/home.tsx\n' : '', stderr: '' };
    }
    if (request.command.endsWith('/avdmanager')) {
      assert.deepEqual(request.args.slice(0, 2), ['create', 'avd']);
      mkdirSync(join(request.environment.ANDROID_AVD_HOME, `${value(request, '--name')}.avd`));
      return { stdout: '', stderr: '' };
    }
    if (request.command === '/bin/sh') {
      // A local Argent tool-server says where it listens, as `argent server start` does.
      if (request.args[1]?.includes('server start')) {
        const port = 4100 + serverStarts++;
        writeFileSync(request.environment.EXPLORE_ARGENT_SERVER_LOG, `      (or: argent link --host 127.0.0.1 --port ${port} --token abc123)\n[t] Tools server listening on http://127.0.0.1:${port}\n`);
        return { stdout: `${4242 + serverStarts}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    // An emulator process left on a stopped capture's console port: listed until the test's emulatorProcess is killed.
    if (request.command === 'pgrep') return { stdout: settings.emulatorProcess?.exitCode === null && settings.emulatorProcess.signalCode === null ? `${settings.emulatorProcess.pid}\n` : '', stderr: '' };
    if (request.command.endsWith('/adb')) {
      // Another emulator already holds the first console port.
      if (command === 'devices') return { stdout: 'List of devices attached\nemulator-5554\tdevice\n', stderr: '' };
      const rest = request.args.slice(2);
      if (rest[0] === 'shell') return { stdout: rest[2] === 'sys.boot_completed' ? '1\n' : '15\n', stderr: '' };
      if (rest[0] === 'install') { assert.ok(existsSync(rest[2]), 'the instrumented APK is on this machine when it is installed'); return { stdout: 'Success\n', stderr: '' }; }
      if (rest[0] === 'wait-for-device' || rest[0] === 'emu') return { stdout: '', stderr: '' };
    }
    if (request.command === 'xcrun') {
      assert.equal(command, 'simctl');
      const [action, ...rest] = request.args.slice(1);
      if (action === 'list' && rest[0] === 'devicetypes') return json({ devicetypes: [{ name: 'iPhone 17', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
        { name: deviceName, identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }] });
      if (action === 'list' && rest[0] === 'runtimes') return json({ runtimes: [
        { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', version: '26.5', platform: 'iOS', isAvailable: true,
          supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }] },
        { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', version: '27.0', platform: 'iOS', isAvailable: true,
          supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }] },
        { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1', version: '27.1', platform: 'iOS', isAvailable: false,
          supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }] }] });
      if (action === 'create') return { stdout: `${LOCAL_UDID}\n`, stderr: '' };
      if (action === 'install') { assert.ok(existsSync(rest[1]), 'the instrumented app is on this machine when it is installed'); return { stdout: '', stderr: '' }; }
      if (['boot', 'bootstatus', 'shutdown', 'delete', 'spawn', 'ui'].includes(action)) return { stdout: '', stderr: '' };
      // The lit display after a fold: landscape when the inner one is lit, unless the test says the fold did not take.
      if (action === 'io') {
        const open = settings.devicePose === 'open' && !settings.foldIgnored;
        writeFileSync(rest[2], PNG.sync.write(new PNG(open ? { width: 30, height: 20 } : { width: 20, height: 30 })));
        return { stdout: '', stderr: '' };
      }
    }
    if (request.command === 'fake-eas') {
      if (command === 'config') return json({ buildProfile: { ...(settings.android ? { buildType: 'apk' } : { simulator: settings.simulator !== false }), distribution: 'internal', environment: 'preview', env: {} },
        appConfig: { name: 'Example', slug: 'example', owner: 'acme', ...(settings.userInterfaceStyle ? { userInterfaceStyle: settings.userInterfaceStyle } : {}), scheme: settings.noScheme ? undefined : 'sample',
          ...(settings.android ? { android: { package: 'com.example.app' } } : { ios: { bundleIdentifier: 'com.example.app' } }), extra: { eas: { projectId: PROJECT_ID } } } });
      if (command === 'simulator:availability') return json({ available: settings.available !== false });
      if (command === 'fingerprint:generate') return json({ hash: 'source-fingerprint' });
      const buildMetadata = settings.buildMetadata ? { appVersion: '2.1.0', appBuildVersion: '42' } : {};
      if (command === 'build:list') return json(settings.reuse ? [{ id: 'native-build', ...buildMetadata }] : []);
      if (command === 'build') return json([{ id: 'built-app', fingerprint: { hash: 'source-fingerprint' }, ...buildMetadata }]);
      if (command === 'env:pull') { writeFileSync(value(request, '--path'), '# Environment: preview\nEXPO_PUBLIC_ENDPOINT=sample\n'); return { stdout: '', stderr: '' }; }
      if (command === 'build:download') {
        const path = join(request.environment.TMPDIR, settings.android ? 'native.apk' : 'native.app');
        if (settings.android) writeFileSync(path, apk); else mkdirSync(path);
        return json({ path });
      }
      if (command === 'workflow:run') {
        assert.equal(request.environment.EAS_NO_VCS, '1');
        assert.ok(!request.cwd.startsWith(`${project}/`) && request.cwd !== project, 'the staged copy is outside the clean source checkout');
        const workflow = readFileSync(join(request.cwd, request.args[1]), 'utf8');
        assert.match(workflow, /type: repack/); assert.match(workflow, /EAS_NO_VCS: "1"/);
        assert.match(workflow, /EXPO_OVERRIDE_METRO_CONFIG: "\.expo-explore-observer\/metro\.config\.cjs"/);
        assert.match(workflow, /build_id: "(native-build|built-app)"/); assert.match(workflow, /profile: "[A-Za-z0-9_-]+"/);
        assert.match(readFileSync(join(request.cwd, '.expo-explore-observer/metro.config.cjs'), 'utf8'), /PROJECT_RELATIVE = "\.\."/);
        assert.ok(existsSync(join(request.cwd, 'package.json')), 'tracked files are staged');
        assert.ok(!existsSync(join(request.cwd, 'node_modules')), 'untracked files are not staged');
        if (settings.workflowPlanLimit) return json({ jobs: [{ key: 'repack', status: 'FAILURE', turtleBuild: { status: 'ERRORED', error: { message: 'This account has used its local builds from the production_plus plan this month, which will reset in 13 days (on Sat Oct 24 2026). | Request ID: 1234 | Error: GraphQL request failed.' } }, outputs: {} }] });
        if (settings.workflowFailure) return { stdout: json({ jobs: [{ key: 'repack', status: 'FAILURE', turtleBuild: { status: 'ERRORED', error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message: 'Build step "Repack" failed.' } }, outputs: {} }] }).stdout, stderr: 'See logs: https://expo.dev/accounts/acme/projects/example/workflows/run-1\n' };
        return json({ jobs: [{ key: 'repack', status: 'SUCCESS', outputs: { build_id: 'repacked-app', platform: settings.android ? 'android' : 'ios' } }] });
      }
      if (command === 'upload') {
        return json({ url: 'https://expo.dev/accounts/acme/projects/example/builds/repacked-app' });
      }
      if (command === 'simulator:start') {
        sessionName = value(request, '--name');
        writeFileSync(join(request.cwd, '.env.eas-simulator'), HEADER + "EAS_SIMULATOR_SESSION_ID='session-1'\n" + (settings.argent
          ? "ARGENT_TOOLS_URL='https://controller.example/session'\nARGENT_AUTH_TOKEN='" + DAEMON_TOKEN + "'\n"
          : "AGENT_DEVICE_DAEMON_BASE_URL='https://controller.example/session'\nAGENT_DEVICE_DAEMON_AUTH_TOKEN='" + DAEMON_TOKEN + "'\n"));
        if (settings.startFailure) throw new Error('start reported failure after allocation');
        return { stdout: 'ready', stderr: '' };
      }
      if (command === 'simulator:get') return json({ id: 'session-1', name: sessionName, type: settings.argent ? 'argent' : 'agent-device', platform: settings.android ? 'ANDROID' : 'IOS', status: 'IN_PROGRESS',
        app: { id: settings.wrongProject ? 'foreign-project' : PROJECT_ID, slug: 'example', ownerAccount: { name: 'acme' } },
        remoteConfig: { ...(settings.argent ? { toolsUrl: 'https://controller.example/session', toolsAuthToken: DAEMON_TOKEN }
          : { agentDeviceRemoteSessionUrl: 'https://controller.example/session', agentDeviceRemoteSessionToken: DAEMON_TOKEN }),
          // eas-cli --json folds the preview token into an expo.dev page that frames the preview server.
          webPreviewUrl: settings.webPreviewUrl ?? `https://expo.dev/simulator-preview/${PREVIEW_ID}?token=${PREVIEW_TOKEN}`,
          ...(settings.previewApiUrl ? { previewApiUrl: settings.previewApiUrl } : {}) } });
      if (command === 'simulator:stop') {
        if (settings.stopFailure) throw new Error('stop unavailable');
        return json({ id: 'session-1', status: 'STOPPED' });
      }
    }
    if (request.command === 'fake-repack') {
      if (settings.repackFails) throw new Error('repack-app exited with status 1');
      assert.ok(request.args.includes('--js-bundle-only'));
      const observerConfig = request.environment.EXPO_OVERRIDE_METRO_CONFIG;
      assert.ok(observerConfig && !observerConfig.startsWith(`${project}/`), 'observer is staged outside the clean source checkout');
      assert.match(readFileSync(observerConfig, 'utf8'), /navigation-observer/);
      if (settings.android) writeFileSync(value(request, '--output'), apk); else mkdirSync(value(request, '--output'));
      return { stdout: '', stderr: '' };
    }
    // An Argent capture runs its per-run bridge in place of agent-device; the bridge answers in agent-device's envelopes.
    if (request.command === 'fake-controller' || (settings.argent && request.command.endsWith('/argent-controller'))) {
      if (command === '--version') return { stdout: settings.argent ? '0.29.0' : AGENT_DEVICE_VERSION, stderr: '' };
      if (command === 'open') {
        // unreadableAfterFold: Argent's reader stayed on the outer panel, so the first app opens find no readable app.
        if (unreadableLeft > 0 && !request.args[2]?.startsWith('sample://')) { unreadableLeft -= 1;
          return json({ success: false, error: { code: 'APP_NOT_READY', message: 'open: com.example.app did not come up with a readable accessibility tree after relaunching.' } }); }
        if (request.args.includes('--relaunch')) { splashLeft = settings.splashFrames ?? 0; relaunchedAfterForeign = true; if (settings.wedgeAt === current) { wedgeCleared = !settings.wedgeRecurs; current = '/'; } }
        if (request.args[2]?.startsWith('sample://')) {
          const previous = current;
          current = '/' + request.args[2].slice('sample://'.length);
          // A presented sheet swallows the next link until the app is returned to its root.
          if (settings.presentedUntilRoot === previous && current !== '/') current = previous;
          if (settings.statefulSetup && current === '/transient') current = '/setup-required';
          alert = (!settings.alertOnlyAt || settings.alertOnlyAt === current) ? settings.deepLinkAlert ?? null : null;
        }
        if (settings.openFailure === current) throw new Error('route could not open');
        // The emulator's adb connection drops for a few seconds as this route opens, once.
        if (settings.deviceLostOnOpen === current && !deviceLost) { deviceLost = true;
          return json({ success: false, error: { code: 'COMMAND_FAILED', message: "open: device 'emulator-5556' not found",
            details: { reason: 'device_not_found', hint: 'The device disconnected or is restarting — verify it is listed in adb devices, then retry.' } } }); }
        return ok(identity());
      }
      if (command === 'appstate') {
        // foreignUntilRelaunch: a setup tap brought another app to the front; starting the app again brings it back.
        if (settings.foreignUntilRelaunch && !relaunchedAfterForeign) return ok({ appBundleId: 'com.apple.springboard' });
        if (settings.android) return ok({ platform: 'android', package: settings.wrongForeground ? 'com.foreign.app' : 'com.example.app', activity: 'com.example.app.MainActivity' });
        return ok(settings.wrongForeground ? { appBundleId: 'com.foreign.app' } : identity());
      }
      if (command === 'wait') return ok({});
      if (command === 'close') return ok({});
      // claimedSerials: device claims an interrupted run left behind, which agent-device hides as stale but still enforces.
      if (command === 'device') return ok({ claims: [], hiddenStaleClaims: (settings.claimedSerials ?? []).includes(value(request, '--serial')) ? 1 : 0 });
      // An EAS session starts empty while the app is repacked; the controller installs the app from this machine.
      if (command === 'install') { assert.ok(existsSync(request.args[1]), 'the repacked app is on this machine'); return ok({ installed: true, appBundleId: 'com.example.app' }); }
      // agent-device 0.21.15 cannot read Xcode 27.1's hinge angle back, so a local fold reports a failure after folding.
      if (command === 'fold') return settings.local ? json({ success: false, error: { code: 'COMMAND_FAILED', message: "CoreDevice reported no hinge angle sample: Unknown option '--device'" } })
        : ok({ action: 'fold', pose: request.args[1] });
      if (command === 'record' && settings.recording) {
        if (request.args[1] === 'start') { recordingPath = request.args[2]; return ok({ path: recordingPath }); }
        writeFileSync(recordingPath, 'mp4-bytes'); return ok({ path: recordingPath });
      }
      if (command === 'fill') { assert.match(request.args[1], /^@e101~s[1-9][0-9]*$/); enteredName = request.args[2] === 'Mochi'; return ok({}); }
      if (command === 'scroll') { scrolledToContinue = request.args[1] === 'bottom'; return ok({}); }
      if (command === 'press') {
        if (settings.statefulSetup && request.args[1].startsWith('@e102~')) {
          assert.ok(enteredName && scrolledToContinue, 'the transient screen requires real UI input and scrolling');
          current = '/transient';
        } else if (settings.statefulSetup && request.args[1].startsWith('@e103~')) {
          current = '/home'; enteredName = false; scrolledToContinue = false;
        }
        alert = null; return ok({});
      }
      if (command === 'alert') {
        if (request.args[1] === 'get') {
          if (settings.alertProbeFailure) return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'runner transport failed' } });
          if (settings.androidHelperOffline && alertReads++ < settings.androidHelperOffline) {
            return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'alert get: Android snapshot helper failed: Android snapshot helper failed before returning parseable output: adb: device offline' } });
          }
          // agent-device 0.21.15 matches a form sheet's "dismiss popup" window and titles it with the
          // sheet's first text, the route observer (seen on EAS Simulator with Expo Router form sheets).
          if (settings.formSheetPopup) return ok({ message: JSON.stringify({ provider: 'expo-router', pathname: current,
            segments: current.split('/').filter(Boolean), parameters: {} }), items: ['Sheet Grabber', 'Close', 'None'] });
          if (settings.android) return ok({ kind: 'alertStatus', platform: 'android', action: 'get', alert: alert ? { message: alert.message, buttons: alert.items } : null, message: alert ? 'Alert visible' : 'No alert visible' });
          return alert ? ok(alert) : noAlert();
        }
        assert.equal(request.args[1], 'accept');
        if (settings.confirmationFails) throw new Error('alert accept did not dismiss the visible alert');
        if (!settings.confirmationKeepsAlert) alert = null;
        return ok({ message: 'accepted' });
      }
      if (command === 'snapshot') {
        // wedgeAt: the runner wedges on this screen until the app is restarted, as agent-device's did on iPhone Duo's covered Done
        // (with wedgeRecurs, every time the screen is shown again).
        if (settings.wedgeAt === current && !wedgeCleared) return json({ success: false, error: { code: 'COMMAND_FAILED',
          message: 'The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen).' } });
        snapshots += 1;
        // markerMismatchAt: the observer reports another route only at one path (optionally in one appearance).
        const mismatchHere = settings.markerMismatch || (settings.markerMismatchAt && settings.markerMismatchAt.path === current
          && (!settings.markerMismatchAt.scheme || settings.markerMismatchAt.scheme === appearance));
        const pathname = mismatchHere ? '/different' : current;
        const observer = { identifier: CAPTURE_OBSERVER_IDENTIFIER, type: 'StaticText',
          label: settings.invalidObserver ? '{invalid' : JSON.stringify({ provider: 'expo-router', pathname,
            segments: pathname.split('/').filter(Boolean), parameters: {} }), visible: true };
        return ok({ truncated: settings.truncated === true, refsGeneration: snapshots, nodes: [
          ...(settings.logicalBounds ? [{ type: 'Application', rect: settings.logicalBounds, visible: true }] : []),
          { identifier: 'screen-title', type: 'StaticText', label: settings.stableLabels ? current : `${current} live value ${snapshots}`, visible: true },
          // A screen still building exposes a different element each time it is read.
          ...(settings.unsettled && snapshots % 2 === 0 ? [{ identifier: 'late-arrival', type: 'StaticText', label: 'Late', visible: true }] : []),
          ...(settings.snapshotSecret ? [{ type: 'StaticText', identifier: 'diagnostic-secret-fixture', label: settings.snapshotSecret, visible: true }] : []),
          ...(settings.appOpenButton ? [{ type: 'Button', label: 'Open', index: 1, visible: true }] : []),
          // setupButtonMissingIn: one appearance pass has no setup button, so a `tap Get Started` setup step fails there only.
          ...(settings.setupButtonMissingIn === appearance ? [] : [{ type: 'Button', label: 'Get Started', ref: 'e100', enabled: true, visible: true }]),
          ...(settings.statefulSetup && current === '/' ? [
            { type: 'TextField', label: 'Name', ref: 'e101', enabled: true, visible: true },
            { type: 'Button', label: 'Continue', ref: 'e102', enabled: enteredName && scrolledToContinue, visible: scrolledToContinue },
          ] : []),
          ...(settings.statefulSetup && current === '/transient' ? [{ type: 'Button', label: 'Finish', ref: 'e103', enabled: true, visible: !finishHidden }] : []),
          ...(alert ? [{ type: 'Alert', label: alert.message }, ...alert.items.map((label, index) => ({ type: 'Button', label, ref: `e${index + 1}`, enabled: true, visible: true }))] : []),
          ...(settings.missingObserver || settings.missingObserverAt === current ? [] : [observer]),
          // A second active destination is ambiguous; the host AX bridge's identical copy is not.
          ...(settings.duplicateObserver ? [{ ...observer, label: JSON.stringify({ provider: 'expo-router', pathname: '/other', segments: ['other'], parameters: {} }) }] : []),
          ...(settings.bridgeObserverCopy ? [{ ...observer }] : []),
        ] });
      }
      if (command === 'settings') {
        if (request.args[1] === 'appearance') appearance = request.args[2];
        return ok({ setting: request.args[1], value: request.args[2] });
      }
      if (command === 'screenshot') {
        screenshotAttempts += 1;
        if (settings.firstScreenshotFails && screenshotAttempts === 1) throw new Error('temporary screenshot transport error');
        if (screenshotAttempts <= (settings.screenshotFailures ?? 0)) {
          if (settings.preparedStateLost) finishHidden = true;
          throw new Error('temporary screenshot transport error');
        }
        writeFileSync(request.args[1], settings.badPng ? Buffer.from('not a png') : splashLeft-- > 0 ? splashPng : png);
        if (settings.alertAfterScreenshot) alert = { message: 'Allow notifications?', items: ['Cancel', 'Allow'] };
        return ok({ path: request.args[1] });
      }
    }
    throw new Error(`Unexpected command: ${request.command} ${request.args.join(' ')}`);
  };
  const catalogRequests = [];
  const catalog = async (input, init) => {
    catalogRequests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    if (settings.catalogFailure) return new Response('unavailable', { status: 503 });
    if (new URL(String(input)).pathname === '/api/devices') {
      return Response.json({ simulators: [], emulators: [{ id: 'device-1', name: deviceName, version: 'Android 15.0', platform: 'android', booted: true }], errors: [] });
    }
    if (settings.android) return new Response('Not Found', { status: 404 });
    return Response.json({ devices: [
      { device: 'other-device', name: 'iPhone 17 Pro', runtime: 'iOS-18-6', state: 'Shutdown' },
      { device: 'device-1', name: deviceName, runtime: 'iOS-26-5', state: 'Booted' },
    ] });
  };
  const options = { project, mapDirectory: join(root, 'map'), outputDirectory: join(root, 'export'), name: 'Example',
    buildId: 'source-capture', buildVersion: '1', gitCommit: SHA, bundleId: 'com.example.app',
    ...(settings.noScheme ? {} : { scheme: 'sample' }), device: deviceName, easProfile: 'capture', expoToken: 'expo-private', ...(settings.android ? { platform: 'android' } : {}),
    planPath, maxScreens: 120, maxActions: 500, maxDurationMinutes: 30, forceFreshBuild: false,
    confirmExternalRun: true, confirmTrustedSource: true, easCommand: 'fake-eas', repackCommand: 'fake-repack', agentDeviceCommand: 'fake-controller', ...(settings.argent ? { controller: 'argent' } : {}), ...(settings.devicePose ? { devicePose: settings.devicePose } : {}), ...(settings.launch ? { launch: settings.launch, recordingTools: settings.recordingTools ?? null } : {}), ...(settings.repack ? { repack: settings.repack } : {}), ...(settings.local ? { simulator: 'local' } : {}),
    environment: { PATH: process.env.PATH, HOME: root, ...(settings.local && settings.android ? { ANDROID_HOME: sdk, TMPDIR: root } : {}), GITHUB_TOKEN: 'github-private', ANTHROPIC_API_KEY: 'must-not-be-used', AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'wrong-token', ...settings.environment },
    // Every controller round trip advances the fixture clock by one poll interval, as a device snapshot would.
    runner: request => { clockMs += 600; return runner(request); }, now: () => clockMs, sleep: milliseconds => { clockMs += milliseconds; }, fetch: catalog };
  return { root, options, requests, catalogRequests, routes, ids, plan, operations: () => requests.map(request => request.args[0]) };
}

test('source plan captures the configured device without app fixtures or model execution', async t => {
  const f = await fixture(t);
  const result = await runCiMap(f.options);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.contract, 'explore.bundle');
  assert.deepEqual(Object.keys(bundle.images), [f.ids.home, f.ids.settings]);
  assert.equal(bundle.outcomes[f.ids.home].landing, 'verified');
  assert.equal(f.requests.some(request => request.args.includes('--relaunch')), false, 'capture preserves UI-created application state');
  assert.equal(result.simulatorRuntime.deviceModel, 'iPhone 17 Pro');
  assert.equal(result.simulatorRuntime.osVersion, '26.5', 'the version comes from the opened device, not another runtime');
  assert.deepEqual(f.catalogRequests, [{ url: `https://web-preview-${PREVIEW_ID}.eas-simulator.ngrok.dev/grid/api?limit=1000`, authorization: `Bearer ${PREVIEW_TOKEN}` }],
    'the catalog lives on the framed preview server, not on the expo.dev page');
  assert.equal(result.simulatorRuntime.sessionLifecycle, 'stopped');
  assert.equal(value(f.requests.find(request => request.args[0] === 'simulator:start'), '--device'), 'iPhone 17 Pro');
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
  assert.equal(f.requests.some(request => request.command.includes('claude')), false);
  for (const request of f.requests.filter(request => request.command === 'fake-controller')) {
    assert.equal(request.environment.EXPO_TOKEN, undefined);
    assert.equal(request.environment.GITHUB_TOKEN, undefined);
    assert.equal(request.environment.ANTHROPIC_API_KEY, undefined);
  }
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.observations.length, 2);
  assert.deepEqual(map.screens.map(screen => screen.id), [f.ids.home, f.ids.settings]);
  assert.equal(f.operations().includes('orientation'), false);
  // The only setting a capture touches is the appearance, pinned once per pass: light, since the app declares no style.
  assert.deepEqual(f.requests.filter(request => request.args[0] === 'settings').map(request => request.args.slice(1, 3)), [['appearance', 'light']]);
});

test('an app that follows the system appearance is captured light then dark, dark as @dark screens', async t => {
  const f = await fixture(t, { userInterfaceStyle: 'automatic' });
  const result = await runCiMap(f.options);
  assert.equal(result.runStatus, 'complete');
  assert.deepEqual(f.requests.filter(request => request.args[0] === 'settings').map(request => request.args.slice(1, 3)), [['appearance', 'light'], ['appearance', 'dark']]);
  assert.equal(f.requests.filter(request => request.args[0] === 'screenshot').length, 4);
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.deepEqual(map.run.environment.colorSchemes, ['light', 'dark']);
  assert.equal(map.run.environment.colorScheme, 'light');
  assert.deepEqual(map.screens.map(screen => [screen.id, screen.colorScheme]),
    [[f.ids.home, 'light'], [f.ids.settings, 'light'], [`${f.ids.home}@dark`, 'dark'], [`${f.ids.settings}@dark`, 'dark']]);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(Object.keys(bundle.images).sort(), [f.ids.home, `${f.ids.home}@dark`, f.ids.settings, `${f.ids.settings}@dark`].sort());
  assert.deepEqual(Object.keys(bundle.outcomes).sort(), [f.ids.home, f.ids.settings]);
  assert.equal(bundle.runtimeProfile.colorSchemes, 'light,dark');
  // The review stage parses this file strictly; a field it does not know silently drops the runtime evidence.
  const execution = parseRuntimeExecutionContext(JSON.parse(await readFile(join(f.options.outputDirectory, 'execution.json'), 'utf8')));
  assert.deepEqual(execution.colorSchemes, ['light', 'dark']);
  assert.equal(execution.colorScheme, 'light');
});

test('an app pinned to one appearance is captured once, in that appearance', async t => {
  const f = await fixture(t, { userInterfaceStyle: 'dark' });
  const result = await runCiMap(f.options);
  assert.equal(result.runStatus, 'complete');
  assert.deepEqual(f.requests.filter(request => request.args[0] === 'settings').map(request => request.args.slice(1, 3)), [['appearance', 'dark']]);
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.run.environment.colorSchemes, undefined);
  assert.deepEqual(map.screens.map(screen => [screen.id, screen.colorScheme]), [[f.ids.home, undefined], [f.ids.settings, undefined]]);
});

test('an Argent capture starts an argent session, drives it through the bridge, and records Argent as the controller', async t => {
  const f = await fixture(t, { argent: true, userInterfaceStyle: 'automatic', environment: { AGENT_DEVICE_DAEMON_BASE_URL: 'https://wrong.example', ARGENT_TOOLS_URL: 'https://wrong.example' } });
  const lines = [];
  const result = await runCiMap({ ...f.options, progress: line => lines.push(line) });
  assert.equal(result.runStatus, 'complete');
  const start = f.requests.find(request => request.args[0] === 'simulator:start');
  assert.equal(value(start, '--type'), 'argent');
  assert.equal(value(start, '--package-version'), '0.29.0');
  assert.ok(start.args.includes('--public-link'));
  const controller = f.requests.filter(request => request.command.endsWith('/argent-controller'));
  assert.ok(controller.length > 0);
  assert.ok(!f.requests.some(request => request.command === 'fake-controller'), 'every controller call goes through the bridge');
  for (const request of controller) {
    assert.equal(request.environment.ARGENT_TOOLS_URL, 'https://controller.example/session');
    assert.equal(request.environment.ARGENT_AUTH_TOKEN, DAEMON_TOKEN);
    assert.equal(request.environment.DO_NOT_TRACK, '1');
    assert.equal(request.environment.EXPLORE_ARGENT_PLATFORM, 'ios');
    assert.equal(request.environment.EXPLORE_ARGENT_BUNDLE_ID, 'com.example.app');
    assert.ok(request.environment.HOME.endsWith('/argent-home') && request.environment.HOME !== f.options.environment.HOME, 'Argent gets a HOME of its own');
    assert.deepEqual(Object.keys(request.environment).filter(name => name.startsWith('AGENT_DEVICE_')), []);
  }
  // Argent cannot switch appearance yet: one pass, no `settings appearance`, and a warning naming what was skipped.
  assert.equal(f.requests.some(request => request.args[0] === 'settings'), false);
  assert.ok(lines.some(line => /Argent cannot switch appearance yet .*capturing light only, skipped dark/.test(line)), lines.join('\n'));
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.run.controller, 'argent');
  assert.equal(map.run.environment.colorSchemes, undefined);
  assert.deepEqual(map.screens.map(screen => screen.id), [f.ids.home, f.ids.settings]);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.controller, 'argent');
  const execution = parseRuntimeExecutionContext(JSON.parse(await readFile(join(f.options.outputDirectory, 'execution.json'), 'utf8')));
  assert.equal(execution.controller, 'argent');
  assert.equal(execution.controllerPackageVersion, '0.29.0');
});

test('an Argent capture of an app pinned to dark is labelled dark and is not warned about', async t => {
  const f = await fixture(t, { argent: true, userInterfaceStyle: 'dark' });
  const lines = [];
  await runCiMap({ ...f.options, progress: line => lines.push(line) });
  assert.equal(lines.some(line => /Argent cannot switch appearance/.test(line)), false);
  const execution = parseRuntimeExecutionContext(JSON.parse(await readFile(join(f.options.outputDirectory, 'execution.json'), 'utf8')));
  assert.equal(execution.colorScheme, 'dark');
});

test('device.pose folds the device first, before the app is opened, read or captured', async t => {
  for (const argent of [false, true]) {
    const f = await fixture(t, { devicePose: 'open', argent });
    assert.equal((await runCiMap(f.options)).runStatus, 'complete');
    const controller = f.requests.filter(request => request.command === 'fake-controller' || request.command.endsWith('/argent-controller'));
    const folds = controller.filter(request => request.args[0] === 'fold');
    assert.equal(folds.length, 1);
    assert.deepEqual(folds[0].args.slice(0, 2), ['fold', 'open']);
    const foldAt = controller.indexOf(folds[0]);
    // The fold comes first: the app is installed but not opened, read or captured before it, so the controller starts on the lit panel.
    assert.deepEqual(controller.slice(0, foldAt).map(request => request.args[0]).filter(command => command !== '--version' && command !== 'install'), []);
    // Argent's bridge is told the pose, so it captures the opened panel's landscape UI upright.
    if (argent) for (const request of controller) assert.equal(request.environment.EXPLORE_ARGENT_POSE, 'open');
  }
});

test('a local simulator capture creates its own iOS simulator, installs the repacked app there, and deletes the simulator', async t => {
  for (const repack of ['local', 'eas']) {
    const f = await fixture(t, { local: true, repack });
    const result = await runCiMap({ ...f.options, sessionStatePath: join(f.root, `session-${repack}`) });
    assert.equal(result.runStatus, 'complete', JSON.stringify(result.outcomes));
    const eas = f.requests.filter(request => request.command === 'fake-eas').map(request => request.args[0]);
    assert.equal(eas.some(command => command.startsWith('simulator:')), false, 'no EAS Simulator session or availability check');
    // A local repack's app stays on this machine; a hosted one is downloaded back.
    assert.equal(eas.includes('upload'), false);
    if (repack === 'eas') assert.ok(eas.includes('workflow:run') && eas.includes('build:download'));
    // Every captured route exports its frame. A local repack is never uploaded, so its frames name the native build it repacked.
    const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
    const captured = Object.keys(bundle.outcomes).filter(id => bundle.outcomes[id].status === 'captured');
    assert.ok(captured.length > 0);
    assert.deepEqual(captured.filter(id => !bundle.images[id]), [], 'no captured route is missing its image');
    for (const id of captured) assert.equal(bundle.images[id].buildId, repack === 'local' ? 'built-app' : result.easBuildId);
    assert.equal(bundle.easBuildId, bundle.images[captured[0]].buildId, 'the review names the build its frames came from');
    const simctl = f.requests.filter(request => request.command === 'xcrun').map(request => request.args.slice(1));
    assert.deepEqual(simctl.find(args => args[0] === 'create'),
      ['create', `Explore iPhone 17 Pro (base ${SHA.slice(0, 8)})`, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', 'com.apple.CoreSimulator.SimRuntime.iOS-27-0'],
      'the newest available runtime that runs the device');
    assert.deepEqual(simctl.map(args => args[0]).filter(action => action !== 'list'), ['create', 'boot', 'bootstatus', 'spawn', 'install', 'shutdown', 'delete']);
    // The app's links open without iOS asking first.
    assert.deepEqual(simctl.find(args => args[0] === 'spawn'), ['spawn', LOCAL_UDID, 'defaults', 'write', 'com.apple.launchservices.schemeapproval',
      'com.apple.CoreSimulator.CoreSimulatorBridge-->sample', '-string', 'com.example.app']);
    assert.equal(existsSync(join(f.root, `session-${repack}`)), false, 'the recorded simulator is cleared once it is deleted');
    assert.deepEqual(await readdir(join(f.root, '.cache', 'expo-explore', 'local-captures')), [], 'a clean stop leaves nothing for a later sweep');
    const controller = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] !== '--version' && request.args[0] !== 'close');
    assert.ok(controller.length > 0);
    for (const request of controller) {
      assert.equal(value(request, '--udid'), LOCAL_UDID, `${request.args[0]} targets the created simulator`);
      assert.equal(request.args.includes('--device'), false);
      assert.equal(request.environment.AGENT_DEVICE_DAEMON_BASE_URL, undefined, 'agent-device runs locally');
      assert.equal(request.environment.AGENT_DEVICE_DAEMON_AUTH_TOKEN, undefined);
      assert.ok(request.environment.AGENT_DEVICE_STATE_DIR, 'its own daemon, so head and base do not share one');
    }
    assert.equal(result.simulatorSessionId, null);
    assert.equal(result.simulatorRuntime.provider, 'local-simulator');
    assert.equal(result.simulatorRuntime.deviceModel, 'iPhone 17 Pro', 'the model it was created as, not the Explore name');
    assert.equal(result.simulatorRuntime.osVersion, '27.0');
    const execution = parseRuntimeExecutionContext(JSON.parse(await readFile(join(f.options.outputDirectory, 'execution.json'), 'utf8')));
    assert.equal(execution.provider, 'local-simulator');
  }
});

test('Argent drives a local simulator through a tool-server of the capture\'s own, and the host switches the appearance', async t => {
  const f = await fixture(t, { local: true, argent: true, repack: 'local', userInterfaceStyle: 'automatic' });
  // The tool-server is installed already, as the pipeline's prefetch leaves it.
  const cache = join(f.root, 'controllers');
  mkdirSync(argentToolServerDirectory(cache), { recursive: true });
  writeFileSync(join(argentToolServerDirectory(cache), '.explore-controller.json'), '{}');
  const result = await runCiMap({ ...f.options, environment: { ...f.options.environment, EXPLORE_CONTROLLER_CACHE: cache } });
  assert.equal(result.runStatus, 'complete', JSON.stringify(result.outcomes));
  const bridge = f.requests.filter(request => request.command.endsWith('/argent-controller'));
  assert.ok(bridge.length > 0);
  for (const request of bridge) {
    assert.equal(request.environment.ARGENT_TOOLS_URL, 'http://127.0.0.1:4100');
    assert.equal(request.environment.ARGENT_AUTH_TOKEN, 'abc123');
    assert.equal(request.environment.EXPLORE_ARGENT_DEVICE, LOCAL_UDID, 'the bridge drives the capture\'s own simulator');
    assert.equal(request.environment.EXPLORE_ARGENT_POSE, undefined, 'no pose, so screenshots are captured as Argent reads the screen');
  }
  // Both appearances, switched with simctl, since Argent cannot.
  assert.deepEqual(f.requests.filter(request => request.command === 'xcrun' && request.args[1] === 'ui').map(request => request.args.slice(2)), [[LOCAL_UDID, 'appearance', 'light'], [LOCAL_UDID, 'appearance', 'dark']]);
  assert.equal(f.requests.some(request => request.command === 'fake-eas' && request.args[0].startsWith('simulator:')), false);
});

test('a local Android capture starts its own emulator in a private AVD home, installs the APK there, and stops it', async t => {
  const f = await fixture(t, { local: true, android: true, repack: 'local' });
  const result = await runCiMap({ ...f.options, sessionStatePath: join(f.root, 'session') });
  assert.equal(result.runStatus, 'complete', JSON.stringify(result.outcomes));
  const eas = f.requests.filter(request => request.command === 'fake-eas').map(request => request.args[0]);
  assert.equal(eas.some(command => command.startsWith('simulator:') || command === 'upload'), false);
  const create = f.requests.find(request => request.command.endsWith('/avdmanager'));
  assert.equal(value(create, '--device'), 'Pixel 7');
  assert.equal(value(create, '--package'), `system-images;android-35;google_apis;${HOST_ABI}`);
  assert.ok(!create.environment.ANDROID_AVD_HOME.startsWith(f.root + '/app'), 'the AVD is not in the app');
  const start = f.requests.find(request => request.command === '/bin/sh');
  assert.equal(start.args[start.args.indexOf('-port') + 1], '5556', 'the next free console port');
  assert.ok(start.args.includes('-no-window'));
  const adb = f.requests.filter(request => request.command.endsWith('/adb')).map(request => request.args.slice(2, 3)[0] ?? request.args[0]);
  assert.ok(adb.indexOf('install') < adb.indexOf('emu'), 'installed, then stopped at the end');
  assert.deepEqual(adb.slice(adb.lastIndexOf('emu')), ['emu', 'devices'], 'stopped, and checked gone');
  for (const request of f.requests.filter(request => request.command === 'fake-controller' && !['--version', 'close'].includes(request.args[0]))) {
    assert.equal(value(request, '--serial'), 'emulator-5556', `${request.args[0]} targets the started emulator`);
    assert.equal(request.environment.AGENT_DEVICE_DAEMON_BASE_URL, undefined);
  }
  assert.equal(result.simulatorRuntime.provider, 'local-simulator');
  assert.equal(result.simulatorRuntime.osVersion, '15');
  assert.equal(existsSync(join(f.root, 'session')), false);
  assert.equal(existsSync(join(f.root, '.cache', 'expo-explore', 'emulator-ports', '5556.lock')), false, 'its console port is free again');
  assert.deepEqual(await readdir(join(f.root, '.cache', 'expo-explore', 'local-captures')), [], 'a clean stop leaves nothing for a later sweep');
});

test('a local emulator adb has lost is stopped by its process', async t => {
  // A real process stands in for the emulator: adb does not list it and emu kill does not reach it.
  const emulatorProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => emulatorProcess.kill('SIGKILL'));
  const exited = new Promise(resolve => emulatorProcess.once('exit', resolve));
  const f = await fixture(t, { local: true, android: true, repack: 'local', emulatorProcess });
  const result = await runCiMap({ ...f.options, sessionStatePath: join(f.root, 'session') });
  assert.equal(result.runStatus, 'complete', JSON.stringify(result.outcomes));
  assert.equal(await exited, null, 'the emulator process was signalled');
  const pgrep = f.requests.find(request => request.command === 'pgrep');
  assert.equal(pgrep.args[1], 'qemu-system.* -avd explore-[a-z]+-[0-9a-f]{8} -port 5556 ', 'only an Explore emulator on this capture\'s port');
  assert.equal(existsSync(join(f.root, '.cache', 'expo-explore', 'emulator-ports', '5556.lock')), false);
});

test('a local emulator skips a console port another capture holds and takes over one an exited run left', async t => {
  const f = await fixture(t, { local: true, android: true, repack: 'local', serial: 'emulator-5558' });
  // Another capture of this process has reserved 5556, and one that exited left 5558's reservation behind.
  // Reservations live in this user's Explore cache (HOME is the fixture's root), not the shared temporary directory.
  await mkdir(join(f.root, '.cache', 'expo-explore', 'emulator-ports'), { recursive: true });
  await writeFile(join(f.root, '.cache', 'expo-explore', 'emulator-ports', '5556.lock'), String(process.pid));
  await writeFile(join(f.root, '.cache', 'expo-explore', 'emulator-ports', '5558.lock'), '999999999');
  assert.equal((await runCiMap(f.options)).runStatus, 'complete');
  const start = f.requests.find(request => request.command === '/bin/sh');
  assert.equal(start.args[start.args.indexOf('-port') + 1], '5558');
  assert.equal(existsSync(join(f.root, '.cache', 'expo-explore', 'emulator-ports', '5556.lock')), true, 'the other capture keeps its port');
});

test('of captures reserving one console port at the same moment, exactly one gets it', async t => {
  const module = new URL('../../dist/capture/local-simulator.js', import.meta.url).href;
  const root = await mkdtemp(join(tmpdir(), 'explore-port-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ports = join(root, 'emulator-ports');
  // Head and base of one review start their emulators together, each on its own worker thread of one process.
  const reserveOnThread = () => new Promise((resolve, reject) => {
    const worker = new Worker(`import(${JSON.stringify(module)}).then(m => m.reservePort(5554, { EXPLORE_CACHE_DIR: ${JSON.stringify(root)} })).then(r => require('node:worker_threads').parentPort.postMessage(r));`, { eval: true });
    worker.once('message', resolve); worker.once('error', reject);
  });
  for (let round = 0; round < 30; round++) {
    await rm(ports, { recursive: true, force: true });
    await mkdir(ports, { recursive: true });
    // Free; left behind by a run that exited (its process is gone); or that, with the mutex too, which that run died holding.
    if (round % 3) await writeFile(join(ports, '5554.lock'), '999999999');
    if (round % 3 === 2) { await mkdir(join(ports, 'mutex')); await writeFile(join(ports, 'mutex', 'owner'), '999999999'); }
    const reserved = await Promise.all(Array.from({ length: 4 }, reserveOnThread));
    assert.equal(reserved.filter(Boolean).length, 1, `round ${round}: ${reserved}`);
    assert.equal(await readFile(join(ports, '5554.lock'), 'utf8'), String(process.pid));
    assert.equal(existsSync(join(ports, 'mutex')), false, 'the mutex is released');
  }
});

test('a local emulator skips a port whose serial agent-device still claims for an interrupted run', async t => {
  const f = await fixture(t, { local: true, android: true, repack: 'local', claimedSerials: ['emulator-5556'], serial: 'emulator-5558' });
  assert.equal((await runCiMap(f.options)).runStatus, 'complete');
  const start = f.requests.find(request => request.command === '/bin/sh');
  assert.equal(start.args[start.args.indexOf('-port') + 1], '5558');
});

test('a local Android capture refuses an APK without libraries for this machine before installing it, and stops its emulator', async t => {
  const other = HOST_ABI === 'arm64-v8a' ? 'x86_64' : 'arm64-v8a';
  const f = await fixture(t, { local: true, android: true, repack: 'local', abis: [other] });
  await assert.rejects(runCiMap(f.options), error => error.code === 'LOCAL_EMULATOR_ABI_UNSUPPORTED');
  const adb = f.requests.filter(request => request.command.endsWith('/adb')).map(request => request.args[2] ?? request.args[0]);
  assert.equal(adb.includes('install'), false);
  assert.ok(adb.includes('emu'), 'the emulator started during the repack is stopped');
});

test('a local device starts before the build, so it boots while the app is repacked', async t => {
  for (const android of [false, true]) {
    const f = await fixture(t, { local: true, android, repack: 'local' });
    assert.equal((await runCiMap(f.options)).runStatus, 'complete');
    const order = f.requests.map(request => request.command === 'fake-repack' ? 'repack'
      : request.command === 'xcrun' && ['boot', 'bootstatus'].includes(request.args[1]) ? request.args[1]
      : request.command === '/bin/sh' ? 'boot' : request.command.endsWith('/adb') && request.args[2] === 'wait-for-device' ? 'bootstatus' : undefined).filter(Boolean);
    assert.deepEqual(order, ['boot', 'repack', 'bootstatus'], android ? 'Android' : 'iOS');
  }
});

test('a failed repack deletes the local device it started', async t => {
  const f = await fixture(t, { local: true, repack: 'local', repackFails: true });
  await assert.rejects(runCiMap(f.options));
  assert.deepEqual(f.requests.filter(request => request.command === 'xcrun').map(request => request.args[1]).slice(-2), ['shutdown', 'delete']);
});

test('when Argent cannot read the app after a fold, the capture restarts its local tool-server and opens the app again', async t => {
  const f = await fixture(t, { local: true, argent: true, repack: 'local', devicePose: 'open', unreadableAfterFold: 1 });
  const cache = join(f.root, 'controllers');
  mkdirSync(argentToolServerDirectory(cache), { recursive: true });
  writeFileSync(join(argentToolServerDirectory(cache), '.explore-controller.json'), '{}');
  const lines = [];
  const result = await runCiMap({ ...f.options, environment: { ...f.options.environment, EXPLORE_CONTROLLER_CACHE: cache }, progress: line => lines.push(line) });
  assert.equal(result.runStatus, 'complete', JSON.stringify(result.outcomes));
  assert.equal(f.requests.filter(request => request.command === '/bin/sh' && request.args[1]?.includes('server start')).length, 2);
  assert.ok(lines.some(line => /restarting Argent's tool-server/.test(line)), lines.join('\n'));
  // Every call after the restart goes to the new server.
  const bridge = f.requests.filter(request => request.command.endsWith('/argent-controller'));
  assert.equal(bridge.at(-1).environment.ARGENT_TOOLS_URL, 'http://127.0.0.1:4101');

  // A second failure restarts SpringBoard as well; a third is reported.
  for (const [unreadable, completes] of [[2, true], [3, false]]) {
    const again = await fixture(t, { local: true, argent: true, repack: 'local', devicePose: 'open', unreadableAfterFold: unreadable });
    mkdirSync(argentToolServerDirectory(join(again.root, 'controllers')), { recursive: true });
    writeFileSync(join(argentToolServerDirectory(join(again.root, 'controllers')), '.explore-controller.json'), '{}');
    const run = runCiMap({ ...again.options, environment: { ...again.options.environment, EXPLORE_CONTROLLER_CACHE: join(again.root, 'controllers') } });
    if (completes) assert.equal((await run).runStatus, 'complete');
    else await assert.rejects(run, error => JSON.stringify(error).includes('APP_NOT_READY'));
    assert.deepEqual(again.requests.filter(request => request.command === 'xcrun' && request.args[3] === 'launchctl').map(request => request.args.slice(3)),
      [['launchctl', 'kickstart', '-k', 'system/com.apple.SpringBoard']]);
  }
});

test('a local foldable opens the app, folds, and is checked by the shape of its lit display', async t => {
  const f = await fixture(t, { local: true, repack: 'local', devicePose: 'open' });
  assert.equal((await runCiMap(f.options)).runStatus, 'complete');
  const controller = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] !== '--version');
  assert.deepEqual(controller.slice(0, 2).map(request => request.args[0]), ['open', 'fold'], 'a local fold needs a session');
  assert.equal(value(controller[1], '--udid'), LOCAL_UDID);
  assert.ok(f.requests.some(request => request.command === 'xcrun' && request.args[1] === 'io'));

  const ignored = await fixture(t, { local: true, repack: 'local', devicePose: 'open', foldIgnored: true });
  await assert.rejects(runCiMap(ignored.options), error => error.code === 'CONTROLLER_FOLD_UNVERIFIED' && /hinge angle/.test(error.message));
  assert.deepEqual(ignored.requests.filter(request => request.command === 'xcrun').map(request => request.args[1]).slice(-2), ['shutdown', 'delete']);
});

test('a controller that wedges on one screen costs that route only: the app restarts and later routes are captured', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings'), route('profile')], wedgeAt: '/settings', stableLabels: true });
  const lines = [];
  const result = await runCiMap({ ...f.options, progress: line => lines.push(line) });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'failed');
  assert.match(result.outcomes[f.ids.settings].reason, /stopped answering on this screen/);
  assert.match(result.outcomes[f.ids.settings].error.message, /execution watchdog/, 'the report says what the controller did');
  assert.equal(result.outcomes[f.ids.profile].status, 'captured', 'the route after the wedge starts on a restarted app');
  assert.ok(lines.some(line => /stopped answering on \/settings/.test(line)), lines.join('\n'));
  const recoveries = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics', 'controller-recoveries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recoveries.map(entry => [entry.where, entry.recovered]), [['/settings', true]]);
});

test('a controller that wedges during setup does not fail every route: setup stops there and routes go on by app link', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')], wedgeAt: '/setup', stableLabels: true });
  const lines = [];
  const result = await runCiMap({ ...f.options, setup: [{ action: 'open', url: 'sample://setup' }], progress: line => lines.push(line) });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  assert.ok(lines.some(line => /setup stopped \(/.test(line)), lines.join('\n'));
  const recoveries = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics', 'controller-recoveries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recoveries.map(entry => [entry.where, entry.recovered]), [['a setup step', true]]);
});

test('a setup step that wedges the controller once runs setup again from the start, and the routes are captured as usual', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')], wedgeAt: '/setup', stableLabels: true });
  const lines = [];
  const result = await runCiMap({ ...f.options, setup: [{ action: 'open', url: 'sample://setup' }, { action: 'open', url: 'sample://ready' }], progress: line => lines.push(line) });
  assert.ok(lines.some(line => /setup stopped \(.*\); running setup again from the start/.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => /setup 2\/2:/.test(line)), 'every setup step ran on the rerun');
  for (const id of [f.ids.home, f.ids.settings]) {
    assert.equal(result.outcomes[id].status, 'captured');
    assert.equal(result.outcomes[id].landing, 'verified');
    assert.equal(result.outcomes[id].reason, undefined, 'setup completed, so the outcome carries no setup note');
  }
  const recoveries = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics', 'controller-recoveries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recoveries.map(entry => [entry.where, entry.recovered, entry.next]), [['a setup step', true, 'setup-rerun']]);
});

test('a setup step that wedges again on the rerun lets routes go on by app link, each marked as captured without complete setup', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')], wedgeAt: '/setup', wedgeRecurs: true, stableLabels: true });
  const lines = [];
  const result = await runCiMap({ ...f.options, setup: [{ action: 'open', url: 'sample://setup' }, { action: 'open', url: 'sample://ready' }], progress: line => lines.push(line) });
  assert.ok(lines.some(line => /setup stopped again \(/.test(line)), lines.join('\n'));
  assert.ok(!lines.some(line => /setup 2\/2:/.test(line)), 'the steps after the wedge never ran');
  for (const id of [f.ids.home, f.ids.settings]) {
    assert.equal(result.outcomes[id].status, 'captured', 'the routes are not failed');
    assert.match(result.outcomes[id].reason, /Setup did not complete/);
  }
  const recoveries = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics', 'controller-recoveries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recoveries.map(entry => [entry.where, entry.recovered, entry.next]), [['a setup step', true, 'setup-rerun'], ['a setup step', true, 'setup-incomplete']]);
});

test('a setup step that leaves another app in front costs that step: the app restarts and the routes are captured', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')], foreignUntilRelaunch: true, stableLabels: true });
  const lines = [];
  const result = await runCiMap({ ...f.options, setup: [{ action: 'tap', label: 'Get Started' }], progress: line => lines.push(line) });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  assert.ok(lines.some(line => /the app was no longer in front on a setup step \(CONTROLLER_IDENTITY_MISMATCH\)/.test(line)), lines.join('\n'));
});

test('a local simulator capture deletes its simulator when the capture fails', async t => {
  const f = await fixture(t, { local: true, repack: 'local', openFailure: '/' });
  const result = await runCiMap(f.options).catch(error => error);
  assert.ok(result instanceof Error || result.runStatus === 'partial');
  const simctl = f.requests.filter(request => request.command === 'xcrun').map(request => request.args[1]);
  assert.deepEqual(simctl.slice(-2), ['shutdown', 'delete']);
});

test('an EAS session asks for the capture minutes plus a repack allowance, and a plan that refuses them gets its own maximum', async t => {
  const minutes = request => Number(value(request, '--max-duration-minutes'));
  const f = await fixture(t);
  await runCiMap(f.options);
  assert.deepEqual(f.requests.filter(request => request.args[0] === 'simulator:start').map(minutes), [50]);
  // EAS names the plan's maximum when it refuses; the start is retried once, never with less than the capture's own 30.
  for (const [limit, retried] of [[40, 40], [20, 30]]) {
    const f = await fixture(t);
    const starts = [];
    const result = await runCiMap({ ...f.options, runner: request => {
      if (request.command === 'fake-eas' && request.args[0] === 'simulator:start' && (starts.push(minutes(request)), starts.length === 1))
        throw new Error(`Controller simulator:start exited with status 1: Failed to create simulator session | Device run session max duration must not exceed ${limit} minutes for this account; received 50 minutes.`);
      return f.options.runner(request);
    } });
    assert.equal(result.runStatus, 'complete');
    assert.deepEqual(starts, [50, retried]);
  }
  // Any other start failure is not retried.
  const g = await fixture(t);
  let other = 0;
  await assert.rejects(runCiMap({ ...g.options, runner: request => {
    if (request.command === 'fake-eas' && request.args[0] === 'simulator:start') { other += 1; throw new Error('Controller simulator:start exited with status 1: quota exhausted'); }
    return g.options.runner(request);
  } }), error => error.code === 'SIMULATOR_START_FAILED');
  assert.equal(other, 1);
});

test('an agent-device capture writes no controller into its bundle', async t => {
  const f = await fixture(t);
  await runCiMap(f.options);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal('controller' in bundle, false);
  const start = f.requests.find(request => request.args[0] === 'simulator:start');
  assert.equal(value(start, '--type'), 'agent-device');
  assert.equal(value(start, '--package-version'), AGENT_DEVICE_VERSION);
});

test('a preview URL that names the preview server directly reads its catalog', async t => {
  const f = await fixture(t, { webPreviewUrl: `https://web-preview-${PREVIEW_ID}.eas-simulator.ngrok.dev/?token=${PREVIEW_TOKEN}` });
  const result = await runCiMap(f.options);
  assert.equal(result.simulatorRuntime.osVersion, '26.5');
  assert.deepEqual(f.catalogRequests.map(request => request.url), [`https://web-preview-${PREVIEW_ID}.eas-simulator.ngrok.dev/grid/api?limit=1000`]);
});

test('sessions start with a public preview link, and eas-cli 25 publishes its token on previewApiUrl', async t => {
  // eas-cli 25 omits the preview token from a private session's --json output; a --public-link session carries it on
  // previewApiUrl (the preview server itself) and in the fragment of the expo.dev page.
  const f = await fixture(t, { webPreviewUrl: `https://expo.dev/simulator-preview/${PREVIEW_ID}#token=${PREVIEW_TOKEN}`,
    previewApiUrl: `https://web-preview-${PREVIEW_ID}.eas-simulator.ngrok.dev/?token=${PREVIEW_TOKEN}` });
  const result = await runCiMap(f.options);
  assert.ok(f.requests.find(request => request.args[0] === 'simulator:start').args.includes('--public-link'));
  assert.equal(result.simulatorRuntime.osVersion, '26.5');
  assert.deepEqual(f.catalogRequests.map(request => request.url), [`https://web-preview-${PREVIEW_ID}.eas-simulator.ngrok.dev/grid/api?limit=1000`]);
});

test('a preview token in the expo.dev page fragment reaches the framed preview server', async t => {
  const f = await fixture(t, { webPreviewUrl: `https://expo.dev/simulator-preview/${PREVIEW_ID}#token=${PREVIEW_TOKEN}` });
  const result = await runCiMap(f.options);
  assert.equal(result.simulatorRuntime.osVersion, '26.5');
  assert.equal(f.catalogRequests.length, 1);
});

test('a private session publishes no preview token, so the OS version is unknown and capture goes on', async t => {
  const f = await fixture(t, { webPreviewUrl: `https://expo.dev/simulator-preview/${PREVIEW_ID}` });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.ok(f.catalogRequests.every(request => request.authorization === null), 'no credential is invented');
});

test('an unrecognized preview URL is not sent the preview token', async t => {
  const f = await fixture(t, { webPreviewUrl: `https://preview.example/session?token=${PREVIEW_TOKEN}` });
  const result = await runCiMap(f.options);
  assert.equal(result.simulatorRuntime.osVersion, 'unknown');
  assert.deepEqual(f.catalogRequests, []);
});

test('an unreadable simulator catalog records the iOS version as unknown and still captures', async t => {
  const f = await fixture(t, { catalogFailure: true });
  const result = await runCiMap(f.options);
  assert.equal(result.simulatorRuntime.osVersion, 'unknown');
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.run.environment.osVersion, 'unknown');
});

test('one failed route preserves its placeholder and captures later routes', async t => {
  const f = await fixture(t, { openFailure: '/home' });
  const result = await runCiMap(f.options);
  assert.equal(result.runStatus, 'partial');
  assert.equal(result.outcomes[f.ids.home].status, 'failed');
  assert.equal(result.outcomes[f.ids.home].attempts, 2);
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
});

test('a route whose open loses the Android emulator for a moment is opened again once the device answers', async t => {
  const f = await fixture(t, { android: true, deviceLostOnOpen: '/home' });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured', JSON.stringify(result.outcomes[f.ids.home]));
  assert.equal(result.outcomes[f.ids.home].attempts, 2);
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  const retries = (await readFile(join(f.options.mapDirectory, 'capture-diagnostics', 'controller-retries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(retries.some(entry => entry.reason === 'route-reopened-after-device-lost' && /not found/.test(entry.fault)), JSON.stringify(retries));
});

test('iOS app-link confirmation is accepted once before fresh route evidence', async t => {
  const f = await fixture(t, { routes: [route('home')], marker: true, alertOnlyAt: '/home',
    deepLinkAlert: { message: 'Open in “Example”?', items: ['Cancel', 'Open'] } });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.home].landing, 'verified');
  assert.equal(f.requests.filter(request => request.args[0] === 'alert' && request.args[1] === 'accept').length, 1);
  assert.equal(f.requests.find(request => request.args[0] === 'alert' && request.args[1] === 'accept').timeoutMs, 15_000);
  const accepted = f.requests.findIndex(request => request.args[0] === 'alert' && request.args[1] === 'accept');
  const snapshot = f.requests.findIndex((request, index) => index > accepted && request.args[0] === 'snapshot');
  const screenshot = f.requests.findIndex(request => request.args[0] === 'screenshot');
  assert.ok(accepted < snapshot && snapshot < screenshot);
  assert.equal(f.operations().includes('press'), false);
});

test('setup actions that require a source route run only at revisions whose inventory has it', () => {
  const page = 'export default function Screen(){return null;}';
  const baseFiles = new Map([['app/index.tsx', page]]);
  const headFiles = new Map([...baseFiles, ['app/account.tsx', page]]);
  const plan = createSourceCapturePlan({ baseSha: SHA, headSha: HEAD, baseFiles, headFiles,
    changedFiles: [{ status: 'added', path: 'app/account.tsx' }], mode: 'all', provider: 'expo-router' });
  const setup = [{ action: 'open', url: 'sample://index' }, { action: 'open', url: 'sample://account', requiresRoute: '/account' }, { action: 'tap', label: 'Sign out', requiresRoute: '/account' }];
  assert.deepEqual(revisionSetup(setup, plan, 'head'), setup);
  assert.deepEqual(revisionSetup(setup, plan, 'base'), setup.slice(0, 1));
  // Any name the plan shows for the route selects it, so React Navigation screens work too.
  const account = plan.surfaces.find(row => row.headSurface?.route === '/account').headSurface;
  for (const name of [account.id, account.logicalPath, account.route]) {
    assert.equal(revisionSetup([{ action: 'tap', label: 'Sign out', requiresRoute: name }], plan, 'base').length, 0, name);
    assert.equal(revisionSetup([{ action: 'tap', label: 'Sign out', requiresRoute: name }], plan, 'head').length, 1, name);
  }
  assert.throws(() => revisionSetup([{ action: 'tap', label: 'Sign out', requiresRoute: '/acount' }], plan, 'head'),
    error => error instanceof CiError && error.code === 'SETUP_ROUTE_UNKNOWN');
});

test('capture controller arguments pass the installed pinned CLI parser without driving a device', async t => {
  const f = await fixture(t, { routes: [route('home')],
    deepLinkAlert: { message: 'Open in “Example”?', items: ['Cancel', 'Open'] } });
  await runCiMap({ ...f.options, setup: [{ action: 'tap', label: 'Get Started' }] });
  const checked = new Set();
  for (const request of f.requests.filter(request => request.command === 'fake-controller' && request.args[0] !== '--version')) {
    const key = request.args[0] === 'alert' ? request.args.slice(0, 2).join(' ') : request.args[0];
    if (checked.has(key)) continue;
    checked.add(key);
    // --help validates command/flag compatibility and exits before any daemon or device operation.
    const result = spawnSync(process.execPath, [new URL('../../node_modules/agent-device/bin/agent-device.mjs', import.meta.url).pathname, ...request.args, '--help'], {
      cwd: f.root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: f.root, CI: 'true' },
    });
    assert.equal(result.status, 0, `${key}: ${result.stdout || result.stderr}`);
  }
  assert.ok(checked.has('alert accept'));
  assert.ok(checked.has('press'));
  assert.ok(checked.has('screenshot'));
});

test('a screen that keeps changing is recaptured instead of published', async t => {
  // The fixture's second snapshot exposes one element more than the first.
  const f = await fixture(t, { routes: [route('home')], unsettled: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'failed');
  assert.equal(result.outcomes[f.ids.home].error.code, 'CAPTURE_NOT_SETTLED');
  assert.equal(result.outcomes[f.ids.home].attempts, 2, 'an unsettled screen is retried before it fails');
  assert.equal(f.operations().includes('screenshot'), true);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.images, {}, 'nothing from an unsettled screen becomes evidence');
});

test('every app link settles before the screen is read', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  await runCiMap(f.options);
  const opened = f.requests.findIndex(request => request.args[0] === 'open' && request.args[2]?.startsWith('sample://home'));
  const settled = f.requests.findIndex((request, index) => index > opened
    && request.args[0] === 'wait' && request.args[1] === 'stable');
  const read = f.requests.findIndex((request, index) => index > opened && request.args[0] === 'snapshot');
  assert.ok(opened >= 0 && settled > opened && settled < read, 'the settle runs between the link and the first read');
});

test('an application Open button is never an implicit confirmation action', async t => {
  const f = await fixture(t, { routes: [route('home')], appOpenButton: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(f.requests.some(request => request.args[0] === 'alert' && request.args[1] === 'accept'), false);
  assert.equal(f.operations().includes('press'), false);
});

test('a form sheet that the controller reports as an alert is captured as the screen', async t => {
  const f = await fixture(t, { routes: [route('home')], formSheetPopup: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(f.requests.some(request => request.args[0] === 'alert' && request.args[1] === 'accept'), false);
});

test('foreign app confirmations and other alerts remain unresolved capture gaps', async t => {
  for (const deepLinkAlert of [
    { message: 'Open in “Another App”?', items: ['Cancel', 'Open'] },
    { message: 'Allow notifications?', items: ['Cancel', 'Allow'] },
    { message: 'Open in “Example”?', items: ['Cancel', 'Open', 'Delete'] },
  ]) {
    const f = await fixture(t, { routes: [route('home')], deepLinkAlert });
    const result = await runCiMap(f.options);
    const error = result.outcomes[f.ids.home].error;
    assert.equal(error.code, 'CAPTURE_BLOCKED_BY_ALERT');
    // The alert's own text and buttons tell the author which setup tap dismisses it.
    assert.deepEqual(error.details.alert, deepLinkAlert);
    assert.ok(error.message.includes(JSON.stringify(deepLinkAlert.message)));
    assert.ok(error.nextAction.includes('setup tap'));
    assert.equal(f.requests.some(request => request.args[0] === 'alert' && request.args[1] === 'accept'), false);
    assert.equal(f.operations().includes('screenshot'), false);
  }
});

test('an alert left open by the last setup step is a setup failure that names the alert', async t => {
  const deepLinkAlert = { message: 'App rating is disabled in this local test build.', items: ['OK'] };
  const f = await fixture(t, { routes: [route('home')], deepLinkAlert, alertOnlyAt: '/setup' });
  const result = await runCiMap({ ...f.options, setup: [{ action: 'open', url: 'sample://setup' }] });
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(result.runStatus, 'partial');
  assert.deepEqual(bundle.images, {});
  const outcome = bundle.outcomes[f.ids.home];
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'CAPTURE_BLOCKED_BY_ALERT');
  assert.equal(outcome.error.stage, 'capture');
  assert.deepEqual(outcome.error.details.alert, deepLinkAlert);
  assert.ok(outcome.error.message.includes('"OK"'));
  assert.equal(outcome.error.details.diagnostics.screenshot, 'capture-diagnostics/setup-screen.png');
  // No app link was opened while the alert covered the app.
  assert.equal(f.requests.filter(request => request.args[0] === 'open' && request.args[2] === 'sample://home').length, 0);
});

test('undismissed app-link confirmations never produce route screenshots', async t => {
  for (const settings of [{ confirmationKeepsAlert: true }, { confirmationFails: true }]) {
    const f = await fixture(t, { routes: [route('home')], ...settings,
      deepLinkAlert: { message: 'Open in “Example”?', items: ['Cancel', 'Open'] } });
    const result = await runCiMap(f.options);
    assert.equal(result.outcomes[f.ids.home].error.code, 'DEEP_LINK_CONFIRMATION_FAILED');
    assert.equal(result.outcomes[f.ids.home].attempts, 1);
    assert.equal(f.requests.filter(request => request.args[0] === 'alert' && request.args[1] === 'accept').length, 1);
    assert.equal(f.operations().includes('screenshot'), false);
  }
});

test('alert inspection errors and late alerts cannot become successful evidence', async t => {
  for (const settings of [{ alertProbeFailure: true }, { alertAfterScreenshot: true }]) {
    const f = await fixture(t, { routes: [route('home')], ...settings });
    const result = await runCiMap(f.options);
    assert.equal(result.outcomes[f.ids.home].status, 'failed');
    assert.equal(result.outcomes[f.ids.home].error.code, settings.alertProbeFailure ? 'ALERT_INSPECTION_FAILED' : 'CAPTURE_BLOCKED_BY_ALERT');
    const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
    assert.deepEqual(bundle.images, {});
  }
});

test('confirmation dismissal respects mutation budgets and does not bypass route verification', async t => {
  const settings = { routes: [route('home')], marker: true, alertOnlyAt: '/home', deepLinkAlert: { message: 'Open in “Example”?', items: ['Cancel', 'Open'] } };
  const budget = await fixture(t, settings);
  const exhausted = await runCiMap({ ...budget.options, maxActions: 1 });
  assert.equal(exhausted.outcomes[budget.ids.home].status, 'budget-exhausted');
  assert.equal(budget.requests.some(request => request.args[0] === 'alert' && request.args[1] === 'accept'), false);
  const mismatch = await fixture(t, { ...settings, markerMismatch: true });
  const wrongRoute = await runCiMap(mismatch.options);
  // The confirmation is answered, the landing still does not match: the frame is unattributed, never verified.
  assert.equal(wrongRoute.outcomes[mismatch.ids.home].landing, 'unverified');
  assert.equal(wrongRoute.outcomes[mismatch.ids.home].observed.reason, 'landing-mismatch');
  assert.ok(mismatch.requests.some(request => request.args[0] === 'alert' && request.args[1] === 'accept'));
});

test('setup deep links resolve only Open confirmations and preserve explicit permission steps', async t => {
  for (const [deepLinkAlert, setup] of [
    [{ message: 'Open in “Example”?', items: ['Cancel', 'Open'] }, [{ action: 'open', url: 'sample://setup' }]],
    [{ message: 'Allow notifications?', items: ['Cancel', 'Allow'] }, [{ action: 'open', url: 'sample://setup' }, { action: 'tap', label: 'Allow' }]],
  ]) {
    const f = await fixture(t, { routes: [route('home')], deepLinkAlert, alertOnlyAt: '/setup' });
    const result = await runCiMap({ ...f.options, setup });
    assert.equal(result.outcomes[f.ids.home].status, 'captured');
    const accepted = f.requests.filter(request => request.args[0] === 'alert' && request.args[1] === 'accept');
    assert.equal(accepted.length, setup.length === 1 ? 1 : 0);
    assert.equal(f.requests.filter(request => request.args[0] === 'press').length, setup.length === 1 ? 0 : 1);
  }
});

test('one technical retry produces one successful observation', async t => {
  const f = await fixture(t, { routes: [route('home')], firstScreenshotFails: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.home].attempts, 2);
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.observations.length, 1);
});

test('dynamic targets without parameters do not allocate a simulator or disappear', async t => {
  const f = await fixture(t, { routes: [route('detail', null)] });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.detail].status, 'missing-params');
  assert.equal(result.easBuildId, null);
  assert.equal(f.requests.some(request => request.command === 'fake-eas'), false);
});

test('missing scheme is explicit and incurs no build or session allocation', async t => {
  const f = await fixture(t, { noScheme: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'unsupported-link');
  assert.equal(f.operations().includes('build'), false);
  assert.equal(f.operations().includes('simulator:start'), false);
});

test('automatic route observer verifies destinations and mismatches cannot produce evidence', async t => {
  const f = await fixture(t, { marker: true });
  assert.equal((await runCiMap(f.options)).outcomes[f.ids.home].landing, 'verified');
  // A wrong landing is published as unattributed evidence: the frame of what the app showed, never a verified route.
  const mismatch = await fixture(t, { marker: true, markerMismatch: true });
  const result = await runCiMap(mismatch.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.home].landing, 'unverified');
  assert.deepEqual(result.outcomes[f.ids.home].observed, { reason: 'landing-mismatch', route: '/different', attempts: 2 });
  assert.match(result.outcomes[f.ids.home].reason, /^Expected \/home; the app showed \/different on both attempts\./);
  assert.equal(result.outcomes[f.ids.home].error, undefined);
  const bundle = JSON.parse(await readFile(join(mismatch.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.images[f.ids.home].sha256, result.outcomes[f.ids.home].screenshotSha256);
  assert.equal(bundle.outcomes[f.ids.home].observed.reason, 'landing-mismatch');
  // capture.unattributed: discard keeps the former behaviour: the route fails and no frame is taken.
  const discard = await fixture(t, { marker: true, markerMismatch: true });
  const discarded = await runCiMap({ ...discard.options, unattributed: 'discard' });
  assert.equal(discarded.outcomes[f.ids.home].status, 'failed');
  assert.equal(discarded.outcomes[f.ids.home].error.code, 'ROUTE_LANDING_MISMATCH');
  assert.equal(discard.operations().includes('screenshot'), false);
});

test('an observer that answered earlier in the session and reports nothing is not ready: the frame is unattributed, a never-seen observer is missing', async t => {
  const f = await fixture(t, { missingObserverAt: '/settings' });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].landing, 'verified');
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].landing, 'unverified');
  assert.deepEqual(result.outcomes[f.ids.settings].observed, { reason: 'observer-not-ready', attempts: 2 });
  const misses = (await readFile(join(f.options.mapDirectory, 'capture-diagnostics', 'destination-misses.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual([...new Set(misses.map(miss => miss.code))], ['CAPTURE_OBSERVER_NOT_READY']);
  const never = await fixture(t, { routes: [route('settings')], missingObserverAt: '/settings' });
  const neverSeen = await runCiMap(never.options);
  assert.equal(neverSeen.outcomes[never.ids.settings].status, 'failed');
  assert.equal(neverSeen.outcomes[never.ids.settings].error.code, 'CAPTURE_OBSERVER_MISSING');
  assert.equal(never.operations().includes('screenshot'), false);
});

test('a wrong landing in the dark pass only is filed under <route>@dark as an unattributed frame next to the verified light one', async t => {
  const f = await fixture(t, { userInterfaceStyle: 'automatic', markerMismatchAt: { path: '/settings', scheme: 'dark' } });
  const result = await runCiMap(f.options);
  const dark = `${f.ids.settings}@dark`;
  assert.equal(result.outcomes[f.ids.settings].landing, 'verified');
  assert.equal(result.outcomes[dark].status, 'captured');
  assert.equal(result.outcomes[dark].landing, 'unverified');
  assert.equal(result.outcomes[dark].observed.reason, 'landing-mismatch');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.images[dark].sha256, result.outcomes[dark].screenshotSha256);
  assert.equal(bundle.outcomes[dark].observed.route, '/different');
  const read = await readCaptureBundle(f.options.outputDirectory);
  assert.equal(read.outcomes[dark].landing, 'unverified');
  assert.equal(hasVerifiedCapture(read, dark), false);
  assert.equal(hasVerifiedCapture(read, f.ids.settings), true);
});

test('a route the light pass lost in setup is published from its verified dark frame, light unavailable', async t => {
  const f = await fixture(t, { userInterfaceStyle: 'automatic', setupButtonMissingIn: 'light' });
  const result = await runCiMap({ ...f.options, setup: [{ action: 'tap', label: 'Get Started' }] });
  const dark = `${f.ids.settings}@dark`;
  assert.equal(result.outcomes[f.ids.settings].status, 'failed');
  assert.equal(result.outcomes[f.ids.settings].error.code, 'SETUP_CONTROL_NOT_READY');
  assert.equal(result.outcomes[dark].status, 'captured');
  assert.equal(result.outcomes[dark].landing, 'verified');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.images[dark].sha256, result.outcomes[dark].screenshotSha256);
  assert.equal(bundle.images[f.ids.settings], undefined);
  const read = await readCaptureBundle(f.options.outputDirectory);
  assert.equal(hasVerifiedCapture(read, dark), true);
  assert.equal(hasVerifiedCapture(read, f.ids.settings), false);
});

test('missing, invalid, or ambiguous automatic observers never produce successful screenshots', async t => {
  for (const [settings, code] of [
    [{ missingObserver: true }, 'CAPTURE_OBSERVER_MISSING'],
    [{ invalidObserver: true }, 'CAPTURE_OBSERVER_INVALID'],
    [{ duplicateObserver: true }, 'CAPTURE_OBSERVER_AMBIGUOUS'],
  ]) {
    const f = await fixture(t, { routes: [route('home')], ...settings });
    const result = await runCiMap(f.options);
    assert.equal(result.outcomes[f.ids.home].status, 'failed');
    assert.equal(result.outcomes[f.ids.home].error.code, code);
    assert.equal(f.operations().includes('screenshot'), false);
    assert.deepEqual(JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8')).images, {});
    assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
  }
});

test('identical observer copies from the host AX bridge count as one marker', async t => {
  const f = await fixture(t, { routes: [route('home')], bridgeObserverCopy: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.home].landing, 'verified');
});

test('a device mismatch and a failed start still stop the exact verified session', async t => {
  for (const settings of [{ deviceMismatch: true }, { startFailure: true }]) {
    const f = await fixture(t, settings);
    await assert.rejects(runCiMap(f.options));
    assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
  }
});

test('unverified foreign sessions are never stopped by guessing ownership', async t => {
  const f = await fixture(t, { wrongProject: true });
  await assert.rejects(runCiMap(f.options));
  assert.equal(f.operations().includes('simulator:stop'), false);
  const sessionRoot = f.requests.find(request => request.args[0] === 'simulator:start').cwd;
  await rm(sessionRoot, { recursive: true, force: true });
});

test('availability and clean-source checks happen before any paid allocation', async t => {
  for (const [settings, code] of [[{ available: false }, 'SIMULATOR_UNAVAILABLE'], [{ dirty: true }, 'SOURCE_CHECKOUT_CHANGED'], [{ simulator: false }, 'EAS_PROFILE_NOT_SIMULATOR']]) {
    const f = await fixture(t, settings);
    await assert.rejects(runCiMap(f.options), error => error.code === code);
    assert.equal(f.operations().includes('build'), false);
    assert.equal(f.operations().includes('simulator:start'), false);
  }
});

test('budgets preserve the entire target outcome inventory', async t => {
  const f = await fixture(t);
  const result = await runCiMap({ ...f.options, maxScreens: 1 });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'budget-exhausted');
});

test('every route link starts from the root link, so a sheet left by the previous route cannot swallow it', async t => {
  const f = await fixture(t, { routes: [route('home'), route('modal'), route('settings')], presentedUntilRoot: '/modal' });
  const result = await runCiMap(f.options);
  for (const id of [f.ids.home, f.ids.modal, f.ids.settings]) assert.equal(result.outcomes[id].status, 'captured', id);
  assert.equal(result.outcomes[f.ids.settings].attempts, 1);
  const links = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'open').map(request => request.args[2]);
  assert.deepEqual(links.filter(link => link?.startsWith('sample://')), ['sample://', 'sample://home', 'sample://', 'sample://modal', 'sample://', 'sample://settings']);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.procedure.reset, 'root-link');
});

test('a route costs no more controller calls than it needs: the reset is an open and a settle, and no appstate follows the screenshot', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')], userInterfaceStyle: 'light' });
  assert.equal((await runCiMap(f.options)).runStatus, 'complete');
  const calls = f.requests.filter(request => request.command === 'fake-controller').map(request => [request.args[0], request.args[2]]);
  for (const [index, [command, link]] of calls.entries()) {
    // The route's own link waits for the root link to finish closing what the last route left (a sheet still being
    // dismissed can stop the next one presenting); its readiness poll then checks where it landed.
    if (command === 'open' && link === 'sample://') {
      const [[next, nextArg], [after, afterLink]] = [calls[index + 1], calls[index + 2]];
      assert.ok(next === 'wait' && nextArg === '500' && after === 'open' && afterLink?.startsWith('sample://') && afterLink !== 'sample://', JSON.stringify(calls.slice(index, index + 3)));
    }
    // The snapshot after the screenshot also proves which app is in front.
    if (command === 'screenshot') assert.equal(calls[index + 1][0], 'snapshot');
  }
  assert.ok(calls.filter(([command, link]) => command === 'open' && link === 'sample://').length >= 2);
});

test('capture.reset: none keeps today\'s sequencing, and a sheet left behind makes the next route land elsewhere (unattributed)', async t => {
  const f = await fixture(t, { routes: [route('home'), route('modal'), route('settings')], presentedUntilRoot: '/modal' });
  const result = await runCiMap({ ...f.options, reset: 'none' });
  assert.equal(result.outcomes[f.ids.modal].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].landing, 'unverified');
  assert.equal(result.outcomes[f.ids.settings].observed.reason, 'landing-mismatch');
  assert.equal(result.outcomes[f.ids.settings].attempts, 2);
  const links = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'open').map(request => request.args[2]);
  assert.equal(links.includes('sample://'), false);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.procedure.reset, 'none');
});

test('the reset does not spend the action budget: two routes fit in two actions', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')] });
  const result = await runCiMap({ ...f.options, maxActions: 2 });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  const links = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'open').map(request => request.args[2]);
  assert.equal(links.filter(link => link === 'sample://').length, 2);
});

test('a confirmation raised by the root link is answered before the route link is opened', async t => {
  const f = await fixture(t, { routes: [route('home'), route('settings')], deepLinkAlert: { message: 'Open in “Example”?', items: ['Cancel', 'Open'] }, alertOnlyAt: '/' });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  const ops = f.operations();
  const firstRoute = ops.indexOf('open', ops.indexOf('open') + 1);
  assert.ok(ops.slice(0, firstRoute).includes('alert'), 'the reset accepted the confirmation before the route link');
});

test('read-only evidence can finish at the exact mutation action budget', async t => {
  const f = await fixture(t);
  const result = await runCiMap({ ...f.options, maxActions: 1 });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'budget-exhausted');
});

test('setup failures publish per-route diagnostics and stop the allocated session', async t => {
  const f = await fixture(t);
  const result = await runCiMap({ ...f.options, setup: [{ action: 'open', url: 'https://foreign.example/login' }] });
  assert.equal(result.outcomes[f.ids.home].status, 'failed');
  assert.equal(result.outcomes[f.ids.home].attempts, 0);
  assert.equal(result.outcomes[f.ids.home].error.code, 'SETUP_LINK_OUTSIDE_APP');
  assert.equal(result.outcomes[f.ids.settings].status, 'failed');
  assert.equal(f.requests.some(request => request.args[0] === 'screenshot' && !request.args[1].includes('/capture-diagnostics/')), false);
  assert.deepEqual(JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8')).images, {});
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('a setup step killed by a transient controller fault runs again after the app is relaunched, once', async t => {
  // euxy #156, Android base: adb dropped for ~30 s during setup step 2; the whole light pass was lost.
  for (const faults of [1, 2]) {
    const f = await fixture(t, { routes: [route('home'), route('transient')], statefulSetup: true });
    let presses = 0;
    const lines = [];
    const result = await runCiMap({ ...f.options, progress: line => lines.push(line), setup: reachTransient, runner: request => {
      if (request.command === 'fake-controller' && request.args[0] === 'press' && ++presses <= faults) return adbOffline();
      return f.options.runner(request);
    } });
    const relaunches = f.requests.filter(request => request.args[0] === 'open' && request.args.includes('--relaunch')).length;
    const retries = (await readFile(join(f.options.mapDirectory, 'capture-diagnostics', 'controller-retries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(retries.some(entry => entry.reason === 'setup-rerun-after-controller-fault' && /device offline/.test(entry.fault)));
    assert.equal(relaunches, 1);
    if (faults === 1) {
      assert.equal(result.outcomes[f.ids.transient].status, 'captured', 'the rerun setup prepared the route');
      assert.equal(result.outcomes[f.ids.home].status, 'captured');
      assert.ok(lines.some(line => /setup interrupted by the device controller .*adb: device offline.*running setup again/.test(line)));
    } else {
      assert.equal(result.outcomes[f.ids.transient].status, 'failed');
      assert.match(result.outcomes[f.ids.transient].error.message, /adb: device offline/);
    }
  }
});

test('setup readiness failures redact snapshots and withhold diagnostic images containing visible secrets', async t => {
  const f = await fixture(t, { snapshotSecret: `Bearer ${DAEMON_TOKEN} expo-private` });
  const result = await runCiMap({ ...f.options, setup: [
    { action: 'tap', label: 'Get Started', ready: { identifier: 'missing-next-screen' } },
  ] });
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(result.runStatus, 'partial');
  assert.deepEqual(bundle.images, {});
  assert.deepEqual(map.observations, []);
  assert.deepEqual(map.artifacts, []);
  for (const outcome of Object.values(bundle.outcomes)) {
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.landing, 'unverified');
    assert.equal(outcome.screenshotSha256, undefined);
    assert.equal(outcome.error.code, 'SETUP_READINESS_TIMEOUT');
    assert.equal(outcome.error.stage, 'setup');
    assert.equal(outcome.error.details.index, 0);
    assert.equal(outcome.error.details.selector.value, 'missing-next-screen');
    assert.equal(outcome.error.details.diagnostics.accessibility, 'capture-diagnostics/setup-accessibility.json');
    assert.equal(outcome.error.details.diagnostics.screenshot, undefined);
    assert.match(outcome.error.details.diagnostics.captureError, /sensitive input/i);
  }
  const diagnostic = bundle.outcomes[f.ids.home].error.details.diagnostics;
  const snapshotBytes = await readFile(join(f.options.outputDirectory, diagnostic.accessibility));
  assert.deepEqual(snapshotBytes, await readFile(join(f.options.mapDirectory, diagnostic.accessibility)));
  const text = snapshotBytes.toString('utf8');
  assert.equal(text.includes(DAEMON_TOKEN), false);
  assert.equal(text.includes('expo-private'), false);
  assert.match(text, /\[REDACTED\]/);
  const snapshot = JSON.parse(text);
  assert.equal(snapshot.data.refsGeneration, f.requests.filter(request => request.args[0] === 'snapshot').length - 1,
    'retain the final readiness snapshot, not the initial screen');
  assert.equal(f.requests.some(request => request.args[0] === 'screenshot'), false);
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('a missing diagnostic screenshot preserves the original setup failure and its accessibility diagnostic', async t => {
  const f = await fixture(t, { firstScreenshotFails: true });
  const result = await runCiMap({ ...f.options, setup: [
    { action: 'tap', label: 'Get Started', ready: { identifier: 'missing-next-screen' } },
  ] });
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(result.runStatus, 'partial');
  assert.deepEqual(bundle.images, {});
  const outcome = bundle.outcomes[f.ids.home];
  assert.equal(outcome.error.code, 'SETUP_READINESS_TIMEOUT');
  assert.equal(outcome.error.stage, 'setup');
  assert.equal(outcome.error.details.index, 0);
  assert.equal(outcome.error.details.diagnostics.screenshot, undefined);
  assert.equal(outcome.error.details.diagnostics.accessibility, 'capture-diagnostics/setup-accessibility.json');
  assert.match(outcome.error.details.diagnostics.captureError, /temporary screenshot transport error/);
  const diagnostic = JSON.parse(await readFile(join(f.options.outputDirectory, outcome.error.details.diagnostics.accessibility), 'utf8'));
  assert.ok(diagnostic.data.nodes.length > 0);
  for (const directory of [f.options.mapDirectory, f.options.outputDirectory]) {
    await assert.rejects(readFile(join(directory, 'capture-diagnostics/setup-screen.png')), { code: 'ENOENT' });
  }
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.deepEqual(map.observations, []);
  assert.deepEqual(map.artifacts, []);
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('UI setup captures a transient destination before later navigation clears its prerequisites', async t => {
  const f = await fixture(t, { statefulSetup: true, routes: [route('home'), route('transient')] });
  const result = await runCiMap({ ...f.options, setup: [
    { action: 'fill', label: 'Name', text: 'Mochi' },
    { action: 'scroll', direction: 'bottom' },
    { action: 'tap', label: 'Continue' },
    { action: 'tap', label: 'Finish' },
  ] });
  assert.equal(result.outcomes[f.ids.transient].status, 'captured');
  assert.equal(result.outcomes[f.ids.transient].landing, 'verified');
  assert.equal(result.outcomes[f.ids.home].landing, 'verified');
  const screenshot = f.requests.findIndex(request => request.args[0] === 'screenshot');
  const finish = f.requests.findIndex(request => request.args[0] === 'press' && request.args[1].startsWith('@e103~'));
  assert.ok(screenshot >= 0 && screenshot < finish, 'the screenshot is taken while the transient state still exists');
  assert.equal(f.requests.some(request => request.args.includes('--relaunch')), false);
  assert.equal(f.requests.some(request => request.args.includes('sample://transient')), false, 'already observed transient targets are not reopened after state disappears');
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.observations.filter(observation => observation.screenId === f.ids.transient).length, 1);
});

test('progress names each setup step, route, and outcome, but never the text setup enters', async t => {
  const f = await fixture(t, { statefulSetup: true, routes: [route('home'), route('transient'), route('settings')] });
  const lines = [];
  await runCiMap({ ...f.options, progress: line => lines.push(line), setup: [
    { action: 'fill', label: 'Name', text: 'Mochi' },
    { action: 'scroll', direction: 'bottom' },
    { action: 'tap', label: 'Continue' },
    { action: 'tap', label: 'Finish' },
  ] });
  const text = lines.join('\n');
  for (const expected of [/3 routes selected, 3 to capture/, /setup 1\/4: fill label "Name"$/m, /setup 4\/4: tap label "Finish"$/m,
    /\/transient: captured after setup step 3$/m, /\/home: captured after setup step 4$/m,
    /route 1\/1 \/settings: opening by app link$/m, /\/settings: captured by app link$/m, /3 of 3 routes captured/]) {
    assert.match(text, expected);
  }
  assert.ok(lines.every(line => /^(?:head|base) [0-9a-f]{8}: /.test(line)), text);
  assert.equal(text.includes('Mochi'), false);
});

const reachTransient = [
  { action: 'fill', label: 'Name', text: 'Mochi' },
  { action: 'scroll', direction: 'bottom' },
  { action: 'tap', label: 'Continue', ready: { label: 'Finish' } },
];
const continuePresses = f => f.requests.filter(request => request.args[0] === 'press' && request.args[1].startsWith('@e102~')).length;
const openedLink = (f, link) => f.requests.some(request => request.args[0] === 'open' && request.args.includes(link));

test('a transient capture failure on a prepared target is retried in place with fresh observations', async t => {
  const f = await fixture(t, { statefulSetup: true, screenshotFailures: 1, routes: [route('home'), route('transient')] });
  const result = await runCiMap({ ...f.options, setup: [...reachTransient, { action: 'tap', label: 'Finish' }] });
  assert.equal(result.outcomes[f.ids.transient].status, 'captured');
  assert.equal(result.outcomes[f.ids.transient].landing, 'verified');
  assert.equal(result.outcomes[f.ids.transient].attempts, 2);
  const screenshots = f.requests.flatMap((request, index) => request.args[0] === 'screenshot' ? [index] : []);
  const between = f.requests.slice(screenshots[0] + 1, screenshots[1]).map(request => request.args.slice(0, 2).join(' '));
  assert.ok(between.includes('wait stable') && between.includes('snapshot --force-full'), 'the retry settles and reads the screen again');
  assert.equal(continuePresses(f), 1, 'the setup action that prepared the state is not submitted again');
  assert.equal(openedLink(f, 'sample://transient'), false);
});

test('an unresolved prepared-state capture keeps its original failure instead of a default app link', async t => {
  const f = await fixture(t, { statefulSetup: true, screenshotFailures: 2, routes: [route('home'), route('transient'), route('settings')] });
  const result = await runCiMap({ ...f.options, setup: [...reachTransient, { action: 'tap', label: 'Finish' }] });
  const outcome = result.outcomes[f.ids.transient];
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.error.code, 'ROUTE_CAPTURE_FAILED');
  assert.equal(outcome.error.message, 'temporary screenshot transport error');
  assert.equal(openedLink(f, 'sample://transient'), false, 'a bare app link never replaces the prepared state');
  assert.equal(continuePresses(f), 1);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.outcomes[f.ids.settings].status, 'captured', 'targets that setup never reached keep their app-link capture');
  assert.equal(openedLink(f, 'sample://settings'), true);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.outcomes[f.ids.transient], outcome, 'the original failure survives export');
  assert.throws(() => assertCompleteCaptures([{ bundle, selectedIds: Object.values(f.ids) }]), error => {
    assert.equal(error.code, 'CAPTURE_INCOMPLETE');
    assert.deepEqual(error.details.issues.map(issue => issue.surfaceId), [f.ids.transient]);
    return true;
  });
});

test('a retry that no longer satisfies setup readiness keeps the first capture failure', async t => {
  const f = await fixture(t, { statefulSetup: true, screenshotFailures: 1, preparedStateLost: true, routes: [route('home'), route('transient')] });
  const result = await runCiMap({ ...f.options, setup: reachTransient });
  const outcome = result.outcomes[f.ids.transient];
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.error.message, 'temporary screenshot transport error');
  assert.equal(f.operations().filter(operation => operation === 'screenshot').length, 2, 'only the failed attempt and the ordinary home target take screenshots');
  assert.equal(continuePresses(f), 1);
  assert.equal(openedLink(f, 'sample://transient'), false);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
});

test('a later setup action can recover a prepared target with new readiness evidence', async t => {
  const f = await fixture(t, { statefulSetup: true, screenshotFailures: 2, routes: [route('home'), route('transient')] });
  const result = await runCiMap({ ...f.options, setup: [...reachTransient,
    { action: 'wait', milliseconds: 1, ready: { label: 'Finish' } },
    { action: 'tap', label: 'Finish' },
  ] });
  assert.equal(result.outcomes[f.ids.transient].status, 'captured');
  assert.equal(result.outcomes[f.ids.transient].landing, 'verified');
  assert.equal(continuePresses(f), 1);
  assert.equal(openedLink(f, 'sample://transient'), false);
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.observations.filter(observation => observation.screenId === f.ids.transient).length, 1);
});

test('UI filling and scrolling both consume the capture action budget', async t => {
  const f = await fixture(t, { repack: 'local', statefulSetup: true, routes: [route('home'), route('transient')] });
  const result = await runCiMap({ ...f.options, maxActions: 2, setup: [
    { action: 'fill', label: 'Name', text: 'Mochi' },
    { action: 'scroll', direction: 'bottom' },
    { action: 'tap', label: 'Continue' },
  ] });
  assert.equal(f.operations().filter(operation => operation === 'fill').length, 1);
  assert.equal(f.operations().filter(operation => operation === 'scroll').length, 1);
  assert.equal(f.operations().includes('press'), false);
  assert.equal(f.requests.some(request => request.args[0] === 'screenshot' && !request.args[1].includes('/capture-diagnostics/')), false);
  assert.deepEqual(JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8')).images, {});
  assert.ok(Object.values(result.outcomes).every(outcome => outcome.error?.code === 'CAPTURE_BUDGET_EXHAUSTED'));
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('fresh and reusable native builds are repacked on EAS from a staged copy with the automatic observer', async t => {
  for (const reuse of [false, true]) {
    const f = await fixture(t, { reuse, buildMetadata: true });
    const result = await runCiMap(f.options);
    assert.equal(result.reusedEasBuild, reuse);
    assert.equal(result.easBuildId, 'repacked-app');
    // The app config declares neither, so the PR comment reads them from the EAS build either way.
    assert.equal(result.app.version, '2.1.0');
    assert.equal(result.app.buildNumber, '42');
    assert.equal(f.operations().includes('workflow:run'), true);
    assert.equal(f.operations().includes('upload'), false);
    // The session starts empty while the job repacks; the repacked app is downloaded and installed through the controller.
    const start = f.requests.find(request => request.args[0] === 'simulator:start');
    assert.equal(start.args.includes('--build-id'), false);
    assert.ok(f.requests.indexOf(start) < f.requests.findIndex(request => request.args[0] === 'workflow:run'), 'the session starts before the repack');
    assert.equal(f.operations().includes('build:download'), true);
    assert.equal(f.operations().filter(operation => operation === 'install').length, 1);
    assert.equal(f.operations().includes('build'), !reuse);
    assert.equal(f.requests.some(request => request.command === 'fake-repack'), false);
    const staged = f.requests.find(request => request.args[0] === 'workflow:run').cwd;
    assert.equal(existsSync(staged), false, 'the staged copy is removed after the run');
    assert.equal(existsSync(join(f.options.project, '.expo-explore-observer')), false);
    assert.equal(existsSync(join(f.options.project, '.eas/workflows/expo-explore-repack.yml')), false);
  }
});

test('a failed hosted repack job stops the capture as EAS_REPACK_FAILED with the workflow logs', async t => {
  const f = await fixture(t, { workflowFailure: true });
  await assert.rejects(runCiMap(f.options), error => error.code === 'EAS_REPACK_FAILED' && /Build step "Repack" failed/.test(error.message) && /workflows\/run-1/.test(error.nextAction));
  // The session started beside the repack, so it is stopped.
  assert.deepEqual(f.operations().filter(operation => operation.startsWith('simulator:')).filter(operation => operation !== 'simulator:availability'), ['simulator:start', 'simulator:stop']);
});

test('capture.repack: local repacks on the runner and installs the app from it, with no upload', async t => {
  for (const reuse of [false, true]) {
    const f = await fixture(t, { repack: 'local', reuse, buildMetadata: true });
    const result = await runCiMap(f.options);
    assert.equal(result.reusedEasBuild, reuse);
    assert.equal(result.easBuildId, null);
    assert.equal(f.operations().includes('upload'), false);
    assert.equal(f.operations().filter(operation => operation === 'install').length, 1);
    assert.equal(f.operations().includes('workflow:run'), false);
    assert.equal(f.operations().includes('build'), !reuse);
    assert.equal(f.requests.filter(request => request.command === 'fake-repack').length, 1);
  }
});

test('partial cached evidence captures only missing selected targets', async t => {
  const first = await fixture(t, { openFailure: '/settings' });
  const baseline = await runCiMap(first.options);
  assert.equal(baseline.outcomes[first.ids.home].status, 'captured');
  const f = await fixture(t);
  const result = await runCiMap({ ...f.options, reuseDirectory: first.options.outputDirectory });
  assert.equal(result.outcomes[f.ids.settings].status, 'captured');
  assert.equal(f.requests.filter(request => request.args[0] === 'open' && request.args.includes('sample://home')).length, 0);
  const before = JSON.parse(await readFile(join(first.options.outputDirectory, 'bundle.json'), 'utf8'));
  const after = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(after.images[f.ids.home], before.images[first.ids.home]);
});

test('a complete cache hit preserves original images without EAS allocation', async t => {
  const first = await fixture(t);
  await runCiMap(first.options);
  const f = await fixture(t);
  const result = await runCiMap({ ...f.options, reuseDirectory: first.options.outputDirectory });
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  assert.equal(result.simulatorSessionId, null);
  assert.equal(f.requests.some(request => request.command !== 'git'), false);
  const before = JSON.parse(await readFile(join(first.options.outputDirectory, 'bundle.json'), 'utf8'));
  const after = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(after.images, before.images);
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(after.completedAt, map.run.completedAt);
  assert.ok(Date.parse(after.completedAt) >= Date.parse(before.completedAt), 'cache reuse records this execution completion while retaining original frame times');
});

test('a complete cache hit of a light+dark baseline keeps its schemes, so its @dark frames stay expected evidence', async t => {
  const first = await fixture(t, { userInterfaceStyle: 'automatic' });
  await runCiMap(first.options);
  const f = await fixture(t, { userInterfaceStyle: 'automatic' });
  const result = await runCiMap({ ...f.options, reuseDirectory: first.options.outputDirectory });
  assert.equal(result.simulatorSessionId, null);
  const before = JSON.parse(await readFile(join(first.options.outputDirectory, 'bundle.json'), 'utf8'));
  const after = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(Object.keys(after.images).sort(), Object.keys(before.images).sort());
  assert.equal(after.runtimeProfile.colorSchemes, 'light,dark');
  assert.deepEqual(result.simulatorRuntime.colorSchemes, ['light', 'dark']);
  // The review validates the reused side exactly like a fresh one: every `<route>@dark` frame must be planned evidence.
  assertCompleteCaptures([{ bundle: after, selectedIds: after.selectedSurfaceIds }]);
});

test('unverified cached screenshots are recaptured without retaining their old observations', async t => {
  const first = await fixture(t);
  await runCiMap(first.options);
  const bundlePath = join(first.options.outputDirectory, 'bundle.json');
  const before = JSON.parse(await readFile(bundlePath, 'utf8'));
  before.outcomes[first.ids.home].landing = 'unverified';
  await writeFile(bundlePath, JSON.stringify(before));
  const f = await fixture(t);
  const result = await runCiMap({ ...f.options, reuseDirectory: first.options.outputDirectory });
  assert.equal(result.outcomes[f.ids.home].landing, 'verified');
  assert.equal(f.requests.filter(request => request.args.includes('sample://home')).length, 1);
  assert.equal(f.requests.filter(request => request.args.includes('sample://settings')).length, 0);
  const map = JSON.parse(await readFile(join(f.options.outputDirectory, 'screen-map.json'), 'utf8'));
  assert.equal(map.observations.filter(observation => observation.screenId === f.ids.home).length, 1, 'discarded unverified evidence must not become an extra comparison sample');
});

test('incomplete accessibility evidence cannot publish a successful capture', async t => {
  const f = await fixture(t, { truncated: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].error.code, 'INVALID_ACCESSIBILITY_EVIDENCE');
  assert.equal(result.outcomes[f.ids.home].attempts, 2);
  assert.equal(f.operations().includes('screenshot'), false);
});

test('setup reads again while a system prompt briefly returns an incomplete tree, and reports its shape if it persists', async t => {
  for (const persistent of [false, true]) {
    const f = await fixture(t, { routes: [route('home')] });
    let opened = false, incomplete = 0;
    const result = await runCiMap({ ...f.options, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
      const response = f.options.runner(request);
      if (request.command === 'fake-controller' && request.args[0] === 'open') opened = true;
      if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && opened && (persistent || incomplete < 2)) {
        incomplete += 1;
        const { truncated: _truncated, ...data } = JSON.parse(response.stdout).data;
        return ok(data);
      }
      return response;
    } });
    const waits = f.requests.filter(request => request.args[0] === 'wait' && request.args[1] === '1000').length;
    if (!persistent) {
      assert.equal(result.outcomes[f.ids.home].status, 'captured');
      assert.equal(waits, 2);
    } else {
      assert.equal(result.outcomes[f.ids.home].error.code, 'INVALID_ACCESSIBILITY_EVIDENCE');
      assert.equal(waits, 7);
      assert.deepEqual({ truncated: result.outcomes[f.ids.home].error.details.truncated }, { truncated: 'undefined' });
    }
  }
});

test('an exhausted EAS build plan is reported as EAS_PLAN_LIMIT_REACHED with the reset date', async t => {
  const f = await fixture(t, { workflowPlanLimit: true });
  await assert.rejects(runCiMap(f.options), error => {
    assert.equal(error.code, 'EAS_PLAN_LIMIT_REACHED');
    assert.match(error.message, /production_plus plan this month, which will reset in 13 days \(on Sat Oct 24 2026\)/);
    assert.doesNotMatch(error.message, /Request ID|GraphQL/);
    assert.match(error.nextAction, /monthly reset/);
    return true;
  });
});

test('cleanup failure retains its exact session diagnostic and original failure stage', async t => {
  const f = await fixture(t, { stopFailure: true, startFailure: true });
  await assert.rejects(runCiMap(f.options), error => {
    assert.equal(error.code, 'SESSION_CLEANUP_FAILED');
    assert.equal(error.details.sessionId, 'session-1');
    assert.equal(error.details.originalFailure.stage, 'session');
    return true;
  });
  const sessionRoot = f.requests.find(request => request.args[0] === 'simulator:start').cwd;
  await rm(sessionRoot, { recursive: true, force: true });
});

test('invalid screenshot bytes never enter a published map', async t => {
  const f = await fixture(t, { badPng: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].status, 'failed');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.images, {});
});

test('app links use source concrete paths and never fabricate dynamic values', () => {
  assert.equal(captureDeepLink('sample', route('home')), 'sample://home');
  assert.equal(captureDeepLink('sample', route('detail', null)), null);
  assert.equal(captureDeepLink('sample', route('detail', '/item/[id]')), null);
  assert.throws(() => captureDeepLink('https', route('home')));
});

test('agent explicitly captures representative states after setup and exports source-bound contexts and navigation trace', async t => {
  const f = await fixture(t);
  const calls = [];
  const agent = agentFixture([
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home screen.', requiredLabels: ['screen-title'] },
    { action: 'open', url: 'sample://settings' },
    { action: 'capture', targetId: f.ids.settings, description: 'Loaded settings screen.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ], calls);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }] });
  assert.equal(result.runStatus, 'complete');
  const first = JSON.parse(calls[0].messages[0].content[0].text);
  assert.deepEqual(first.completed, [], 'setup never auto-captures intermediate states in agent mode');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(Object.keys(bundle.captureContexts).sort(), Object.keys(bundle.images).sort());
  assert.equal(bundle.captureContexts[f.ids.home].description, 'Loaded home screen.');
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.filter(event => event.action !== 'observe').map(event => event.action), ['capture', 'open', 'capture', 'done']);
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('agent navigates using lightweight action observations and only requests representative image candidates', async t => {
  const f = await fixture(t);
  const agent = agentFixture([]);
  agent.provider.run = async request => {
    const call = async (name, input = {}) => {
      const response = await request.callTool(name, input, request.signal);
      return { response, value: JSON.parse(response.content[0].text) };
    };
    const screenshotCount = () => f.operations().filter(operation => operation === 'screenshot').length;
    const first = await call('observe', { includeImage: false });
    assert.ok(first.value.observation.nodes.length);
    assert.equal(first.response.content.length, 1);
    assert.equal(screenshotCount(), 0);
    const expired = await call('observe', { includeImage: true });
    assert.equal(screenshotCount(), 1);
    await call('observe', { includeImage: false });
    assert.equal((await call('capture', { frameId: expired.value.frameId, targetId: f.ids.home })).value.error.code, 'AGENT_FRAME_UNAVAILABLE');
    const home = await call('observe', { includeImage: true });
    await call('capture', { frameId: home.value.frameId, targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] });
    assert.equal(screenshotCount(), 2);
    const tapped = await call('act', { action: 'tap', label: 'Get Started' });
    assert.equal(tapped.value.performed, 'tap', 'capture does not force another model observation before selecting a control');
    assert.equal(tapped.response.content.length, 1);
    const moved = await call('act', { action: 'open', url: 'sample://settings' });
    assert.equal(moved.value.currentTargets[0].id, f.ids.settings);
    assert.equal(moved.value.frameId, undefined);
    assert.equal(screenshotCount(), 2, 'neither action took a screenshot');
    const settings = await call('observe', { includeImage: true });
    await call('capture', { frameId: settings.value.frameId, targetId: f.ids.settings, description: 'Loaded settings.', requiredLabels: ['screen-title'] });
    await call('finish', { procedureSummary: 'Visited and inspected both intended screens.' });
    assert.equal(screenshotCount(), 3);
    return { inputTokens: 1, outputTokens: 1 };
  };
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }] });
  assert.equal(result.runStatus, 'complete');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(Object.keys(bundle.images).length, 2);
  for (const id of [f.ids.home, f.ids.settings]) {
    assert.equal(bundle.images[id].sha256, bundle.agentAcceptance.frames[id].imageSha256);
  }
});

test('agent reports completed native press separately from a failed trailing accessibility observation', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let pressed = false, postActionReads = 0;
  const agent = agentFixture([]);
  agent.provider.run = async request => {
    const call = async (name, input = {}) => JSON.parse((await request.callTool(name, input, request.signal)).content[0].text);
    await call('observe', { includeImage: false });
    const result = await call('act', { action: 'tap', label: 'Get Started' });
    assert.equal(result.performed, 'tap');
    assert.equal(result.error, undefined);
    assert.equal(result.observationError.code, 'INVALID_ACCESSIBILITY_EVIDENCE');
    assert.equal(postActionReads, 1, 'only the runtime owns the read after successful dispatch');
    assert.equal((await call('act', { action: 'tap', label: 'Get Started' })).error.code, 'AGENT_OBSERVATION_REQUIRED');
    const observed = await call('observe', { includeImage: true });
    await call('capture', { frameId: observed.frameId, targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] });
    await call('finish', { procedureSummary: 'Recovered observation without repeating the native press.' });
    return { inputTokens: 1, outputTokens: 1 };
  };
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'press') pressed = true;
    if (pressed && request.command === 'fake-controller' && request.args[0] === 'snapshot' && ++postActionReads === 1) {
      return ok({ ...JSON.parse(response.stdout).data, truncated: true });
    }
    return response;
  } });
  assert.equal(result.runStatus, 'complete');
  assert.equal(f.operations().filter(operation => operation === 'press').length, 1);
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace.find(event => event.result.performed === 'tap').result.observationError.code, 'INVALID_ACCESSIBILITY_EVIDENCE');
});

test('agent accepts the exact inspected frame when the app changes during its decision, without native alert probes', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  const calls = [];
  let changed = false, now = Date.now(), inspected;
  const alternate = PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4, 128) });
  const agent = agentFixture([
    state => { inspected = state; changed = true; now += 5000; return { action: 'capture', targetId: f.ids.home, description: 'Inspected loaded home.', requiredLabels: ['screen-title'] }; },
    { action: 'done' },
  ], calls);
  const result = await runCiMap({ ...f.options, now: () => now, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'alert') throw new Error('This slow native probe must not be required by agent mode.');
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'screenshot' && changed) writeFileSync(request.args[1], alternate);
    return response;
  } });
  assert.equal(result.runStatus, 'complete');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  const frame = bundle.images[f.ids.home], receipt = bundle.agentAcceptance.frames[f.ids.home];
  assert.equal(frame.sha256, inspected.imageSha256);
  assert.equal(frame.capturedAt, inspected.capturedAt);
  assert.equal(receipt.frameId, inspected.frameId);
  assert.deepEqual(await readFile(join(f.options.outputDirectory, frame.path)), png);
  assert.notEqual(frame.capturedAt, new Date(now).toISOString());
  assert.equal(f.operations().includes('alert'), false);
});

test('agent observes a non-Alert popup and dismisses it before accepting a clean frame', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let popup = true, blockedFrameId;
  const overlay = PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4, 90) });
  const agent = agentFixture([
    (state, request, content) => { blockedFrameId = state.frameId; assert.deepEqual(Buffer.from(content[1].data, 'base64'), overlay); return { action: 'tap', label: 'Not Now' }; },
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home without the system popup.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'alert') throw new Error('Do not query native alert absence.');
    if (request.command === 'fake-controller' && request.args[0] === 'press') popup = false;
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'screenshot' && popup) writeFileSync(request.args[1], overlay);
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && popup) {
      const data = JSON.parse(response.stdout).data;
      data.nodes.push({ type: 'Element(5)', label: 'Turn on notifications?', visible: true }, { type: 'Button', label: 'Not Now', ref: 'e200', enabled: true, visible: true });
      return ok(data);
    }
    return response;
  } });
  assert.equal(result.runStatus, 'complete');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.notEqual(bundle.agentAcceptance.frames[f.ids.home].frameId, blockedFrameId);
  assert.deepEqual(await readFile(join(f.options.outputDirectory, bundle.images[f.ids.home].path)), png);
});

test('both modes decline the iOS password save prompt and retain the decision', async t => {
  for (const mode of ['deterministic', 'agent']) {
    const f = await fixture(t, { routes: [route('home')] });
    let prompt = false;
    const presses = [];
    const agent = mode === 'agent' ? agentFixture([
      state => { assert.equal(JSON.stringify(state).includes('Save Password?'), false); return { action: 'capture', targetId: f.ids.home, description: 'Home.', requiredLabels: ['screen-title'] }; },
      { action: 'done' },
    ]) : undefined;
    const result = await runCiMap({ ...f.options, ...(agent ? { agent } : {}), setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
      if (request.command === 'fake-controller' && request.args[0] === 'open') prompt = true;
      if (request.command === 'fake-controller' && request.args[0] === 'press') { presses.push(request.args[1]); if (/^@e200~s\d+$/.test(request.args[1])) prompt = false; }
      const response = f.options.runner(request);
      if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && prompt) {
        const data = JSON.parse(response.stdout).data;
        data.nodes.push({ type: 'StaticText', label: 'Save Password?', visible: true }, { type: 'Button', label: 'Not Now', ref: 'e200', enabled: true, visible: true },
          { type: 'Button', label: 'Save', ref: 'e201', enabled: true, visible: true });
        return ok(data);
      }
      return response;
    } });
    assert.equal(result.outcomes[f.ids.home].status, 'captured', mode);
    assert.equal(presses.filter(ref => ref.startsWith('@e200')).length, 1, mode);
    assert.equal(presses.some(ref => ref.startsWith('@e201')), false, mode);
    const records = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/system-prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(({ mode, prompt, action }) => ({ mode, prompt, action })), [{ mode, prompt: 'credential-save', action: 'Not Now' }]);
  }
});

test('a capture survives a failed remote daemon check and exports the resend with its diagnostics', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let refused = false;
  const result = await runCiMap({ ...f.options, runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'screenshot' && !refused) { refused = true; return daemonUnavailable(); }
    return f.options.runner(request);
  } });
  assert.equal(refused, true);
  assert.equal(result.outcomes[f.ids.home].status, 'captured');
  const records = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/controller-retries.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(({ command, attempt, delayMs, reason }) => ({ command, attempt, delayMs, reason })),
    [{ command: 'screenshot', attempt: 1, delayMs: 2000, reason: 'remote-daemon-unavailable' }]);
});

test('agent can recover from optional setup failure instead of inheriting deterministic capture failure', async t => {
  const f = await fixture(t);
  const calls = [];
  const agent = agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: f.ids.home, description: 'Home after recovery.', requiredLabels: ['screen-title'] },
    { action: 'open', url: 'sample://settings' },
    { action: 'capture', targetId: f.ids.settings, description: 'Settings after recovery.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ], calls);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'https://outside.invalid' }] });
  assert.equal(result.runStatus, 'complete');
  assert.equal(JSON.parse(calls[0].messages[0].content[0].text).setupFailure.code, 'AGENT_LINK_OUTSIDE_APP');
});

test('agent provider errors stop the exact session without publishing deterministic fallback captures', async t => {
  const f = await fixture(t, { noScheme: true });
  const agent = agentFixture([]);
  agent.provider.run = async () => { throw new Error('Provider is unavailable'); };
  await assert.rejects(runCiMap({ ...f.options, agent }), /Provider is unavailable/);
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
  assert.equal(f.requests.filter(request => request.args[0] === 'open' && request.args[2]?.startsWith('sample://')).length, 0);
});

test('agent full-cache reuse requires and restores the original representative capture context', async t => {
  const first = await fixture(t, { routes: [route('home')] });
  const agent = agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: first.ids.home, description: 'Home review state.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  await runCiMap({ ...first.options, agent });
  const second = await fixture(t, { routes: [route('home')] });
  const reusedAgent = agentFixture([]);
  const result = await runCiMap({ ...second.options, agent: reusedAgent, reuseDirectory: first.options.outputDirectory });
  assert.equal(result.simulatorSessionId, null);
  assert.deepEqual(reusedAgent.contexts, agent.contexts);
  assert.equal(second.requests.some(request => request.command !== 'git'), false);
});

test('agent recaptures cached evidence when the required review context differs', async t => {
  const first = await fixture(t, { routes: [route('home')] });
  await runCiMap({ ...first.options, agent: agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: first.ids.home, description: 'Original context.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]) });
  const second = await fixture(t, { routes: [route('home')] });
  const agent = agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: second.ids.home },
    { action: 'done' },
  ]);
  agent.contexts[second.ids.home] = { description: 'Required comparison context.', requiredLabels: ['screen-title'], parameters: {} };
  const result = await runCiMap({ ...second.options, agent, reuseDirectory: first.options.outputDirectory });
  assert.equal(result.simulatorSessionId, 'session-1');
  assert.equal(result.outcomes[second.ids.home].status, 'captured');
  const bundle = JSON.parse(await readFile(join(second.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.captureContexts[second.ids.home].description, 'Required comparison context.');
});

test('a later required setup failure cannot be hidden by an earlier captured route', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  const result = await runCiMap({ ...f.options, setup: [
    { action: 'open', url: 'sample://home' },
    { action: 'tap', label: 'Get Started', ready: { identifier: 'never-ready' } },
  ] });
  assert.equal(result.runStatus, 'partial');
  assert.equal(result.outcomes[f.ids.home].status, 'failed');
  assert.equal(result.outcomes[f.ids.home].error.code, 'SETUP_READINESS_TIMEOUT');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.images, {});
});

test('visible credentials prevent route screenshots before the controller captures pixels', async t => {
  const f = await fixture(t, { routes: [route('home')], snapshotSecret: DAEMON_TOKEN });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].error.code, 'CAPTURE_SENSITIVE_INPUT');
  assert.equal(f.operations().includes('screenshot'), false);
});

test('structured controller failures preserve readable codes and messages without publishing native payloads', () => {
  const raw = JSON.stringify({ success: false, error: { code: 'TEXT_ENTRY_MISMATCH', message: 'The field did not contain the requested text.',
    details: { hint: 'Inspect the focused input.', args: ['private-input'], runner: { private: 'native-payload' } } } }, null, 2);
  const failure = controllerCommandFailure(raw, 'fill');
  assert.equal(failure.code, 'TEXT_ENTRY_MISMATCH');
  assert.equal(failure.message, 'fill: The field did not contain the requested text.');
  assert.equal(failure.nextAction, 'Inspect the focused input.');
  assert.equal(failure.retryable, false);
  assert.equal(failure.details, undefined);
  assert.equal(JSON.stringify(serializeCiError(failure)).includes('private-input'), false);
  assert.equal(JSON.stringify(serializeCiError(failure)).includes('native-payload'), false);
});

test('explicit busy reads back off on the host and retry within the same capture deadline', () => {
  let now = 0, calls = 0;
  const waits = [], timeouts = [];
  const response = runControllerRead({ args: ['snapshot'], deadlineMs: 10_000, timeoutMs: 10_000, now: () => now,
    sleep: milliseconds => { waits.push(milliseconds); now += milliseconds; },
    run: timeoutMs => { timeouts.push(timeoutMs); return ++calls === 1 ? busyRead() : ok({ nodes: [] }); } });
  assert.equal(JSON.parse(response.stdout).success, true);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(timeouts, [10_000, 9000]);
  assert.equal(calls, 2);
});

test('watchdog and retained busy read envelopes receive the same bounded observation recovery', () => {
  let now = 0, calls = 0;
  const lifecycleBusy = busyRead({ details: { recovery: 'runner_reported_failure', lifecycleState: 'failed',
    transportError: 'The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen).' } });
  const watchdog = busyRead({ message: 'main thread execution timed out', details: { runnerFailureReason: 'runner_main_thread_execution_timeout' } });
  const replies = [watchdog, lifecycleBusy, ok({ nodes: [] })];
  const response = runControllerRead({ args: ['snapshot'], deadlineMs: 10_000, timeoutMs: 10_000, now: () => now,
    sleep: milliseconds => { now += milliseconds; }, run: () => replies[calls++] });
  assert.equal(JSON.parse(response.stdout).success, true);
  assert.equal(calls, 3);
  assert.equal(now, 3000);
  // An alert query that hit the watchdog is answered as unknown at once; replaying it queues more abandoned work.
  let queries = 0;
  const alert = runControllerRead({ args: ['alert', 'get'], deadlineMs: 10_000, timeoutMs: 10_000, now: () => now,
    sleep: () => assert.fail('a timed-out alert query is not replayed'), run: () => { queries++; return watchdog; } });
  assert.equal(JSON.parse(alert.stdout).error.details.runnerFailureReason, 'runner_main_thread_execution_timeout');
  assert.equal(queries, 1);
  // Busy refusals still wait for the runner to drain, for alert queries as for snapshots.
  let busyQueries = 0;
  const drained = runControllerRead({ args: ['alert', 'get'], deadlineMs: 30_000, timeoutMs: 10_000, now: () => now,
    sleep: milliseconds => { now += milliseconds; }, run: () => ++busyQueries === 1 ? lifecycleBusy : noAlert() });
  assert.equal(JSON.parse(drained.stdout).error.message, 'alert not found');
  assert.equal(busyQueries, 2);
});

test('the typed runner watchdog code retries reads only', () => {
  // agent-device 0.21.x types its watchdog expiry with this code; the message is not the contract.
  const typed = () => busyRead({ message: 'XCTest stalled on the current screen', details: { runnerErrorCode: 'MAIN_THREAD_TIMEOUT' } });
  let now = 0, calls = 0;
  const response = runControllerRead({ args: ['snapshot'], deadlineMs: 10_000, timeoutMs: 10_000, now: () => now,
    sleep: milliseconds => { now += milliseconds; }, run: () => ++calls === 1 ? typed() : ok({ nodes: [] }) });
  assert.equal(JSON.parse(response.stdout).success, true);
  assert.equal(calls, 2);
  let queries = 0;
  const alert = runControllerRead({ args: ['alert', 'get'], deadlineMs: 10_000, timeoutMs: 10_000, now: () => now,
    sleep: () => assert.fail('a timed-out alert query is not replayed'), run: () => { queries++; return typed(); } });
  assert.equal(JSON.parse(alert.stdout).error.details.runnerErrorCode, 'MAIN_THREAD_TIMEOUT');
  assert.equal(queries, 1);
  let presses = 0;
  const pressed = runControllerRead({ args: ['press', '@e1'], deadlineMs: 10_000, timeoutMs: 10_000, now: () => now,
    sleep: () => assert.fail('a mutation is never retried'), run: () => { presses++; return typed(); } });
  assert.equal(JSON.parse(pressed.stdout).error.details.runnerErrorCode, 'MAIN_THREAD_TIMEOUT');
  assert.equal(presses, 1);
});

test('a command refused by the remote daemon check is sent again, reads and actions alike, within the capture deadline', async () => {
  let now = 0;
  const waits = [], retries = [];
  const shared = { deadlineMs: 60_000, timeoutMs: 10_000, now: () => now,
    sleep: milliseconds => { waits.push(milliseconds); now += milliseconds; }, onRemoteDaemonRetry: retry => retries.push(retry) };
  // The failed check means the command never reached the daemon, so even a press is safe to send again.
  for (const args of [['snapshot'], ['press', '@e1'], ['alert', 'get']]) {
    let calls = 0;
    const response = runControllerRead({ ...shared, args, run: () => ++calls === 1 ? daemonUnavailable() : ok({ nodes: [] }) });
    assert.equal(JSON.parse(response.stdout).success, true, args[0]);
    assert.equal(calls, 2, args[0]);
  }
  assert.deepEqual(waits, [2000, 2000, 2000]);
  assert.deepEqual(retries.map(retry => [retry.command, retry.attempt, retry.delayMs]), [['snapshot', 1, 2000], ['press', 1, 2000], ['alert', 1, 2000]]);
  // A thrown structured failure (the synchronous runner's form for actions) is retried the same way.
  let thrown = 0;
  runControllerRead({ ...shared, args: ['press', '@e2'], run: () => {
    if (++thrown === 1) throw controllerCommandFailure(daemonUnavailable().stdout, 'press');
    return ok({});
  } });
  assert.equal(thrown, 2);
  // A longer outage still fails after two resends, and a resend never outlives the capture deadline.
  waits.length = 0;
  let attempts = 0;
  const lost = runControllerRead({ ...shared, args: ['snapshot'], run: () => { attempts++; return daemonUnavailable(); } });
  assert.equal(JSON.parse(lost.stdout).error.message, 'Remote daemon is unavailable');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2000, 5000]);
  let late = 0;
  runControllerRead({ ...shared, deadlineMs: now + 1500, args: ['snapshot'], sleep: () => assert.fail('no resend past the deadline'),
    run: () => { late++; return daemonUnavailable(); } });
  assert.equal(late, 1);
  // Any other failure of an action is still never replayed.
  let presses = 0;
  runControllerRead({ ...shared, args: ['press', '@e3'], sleep: () => assert.fail('an uncertain action is never replayed'),
    run: () => { presses++; return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'Connection reset during press' } }); } });
  assert.equal(presses, 1);
  // The agent's asynchronous controller path applies the same rule.
  let asyncCalls = 0;
  const asyncWaits = [];
  const response = await runControllerReadAsync({ args: ['press', '@e4'], deadlineMs: now + 60_000, timeoutMs: 10_000, now: () => now,
    signal: new AbortController().signal, sleep: async milliseconds => { asyncWaits.push(milliseconds); now += milliseconds; },
    run: async () => ++asyncCalls === 1 ? daemonUnavailable() : ok({}) });
  assert.equal(JSON.parse(response.stdout).success, true);
  assert.equal(asyncCalls, 2);
  assert.deepEqual(asyncWaits, [2000]);
});

// agent-device 0.21.15's Android snapshot helper when the emulator's adb transport drops briefly after boot.
const adbOffline = () => json({ success: false, error: { code: 'COMMAND_FAILED',
  message: 'snapshot: Android snapshot helper failed: Android snapshot helper failed before returning parseable output: adb: device offline' } });

test('an observation that found the Android emulator offline is sent again, but an action never is', async () => {
  let now = 0;
  const waits = [], retries = [];
  const shared = { deadlineMs: 120_000, timeoutMs: 10_000, now: () => now,
    sleep: milliseconds => { waits.push(milliseconds); now += milliseconds; }, onRemoteDaemonRetry: retry => retries.push(retry) };
  for (const args of [['snapshot'], ['appstate'], ['alert', 'get']]) {
    let calls = 0;
    const response = runControllerRead({ ...shared, args, run: () => ++calls === 1 ? adbOffline() : ok({ nodes: [] }) });
    assert.equal(JSON.parse(response.stdout).success, true, args[0]);
    assert.equal(calls, 2, args[0]);
  }
  assert.deepEqual(waits, [2000, 2000, 2000]);
  assert.deepEqual(retries.map(retry => [retry.command, retry.attempt, retry.delayMs]), [['snapshot', 1, 2000], ['appstate', 1, 2000], ['alert', 1, 2000]]);
  // A transport that stays offline is given a minute (euxy #156's outage lasted ~30 s), then fails.
  waits.length = 0;
  let attempts = 0;
  const lost = runControllerRead({ ...shared, args: ['snapshot'], run: () => { attempts++; return adbOffline(); } });
  assert.match(JSON.parse(lost.stdout).error.message, /adb: device offline/);
  assert.deepEqual(waits, [2000, 5000, 10000, 10000, 10000, 10000, 10000]);
  assert.equal(attempts, 8);
  assert.ok(waits.reduce((sum, wait) => sum + wait, 0) <= 60_000);
  // A tap may have reached the device before adb dropped, so it is never replayed.
  let presses = 0;
  const pressed = runControllerRead({ ...shared, args: ['press', '@e1'], sleep: () => assert.fail('an uncertain action is never replayed'),
    run: () => { presses++; return adbOffline(); } });
  assert.match(JSON.parse(pressed.stdout).error.message, /adb: device offline/);
  assert.equal(presses, 1);
  let asyncCalls = 0;
  const response = await runControllerReadAsync({ args: ['snapshot'], deadlineMs: now + 60_000, timeoutMs: 10_000, now: () => now,
    signal: new AbortController().signal, sleep: async milliseconds => { now += milliseconds; },
    run: async () => ++asyncCalls === 1 ? adbOffline() : ok({ nodes: [] }) });
  assert.equal(JSON.parse(response.stdout).success, true);
  assert.equal(asyncCalls, 2);
});

// agent-device 0.21.15 when adb loses the emulator for a few seconds mid-run (euxy #137, run 38082841356).
const adbDeviceNotFound = () => json({ success: false, error: { code: 'COMMAND_FAILED',
  message: "snapshot: Android snapshot helper failed: Failed to install Android snapshot helper: device 'emulator-5554' not found: adb: device 'emulator-5554' not found" } });

test('an observation that found the Android emulator missing from adb is sent again, but an action never is', () => {
  let now = 0;
  const waits = [];
  const shared = { deadlineMs: 120_000, timeoutMs: 10_000, now: () => now, sleep: milliseconds => { waits.push(milliseconds); now += milliseconds; } };
  let calls = 0;
  const response = runControllerRead({ ...shared, args: ['snapshot'], run: () => ++calls === 1 ? adbDeviceNotFound() : ok({ nodes: [] }) });
  assert.equal(JSON.parse(response.stdout).success, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  waits.length = 0;
  let attempts = 0;
  const lost = runControllerRead({ ...shared, args: ['snapshot'], run: () => { attempts++; return adbDeviceNotFound(); } });
  assert.match(JSON.parse(lost.stdout).error.message, /not found/);
  assert.equal(attempts, 8);
  assert.deepEqual(waits, [2000, 5000, 10000, 10000, 10000, 10000, 10000]);
  let presses = 0;
  const pressed = runControllerRead({ ...shared, args: ['press', '@e1'], sleep: () => assert.fail('an uncertain action is never replayed'),
    run: () => { presses++; return adbDeviceNotFound(); } });
  assert.match(JSON.parse(pressed.stdout).error.message, /not found/);
  assert.equal(presses, 1);
});

test('busy accessibility reads can drain after more than three seconds without replaying navigation', () => {
  let now = 0, reads = 0, opens = 0;
  const recovery = { busyAttempts: 0 };
  const shared = { recovery, deadlineMs: 180_000, timeoutMs: 60_000, now: () => now,
    sleep: milliseconds => { assert.ok(milliseconds <= 5000); now += milliseconds; } };
  runControllerRead({ ...shared, args: ['open', 'app'], run: () => { opens++; return ok({}); } });
  const result = runControllerRead({ ...shared, args: ['snapshot'], run: timeoutMs => {
    reads++;
    assert.ok(timeoutMs <= 180_000 - now);
    return now < 20_000 ? busyRead() : ok({ nodes: [], snapshotQuality: { state: 'healthy', backend: 'tree' } });
  } });
  assert.equal(JSON.parse(result.stdout).success, true);
  assert.equal(opens, 1);
  assert.ok(reads > 3);
  assert.ok(now >= 20_000 && now < 25_000);
  assert.deepEqual(recovery, { busyAttempts: 0 });
});

test('persistent busy reads exhaust one shared 120 second window including later diagnostics', () => {
  let now = 0, calls = 0;
  const recovery = { busyAttempts: 0 }, waits = [];
  const shared = { recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => now,
    sleep: milliseconds => { waits.push(milliseconds); now += milliseconds; }, run: timeoutMs => {
      calls++;
      assert.ok(timeoutMs <= (now > 120_000 ? 60_000 : Math.min(60_000, 120_000 - now)));
      return busyRead();
    } };
  assert.throws(() => runControllerRead({ ...shared, args: ['alert', 'get'] }),
    error => error.code === 'CONTROLLER_READ_BUSY' && error.retryable === false);
  assert.equal(now, 120_001);
  assert.ok(waits.every(milliseconds => milliseconds <= 5000));
  const callsBeforeDiagnostic = calls;
  assert.throws(() => runControllerRead({ ...shared, args: ['appstate'] }), { code: 'CONTROLLER_READ_BUSY' });
  assert.throws(() => runControllerRead({ ...shared, args: ['snapshot'] }), { code: 'CONTROLLER_READ_BUSY' });
  assert.equal(calls, callsBeforeDiagnostic, 'diagnostics cannot open a new drain window');
  assert.equal(now, 120_001);
});

test('cached and independent-backend reads do not claim abandoned XCTest work has drained', () => {
  let now = 0, calls = 0;
  const recovery = { busyAttempts: 0 };
  const shared = { recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => now,
    sleep: milliseconds => { now += milliseconds; } };
  runControllerRead({ ...shared, args: ['snapshot'], run: () => ++calls === 1 ? busyRead()
    : ok({ nodes: [], snapshotQuality: { state: 'recovered', backend: 'private-ax' } }) });
  assert.deepEqual(recovery, { busyAttempts: 1, busyDeadlineMs: 120_000 });
  for (const [args, response] of [[['appstate'], ok({ appBundleId: 'app' })], [['snapshot'], ok({})],
    [['snapshot'], busyRead({ message: 'Unknown read failure', details: {} })]]) {
    runControllerRead({ ...shared, args, run: () => response });
    assert.deepEqual(recovery, { busyAttempts: 1, busyDeadlineMs: 120_000 });
  }
  runControllerRead({ ...shared, args: ['alert', 'get'], run: noAlert });
  assert.deepEqual(recovery, { busyAttempts: 0 });
});

test('busy recovery has an independent hard attempt bound when the clock does not advance', () => {
  let calls = 0;
  const recovery = { busyAttempts: 0 };
  const shared = { recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => 0, sleep: () => {},
    run: () => { calls++; return busyRead(); } };
  assert.throws(() => runControllerRead({ ...shared, args: ['snapshot'] }), { code: 'CONTROLLER_READ_BUSY' });
  assert.equal(calls, 32);
  assert.throws(() => runControllerRead({ ...shared, args: ['snapshot'] }), { code: 'CONTROLLER_READ_BUSY' });
  assert.equal(calls, 32);
});

test('capture deadline bounds delayed busy recovery before the native wedge horizon', () => {
  let now = 0, calls = 0;
  assert.throws(() => runControllerRead({ args: ['snapshot'], deadlineMs: 8500, timeoutMs: 60_000, now: () => now,
    sleep: milliseconds => { now += milliseconds; }, run: timeoutMs => {
      calls++;
      assert.equal(timeoutMs, 8500 - now);
      return busyRead();
    } }), { code: 'CAPTURE_BUDGET_EXHAUSTED' });
  assert.equal(calls, 4);
  assert.equal(now, 7000);
});

test('mutations, wedged runners, app crashes, and arbitrary read failures never receive automatic retry', () => {
  const cases = [
    [['fill', '@e1', 'input'], busyRead()],
    [['press', '@e1'], busyRead()],
    [['alert', 'accept'], busyRead()],
    [['snapshot'], busyRead({ code: 'RUNNER_WEDGED' })],
    [['snapshot'], busyRead({ details: { runnerErrorCode: 'RUNNER_WEDGED', runnerFailureReason: 'runner_main_thread_execution_timeout' } })],
    [['snapshot'], busyRead({ code: 'IOS_TARGET_APP_CRASH' })],
    [['snapshot'], busyRead({ message: 'A generic transport timeout.', details: { retriable: true } })],
    [['alert', 'get'], noAlert()],
  ];
  for (const [args, reply] of cases) {
    let calls = 0;
    const actual = runControllerRead({ args, deadlineMs: 10_000, timeoutMs: 10_000, now: () => 0,
      sleep: () => assert.fail('Unexpected retry backoff'), run: () => { calls++; return reply; } });
    assert.equal(actual, reply);
    assert.equal(calls, 1);
  }
});

test('read recovery cannot sleep or retry past the capture deadline', () => {
  let calls = 0;
  assert.throws(() => runControllerRead({ args: ['snapshot'], deadlineMs: 500, timeoutMs: 10_000, now: () => 0,
    sleep: () => assert.fail('Insufficient budget must not sleep'), run: timeoutMs => {
      calls++; assert.equal(timeoutMs, 500); return busyRead();
    } }), { code: 'CAPTURE_BUDGET_EXHAUSTED' });
  assert.equal(calls, 1);
});

test('late read replies cannot reset an exhausted recovery window or extend capture time', () => {
  for (const [recovery, deadlineMs, end, code] of [
    [{ busyAttempts: 1, busyDeadlineMs: 120_000 }, 300_000, 120_000, 'CONTROLLER_READ_BUSY'],
    [{ busyAttempts: 0 }, 1000, 1000, 'CAPTURE_BUDGET_EXHAUSTED'],
  ]) {
    let now = 0;
    assert.throws(() => runControllerRead({ args: ['alert', 'get'], recovery, deadlineMs, timeoutMs: 60_000, now: () => now,
      run: () => { now = end; return noAlert(); } }), { code });
    assert.equal(recovery.busyAttempts, code === 'CONTROLLER_READ_BUSY' ? 1 : 0);
  }
});

test('one post-threshold probe lets the daemon recycle its helper and performs one fresh read', () => {
  let now = 0, reads = 0, wedged = false;
  const recovery = { busyAttempts: 0 };
  const result = runControllerRead({ args: ['alert', 'get'], recovery, deadlineMs: 300_000, timeoutMs: 60_000,
    now: () => now, sleep: milliseconds => { now += milliseconds; }, run: () => {
      reads++;
      if (now <= 120_000) return busyRead();
      if (!wedged) { wedged = true; return busyRead({ code: 'RUNNER_WEDGED' }); }
      return noAlert();
    } });
  assert.equal(JSON.parse(result.stdout).error.message, 'alert not found');
  assert.equal(now, 120_001);
  assert.equal(recovery.recycleUsed, true);
  assert.equal(recovery.needsVerification, true);
  const readCount = reads;
  assert.throws(() => runControllerRead({ args: ['snapshot'], recovery, deadlineMs: 300_000, timeoutMs: 60_000,
    now: () => now, sleep: () => assert.fail('A recycled session cannot start another busy window'),
    run: () => { reads++; return busyRead(); } }), { code: 'CONTROLLER_READ_BUSY' });
  assert.equal(reads, readCount + 1);
});

test('failed fresh reads after explicit native wedging remain terminal for diagnostics and mutations', () => {
  for (const reply of [busyRead(), busyRead({ code: 'RUNNER_WEDGED' }),
    busyRead({ code: 'IOS_TARGET_APP_CRASH' }), busyRead({ message: 'Unknown failure', details: {} })]) {
    let calls = 0;
    const recovery = { busyAttempts: 2, busyDeadlineMs: 120_000 };
    const shared = { recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => 120_001,
      sleep: () => assert.fail('A failed recovery read cannot be retried'), run: () => {
        calls++;
        return calls === 1 ? busyRead({ details: { runnerErrorCode: 'RUNNER_WEDGED' } }) : reply;
      } };
    assert.throws(() => runControllerRead({ ...shared, args: ['alert', 'get'] }));
    assert.equal(calls, 2);
    assert.throws(() => runControllerRead({ ...shared, args: ['snapshot'] }));
    assert.throws(() => runControllerRead({ ...shared, args: ['open', 'app'] }));
    assert.equal(calls, 2);
  }
});

test('a later wedged helper cannot authorize a second recycle or any subsequent mutation', () => {
  const recovery = { busyAttempts: 1, busyDeadlineMs: 120_000 };
  let calls = 0;
  const replies = [busyRead({ code: 'RUNNER_WEDGED' }), noAlert(), busyRead({ code: 'RUNNER_WEDGED' })];
  const shared = { recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => 1000,
    run: () => replies[calls++] };
  runControllerRead({ ...shared, args: ['alert', 'get'] });
  assert.equal(recovery.recycleUsed, true);
  assert.throws(() => runControllerRead({ ...shared, args: ['snapshot'] }), { code: 'RUNNER_WEDGED' });
  assert.throws(() => runControllerRead({ ...shared, args: ['open', 'app'] }), { code: 'RUNNER_WEDGED' });
  assert.equal(calls, 3);
});

test('unverified wedged errors and mutation failures never authorize a helper recovery read', () => {
  const unverified = new CiError({ code: 'RUNNER_WEDGED', stage: 'controller', message: 'Unverified failure', nextAction: 'Inspect.' });
  let calls = 0;
  assert.throws(() => runControllerRead({ args: ['snapshot'], recovery: { busyAttempts: 1, busyDeadlineMs: 120_000 },
    deadlineMs: 300_000, timeoutMs: 60_000, now: () => 1000,
    run: () => { calls++; throw unverified; } }), error => error === unverified);
  assert.equal(calls, 1);
  for (const args of [['open', 'app'], ['fill', '@e1', 'input'], ['alert', 'accept']]) {
    const recovery = { busyAttempts: 1, busyDeadlineMs: 120_000 };
    const reply = busyRead({ code: 'RUNNER_WEDGED' });
    const result = runControllerRead({ args, recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => 1000,
      run: () => { calls++; return reply; } });
    assert.equal(result, reply);
    assert.equal(recovery.recycleUsed, undefined);
    assert.throws(() => runControllerRead({ args: ['snapshot'], recovery, deadlineMs: 300_000,
      timeoutMs: 60_000, now: () => 1000, run: () => assert.fail('An ineligible wedge cannot start another helper') }),
      { code: 'RUNNER_WEDGED' });
  }
  assert.equal(calls, 4);
});

test('a final native probe cannot run beyond the shared capture deadline', () => {
  let calls = 0;
  assert.throws(() => runControllerRead({ args: ['alert', 'get'], recovery: { busyAttempts: 2, busyDeadlineMs: 120_000 },
    deadlineMs: 120_001, timeoutMs: 60_000, now: () => 120_000,
    sleep: () => assert.fail('Insufficient margin must not sleep'), run: () => { calls++; return noAlert(); } }),
    { code: 'CAPTURE_BUDGET_EXHAUSTED' });
  assert.equal(calls, 0);
});

test('an unknown final-probe failure blocks later diagnostics and actions without a recycle', () => {
  const recovery = { busyAttempts: 2, busyDeadlineMs: 120_000 };
  let calls = 0;
  const shared = { recovery, deadlineMs: 300_000, timeoutMs: 60_000, now: () => 120_001,
    run: () => { calls++; return busyRead({ code: 'IOS_TARGET_APP_CRASH' }); } };
  assert.throws(() => runControllerRead({ ...shared, args: ['snapshot'] }), { code: 'IOS_TARGET_APP_CRASH' });
  assert.throws(() => runControllerRead({ ...shared, args: ['open', 'app'] }), { code: 'IOS_TARGET_APP_CRASH' });
  assert.equal(calls, 1);
  assert.equal(recovery.recycleUsed, undefined);
});

test('capture recovers an explicitly busy alert read without repeating its preceding app navigation', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let failedRead = false;
  const result = await runCiMap({ ...f.options, runner: request => {
    if (!failedRead && request.command === 'fake-controller' && request.args[0] === 'alert' && request.args[1] === 'get') {
      failedRead = true;
      assert.equal(request.allowFailure, true, 'the native JSON error envelope remains available for classification');
      return busyRead();
    }
    return f.options.runner(request);
  } });
  assert.equal(result.runStatus, 'complete');
  assert.equal(failedRead, true);
  assert.equal(f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'open' && request.args[2] === 'sample://home').length, 1);
});

test('helper recycling verifies fresh app identity and route without repeating the completed open', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let armed = false, phase = 0;
  const result = await runCiMap({ ...f.options, runner: request => {
    if (request.command === 'fake-controller') {
      if (request.args[0] === 'open' && request.args[2] === 'sample://home') armed = true;
      if (armed && request.args[0] === 'snapshot' && phase < 2) {
        return ++phase === 1 ? busyRead() : busyRead({ code: 'RUNNER_WEDGED' });
      }
      if (phase === 2 && request.args[0] === 'snapshot') return recoveredSnapshot(f.options.runner(request));
    }
    return f.options.runner(request);
  } });
  assert.equal(result.runStatus, 'complete');
  assert.equal(phase, 2);
  assert.equal(f.requests.filter(request => request.args[0] === 'open' && request.args[2] === 'sample://home').length, 1);
  assert.equal(f.operations().includes('close'), false);
});

test('a recycled helper with an unknown observer or different app cannot proceed to screenshots', async t => {
  for (const badState of ['invalidObserver', 'wrongForeground']) {
    const settings = { routes: [route('home')] };
    const f = await fixture(t, settings);
    let phase = 0;
    const result = await runCiMap({ ...f.options, runner: request => {
      if (request.command === 'fake-controller' && request.args[0] === 'alert' && phase < 2) {
        if (++phase === 1) return busyRead();
        settings[badState] = true;
        return busyRead({ code: 'RUNNER_WEDGED' });
      }
      return f.options.runner(request);
    } });
    assert.notEqual(result.runStatus, 'complete');
    // Another app in front is contained like a stuck controller: the app restarts and the route is tried, and while
    // the wrong app stays in front its frame is never published.
    const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
    assert.deepEqual(Object.keys(bundle.images), []);
    if (badState === 'invalidObserver') assert.equal(f.operations().includes('screenshot'), false);
    assert.equal(result.outcomes[f.ids.home].error.code,
      badState === 'invalidObserver' ? 'CONTROLLER_RECOVERY_UNVERIFIED' : 'CONTROLLER_IDENTITY_MISMATCH');
  }
});

test('a screenshot spanning helper recycling is discarded and captured again', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let screenshots = 0, phase = 0;
  const result = await runCiMap({ ...f.options, runner: request => {
    if (request.command === 'fake-controller') {
      if (request.args[0] === 'screenshot') screenshots++;
      if (screenshots === 1 && request.args[0] === 'snapshot' && phase < 2) {
        return ++phase === 1 ? busyRead() : busyRead({ code: 'RUNNER_WEDGED' });
      }
      if (phase === 2 && request.args[0] === 'snapshot') return recoveredSnapshot(f.options.runner(request));
    }
    return f.options.runner(request);
  } });
  assert.equal(result.runStatus, 'complete');
  assert.equal(screenshots, 2);
  assert.equal(result.outcomes[f.ids.home].attempts, 2);
});

test('agent observation withholds a frame spanning helper recycling and supplies fresh nodes and refs', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  const calls = [];
  const agent = agentFixture([
    { action: 'observe' },
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ], calls);
  let images = 0, phase = 0, recoveredGeneration;
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'screenshot') images++;
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && images === 1 && phase < 2) {
      return ++phase === 1 ? busyRead() : busyRead({ code: 'RUNNER_WEDGED' });
    }
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && phase === 2) {
      const parsed = JSON.parse(response.stdout);
      parsed.data.snapshotQuality = { state: 'healthy', backend: 'tree' };
      recoveredGeneration ??= parsed.data.refsGeneration;
      return json(parsed);
    }
    return response;
  } });
  assert.equal(result.runStatus, 'complete');
  const content = calls[0].messages[0].content;
  assert.equal(content.some(block => block.type === 'image'), false);
  assert.equal(JSON.parse(content[0].text).observation.refsGeneration, recoveredGeneration);
});

test('agent coordinate fallback uses logical bounds and presses only the unchanged inspected image', async t => {
  const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 4, height: 6 } });
  const agent = agentFixture([
    state => ({ action: 'tap', frameId: state.frameId, x: 0.5, y: 0.5 }),
    { action: 'capture', targetId: f.ids.home, description: 'Loaded screen after tapping the observed control.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }] });
  assert.equal(result.runStatus, 'complete');
  const press = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'press');
  assert.equal(press.length, 1);
  assert.deepEqual(press[0].args.slice(0, 3), ['press', '2', '3']);
});

test('agent coordinate fallback turns a tap on an upright frame back onto the portrait axes of a panel showing a landscape UI', async t => {
  // An opened iPhone Duo under Argent: the 4x6 screenshot is the panel's 6x4 tree turned a quarter clockwise, so the image
  // point (u, v) is the tree point (v, H - u). The tap at (0.5, 0.25) of the image is pixel (2, 1.5), the tree point (1.5, 4 - 2).
  const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 6, height: 4 } });
  const agent = agentFixture([
    state => ({ action: 'tap', frameId: state.frameId, x: 0.5, y: 0.25 }),
    { action: 'capture', targetId: f.ids.home, description: 'Loaded screen after tapping the observed control.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }] });
  assert.equal(result.runStatus, 'complete');
  const press = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'press');
  assert.equal(press.length, 1);
  assert.deepEqual(press[0].args.slice(0, 3), ['press', '1.5', '2']);
});

test('coordinate freshness compares rectangle values independently of native JSON property order', async t => {
  const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 4, height: 6 } });
  let snapshots = 0;
  const rectOrders = [['width', 'height', 'x', 'y'], ['y', 'height', 'x', 'width'], ['height', 'x', 'y', 'width']];
  const agent = agentFixture([
    state => ({ action: 'tap', frameId: state.frameId, x: 0.5, y: 0.5 }),
    { action: 'capture', targetId: f.ids.home, description: 'Loaded unchanged screen.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    const response = f.options.runner(request);
    if (request.command !== 'fake-controller' || request.args[0] !== 'snapshot') return response;
    const value = JSON.parse(response.stdout);
    const order = rectOrders[++snapshots % rectOrders.length];
    for (const node of value.data.nodes) if (node.rect) node.rect = Object.fromEntries(order.map(key => [key, node.rect[key]]));
    return json(value);
  } });
  const press = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'press');
  assert.equal(press.length, 1, 'Equivalent JSON rectangles must not block an unchanged inspected frame.');
  assert.deepEqual(press[0].args.slice(0, 3), ['press', '2', '3']);
});

test('coordinate freshness still rejects changed geometry and input values with unchanged pixels', async t => {
  for (const change of ['bounds', 'rectangle', 'value']) {
    const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 4, height: 6 } });
    let changed = false;
    const agent = agentFixture([
      state => { changed = true; return { action: 'tap', frameId: state.frameId, x: 0.5, y: 0.5 }; },
      { action: 'capture', targetId: f.ids.home, description: 'Newly inspected screen.', requiredLabels: ['screen-title'] },
      { action: 'done' },
    ]);
    await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
      const response = f.options.runner(request);
      if (request.command !== 'fake-controller' || request.args[0] !== 'snapshot') return response;
      const value = JSON.parse(response.stdout);
      if (changed && change === 'bounds') value.data.nodes.find(node => node.type === 'Application').rect = { x: 0, y: 0, width: 8, height: 12 };
      value.data.nodes.push({ type: 'TextField', identifier: 'name', value: changed && change === 'value' ? 'Changed' : 'Original',
        rect: { x: changed && change === 'rectangle' ? 2 : 1, y: 1, width: 1, height: 1 } });
      return json(value);
    } });
    assert.equal(f.operations().includes('press'), false, change);
    const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const failure = trace.find(event => event.action === 'tap').result.error;
    assert.equal(failure.code, 'AGENT_FRAME_STALE');
    assert.deepEqual(failure.details, { boundsChanged: change === 'bounds', accessibilityChanged: true, pixelsChanged: false }, change);
  }
});

test('agent coordinate fallback refuses changed pixels even when the accessibility tree is identical', async t => {
  const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 4, height: 6 } });
  let changed = false;
  const alternate = PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(4 * 6 * 4, 71) });
  const agent = agentFixture([
    state => { changed = true; return { action: 'tap', frameId: state.frameId, x: 0.5, y: 0.5 }; },
    { action: 'capture', targetId: f.ids.home, description: 'Newly inspected loaded screen.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'screenshot' && changed) writeFileSync(request.args[1], alternate);
    return response;
  } });
  assert.equal(result.runStatus, 'complete');
  assert.equal(f.operations().includes('press'), false);
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace.find(event => event.action === 'tap').result.error.code, 'AGENT_FRAME_STALE');
  assert.deepEqual(trace.find(event => event.action === 'tap').result.error.details, {
    boundsChanged: false, accessibilityChanged: false, pixelsChanged: true,
  });
});

test('agent coordinate fallback ignores status-bar-only pixel changes below the band and still refuses app pixel changes', async t => {
  // 100 rows: rows 0-5 lie inside the 6.5% status-bar band, row 6 is the first app row.
  const frame = changedRow => {
    const data = Buffer.alloc(4 * 100 * 4, 255);
    if (changedRow !== undefined) data.fill(40, changedRow * 4 * 4, (changedRow + 1) * 4 * 4);
    return PNG.sync.write({ width: 4, height: 100, data });
  };
  // A tap inside the band acts on what is drawn there, so there the band counts too.
  for (const [changedRow, tapY, pressed] of [[5, 0.5, true], [6, 0.5, false], [5, 0.02, false]]) {
    const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 4, height: 100 } });
    let changed = false;
    const agent = agentFixture([
      state => { changed = true; return { action: 'tap', frameId: state.frameId, x: 0.5, y: tapY }; },
      { action: 'capture', targetId: f.ids.home, description: 'Loaded screen after the tap.', requiredLabels: ['screen-title'] },
      { action: 'done' },
    ]);
    await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
      const response = f.options.runner(request);
      if (request.command === 'fake-controller' && request.args[0] === 'screenshot') writeFileSync(request.args[1], frame(changed ? changedRow : undefined));
      return response;
    } });
    const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const tap = trace.find(event => event.action === 'tap');
    const label = `row ${changedRow}, tap y ${tapY}`;
    assert.equal(f.operations().includes('press'), pressed, label);
    if (pressed) assert.equal(tap.result.error, undefined, label);
    else assert.deepEqual(tap.result.error.details, { boundsChanged: false, accessibilityChanged: false, pixelsChanged: true }, label);
  }
});

test('agent direct reuse treats missing or changed acceptance receipts as a cache miss', async t => {
  const first = await fixture(t, { routes: [route('home')] });
  await runCiMap({ ...first.options, agent: agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: first.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]) });
  const path = join(first.options.outputDirectory, 'bundle.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const mode of ['missing', 'changed']) {
    const bundle = structuredClone(original);
    if (mode === 'missing') delete bundle.agentAcceptance;
    else bundle.agentAcceptance.frames[first.ids.home].imageSha256 = 'f'.repeat(64);
    await writeFile(path, JSON.stringify(bundle));
    const next = await fixture(t, { routes: [route('home')] });
    const result = await runCiMap({ ...next.options, reuseDirectory: first.options.outputDirectory, agent: agentFixture([
      { action: 'open', url: 'sample://home' },
      { action: 'capture', targetId: next.ids.home, description: 'Recaptured home.', requiredLabels: ['screen-title'] },
      { action: 'done' },
    ]) });
    assert.equal(result.simulatorSessionId, 'session-1');
    const captured = JSON.parse(await readFile(join(next.options.outputDirectory, 'bundle.json'), 'utf8'));
    assert.notEqual(captured.agentAcceptance.frames[next.ids.home].frameId, original.agentAcceptance.frames[first.ids.home].frameId);
  }
});

test('a CLI failure retains earlier accepted frames and their receipt instead of relabeling all targets failed', async t => {
  const f = await fixture(t);
  const agent = agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
  ]);
  const run = agent.provider.run;
  agent.provider.run = async request => { await run(request); throw new Error('CLI stopped before completing the remaining target.'); };
  await assert.rejects(runCiMap({ ...f.options, agent }), /CLI stopped/);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.outcomes[f.ids.home].status, 'captured');
  assert.equal(bundle.outcomes[f.ids.settings].status, 'failed');
  assert.deepEqual(Object.keys(bundle.images), [f.ids.home]);
  assert.deepEqual(Object.keys(bundle.agentAcceptance.frames), [f.ids.home]);
});

test('agent observation withholds sensitive pixels while still exposing redacted accessibility for navigation', async t => {
  const secret = 'private-fixture-input-value';
  const f = await fixture(t, { routes: [route('home')], snapshotSecret: secret });
  const agent = agentFixture([]);
  agent.instructions += ' Use {{secret:TEST_PASSWORD}} only for app input.';
  agent.provider.run = async request => {
    const observed = await request.callTool('observe', {}, new AbortController().signal);
    assert.equal(observed.content.some(block => block.type === 'image'), false);
    assert.equal(JSON.stringify(observed).includes(secret), false);
    assert.equal(JSON.parse(observed.content[0].text).imageUnavailable.code, 'CAPTURE_SENSITIVE_INPUT');
    throw new Error('Stop after verifying withheld evidence.');
  };
  await assert.rejects(runCiMap({ ...f.options, agent, environment: { TEST_PASSWORD: secret } }), /Stop after/);
  assert.equal(f.operations().includes('screenshot'), false);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.agentAcceptance.frames, {});
});

test('async agent controller cancellation waits for its owned process to exit without blocking the tool host', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'explore-controller-cancel-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'pid');
  const signal = new AbortController();
  const request = runAgentControllerCommand({ command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path)}, String(process.pid));setInterval(()=>{},1000)`],
    cwd: root, environment: {}, timeoutMs: 5000 }, signal.signal);
  const failure = assert.rejects(request, /Test cancellation/);
  let pid;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try { pid = Number(await readFile(path, 'utf8')); } catch {}
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid, 'the event loop stays responsive while the controller waits');
  signal.abort(new Error('Test cancellation'));
  await failure;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('agent normalizes a verified wrapped native wedge into a terminal tool failure', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  const agent = agentFixture([]);
  let rejected;
  agent.provider.run = async request => {
    try { await request.callTool('observe', {}, new AbortController().signal); }
    catch (error) { rejected = error; }
    assert.equal(rejected.code, 'CONTROLLER_RUNNER_WEDGED');
    await assert.rejects(request.callTool('act', { action: 'open', url: 'sample://home' }, new AbortController().signal), error => error.code === 'CONTROLLER_RUNNER_WEDGED');
    return { inputTokens: 1, outputTokens: 1 };
  };
  await assert.rejects(runCiMap({ ...f.options, agent, runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot') return busyRead({ details: { runnerErrorCode: 'RUNNER_WEDGED' } });
    return f.options.runner(request);
  } }), error => error.code === 'CONTROLLER_RUNNER_WEDGED');
  assert.equal(f.requests.some(request => request.args[0] === 'open' && request.args[2]?.startsWith('sample://')), false);
  const trace = await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8');
  assert.match(trace, /CONTROLLER_RUNNER_WEDGED/);
  assert.doesNotMatch(trace, /runnerErrorCode/);
});

test('agent coordinate fallback maps a uniformly scaled Retina image to verified logical points', async t => {
  const f = await fixture(t, { routes: [route('home')], stableLabels: true, logicalBounds: { x: 0, y: 0, width: 4, height: 6 } });
  const retina = PNG.sync.write({ width: 8, height: 12, data: Buffer.alloc(8 * 12 * 4, 255) });
  const agent = agentFixture([
    state => ({ action: 'tap', frameId: state.frameId, x: 0.5, y: 0.5 }),
    { action: 'capture', targetId: f.ids.home, description: 'Loaded screen after the coordinate action.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'screenshot') writeFileSync(request.args[1], retina);
    return response;
  } });
  assert.equal(result.runStatus, 'complete');
  const press = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'press');
  assert.equal(press.length, 1);
  assert.deepEqual(press[0].args.slice(0, 3), ['press', '2', '3']);
});

test('a failed EAS start preserves its actionable cause without exposing private handoff data or guessing a session', async t => {
  const f = await fixture(t);
  const opaqueToken = 'opaque-short-token';
  const privateUrl = 'https://private-controller.example/secret-session?token=url-token';
  let privateRoot;
  t.after(async () => { if (privateRoot) await rm(privateRoot, { recursive: true, force: true }); });
  await assert.rejects(runCiMap({ ...f.options, runner: request => {
    if (request.command === 'fake-eas' && request.args[0] === 'simulator:start') {
      privateRoot = request.cwd;
      throw new CiError({ code: 'EAS_REQUEST_REJECTED', stage: 'session',
        message: `Simulator quota rejected. EXPO_TOKEN='${f.options.expoToken}'\nAGENT_DEVICE_DAEMON_AUTH_TOKEN='${opaqueToken}'\nAGENT_DEVICE_DAEMON_BASE_URL='${privateUrl}'\nSee ${privateUrl} and wss://private-controller.example/socket?token=another-token\n${JSON.stringify(JSON.stringify({agentDeviceRemoteSessionToken: opaqueToken}))}\nhttps:\\/\\/private-controller.example\\/secret-session`,
        nextAction: privateUrl, details: { stdout: opaqueToken, dotenv: privateUrl } });
    }
    return f.options.runner(request);
  } }), error => {
    assert.equal(error.code, 'SIMULATOR_START_FAILED');
    assert.match(error.message, /Simulator quota rejected/);
    assert.equal(error.details.command, 'eas simulator:start');
    assert.equal(error.details.startCommandStatus, 'failed');
    assert.equal(error.details.allocation, 'unknown');
    assert.equal(error.details.startFailure.code, 'EAS_REQUEST_REJECTED');
    const published = JSON.stringify(serializeCiError(error));
    for (const value of [f.options.expoToken, opaqueToken, privateUrl, 'private-controller.example', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'AGENT_DEVICE_DAEMON_BASE_URL']) assert.equal(published.includes(value), false);
    assert.equal(Object.hasOwn(error.details.startFailure, 'details'), false);
    return true;
  });
  assert.equal(f.operations().includes('simulator:get'), false);
  assert.equal(f.operations().includes('simulator:stop'), false);
});

test('a successful start command with no session ID remains an uncertain handoff rather than an API rejection', async t => {
  const f = await fixture(t);
  let privateRoot;
  t.after(async () => { if (privateRoot) await rm(privateRoot, { recursive: true, force: true }); });
  await assert.rejects(runCiMap({ ...f.options, runner: request => {
    if (request.command === 'fake-eas' && request.args[0] === 'simulator:start') {
      privateRoot = request.cwd;
      return { stdout: 'The start command returned without a session handoff.', stderr: '' };
    }
    return f.options.runner(request);
  } }), error => {
    assert.equal(error.code, 'SESSION_HANDOFF_UNVERIFIED');
    assert.equal(error.details.startCommandStatus, 'completed');
    assert.equal(error.details.allocation, 'unknown');
    assert.equal(error.details.startFailure, undefined);
    return true;
  });
  assert.equal(f.operations().includes('simulator:stop'), false);
});

test('agent focused typing uses one official command, keeps secret text private, and never replays native failure', async t => {
  for (const nativeFailure of [false, true]) {
    const f = await fixture(t, { routes: [route('home')], stableLabels: true });
    const secret = 'private-typed-value';
    let keyboard = false, typeCalls = 0;
    const agent = agentFixture([]);
    agent.secretValues = [secret];
    agent.resolveInput = value => value === '{{secret:INPUT}}' ? secret : value;
    agent.provider.run = async request => {
      const call = async (name, input = {}) => JSON.parse((await request.callTool(name, input, request.signal)).content[0].text);
      await call('act', { action: 'open', url: 'sample://home' });
      await call('observe');
      assert.equal((await call('act', { action: 'tap', identifier: 'email' })).performed, 'tap');
      assert.equal((await call('observe')).focusedTypingAvailable, true);
      const typed = await call('act', { action: 'type', text: '{{secret:INPUT}}' });
      if (nativeFailure) assert.equal(typed.error.code, 'XCTEST_RECORDED_FAILURE');
      else assert.equal(typed.inputVerified, false);
      keyboard = false;
      const observed = await call('observe');
      await call('capture', { frameId: observed.frameId, targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] });
      await call('finish', { procedureSummary: 'Inspected the explicit typing result and captured home.' });
      return { inputTokens: 1, outputTokens: 1 };
    };
    await runCiMap({ ...f.options, agent, runner: request => {
      if (request.command === 'fake-controller' && request.args[0] === 'type') {
        typeCalls += 1;
        assert.deepEqual(request.args.slice(0, 5), ['type', secret, '--level', 'full', '--json']);
        return nativeFailure ? json({ success: false, error: { code: 'XCTEST_RECORDED_FAILURE', message: `May have typed ${secret}` } }) : ok({ text: secret });
      }
      if (request.command === 'fake-controller' && request.args[0] === 'press') keyboard = true;
      const result = f.options.runner(request);
      if (request.command === 'fake-controller' && request.args[0] === 'snapshot') {
        const value = JSON.parse(result.stdout);
        value.data.nodes.push({ type: 'TextField', identifier: 'email', label: 'Email', ref: 'e150', enabled: true, visible: true,
          rect: { x: 1, y: 1, width: 2, height: 1 } });
        if (keyboard) value.data.nodes.push({ type: 'Keyboard', visible: true, rect: { x: 0, y: 4, width: 4, height: 2 } });
        return json(value);
      }
      return result;
    } });
    assert.equal(typeCalls, 1);
    const trace = await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8');
    assert.equal(trace.includes(secret), false);
    assert.equal(trace.includes('{{secret:INPUT}}'), true);
    assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
  }
});

test('focused type consumes the shared mutation budget before controller dispatch', async t => {
  const f = await fixture(t, { routes: [route('home')], stableLabels: true });
  let typeCalls = 0;
  const agent = agentFixture([]);
  agent.provider.run = async request => {
    const call = (name, input = {}) => request.callTool(name, input, request.signal);
    await call('act', { action: 'open', url: 'sample://home' });
    await call('observe');
    await call('act', { action: 'tap', identifier: 'email' });
    await call('observe');
    await call('act', { action: 'type', text: 'value' });
    return { inputTokens: 1, outputTokens: 1 };
  };
  await assert.rejects(runCiMap({ ...f.options, agent, maxActions: 2, runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'type') { typeCalls += 1; return ok({}); }
    const result = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot') {
      const value = JSON.parse(result.stdout);
      value.data.nodes.push({ type: 'TextField', identifier: 'email', ref: 'e150', enabled: true, rect: { x: 1, y: 1, width: 2, height: 1 } },
        { type: 'Keyboard', rect: { x: 0, y: 4, width: 4, height: 2 } });
      return json(value);
    }
    return result;
  } }), error => error.code === 'CAPTURE_BUDGET_EXHAUSTED');
  assert.equal(typeCalls, 0);
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('deterministic setup typing resolves secrets, redacts native failures, and never replays them', async t => {
  for (const nativeFailure of [false, true]) {
    const f = await fixture(t, { routes: [route('home')], stableLabels: true });
    const secret = 'private-setup-typed-value';
    let keyboard = false, typeCalls = 0;
    const result = await runCiMap({ ...f.options, environment: { ...f.options.environment, INPUT: secret }, setup: [
      { action: 'tap', identifier: 'password' }, { action: 'type', text: '{{secret:INPUT}}' },
    ], runner: request => {
      if (request.command === 'fake-controller') {
        if (request.args[0] === 'type') {
          typeCalls++;
          assert.deepEqual(request.args.slice(0, 5), ['type', secret, '--level', 'full', '--json']);
          return nativeFailure ? json({ success: false, error: { code: 'XCTEST_RECORDED_FAILURE', message: `May have typed ${secret}` } }) : ok({});
        }
        if (request.args[0] === 'press') keyboard = true;
        if (request.args[0] === 'open') keyboard = false;
      }
      const response = f.options.runner(request);
      if (request.command === 'fake-controller' && request.args[0] === 'snapshot') {
        const value = JSON.parse(response.stdout);
        value.data.nodes.push({ type: 'SecureTextField', identifier: 'password', ref: 'e150', enabled: true, visible: true,
          rect: { x: 1, y: 1, width: 2, height: 1 } });
        if (keyboard) value.data.nodes.push({ type: 'Keyboard', visible: true, rect: { x: 0, y: 4, width: 4, height: 2 } });
        return json(value);
      }
      return response;
    } });
    assert.equal(typeCalls, 1);
    assert.equal(result.runStatus, nativeFailure ? 'partial' : 'complete');
    const bundle = await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8');
    assert.equal(bundle.includes(secret), false);
    if (nativeFailure) assert.match(bundle, /\[REDACTED\]/);
    assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
  }
});

test('deterministic typing consumes the shared mutation budget before native dispatch', async t => {
  const f = await fixture(t, { routes: [route('home')], stableLabels: true });
  let typeCalls = 0;
  const result = await runCiMap({ ...f.options, maxActions: 1, setup: [
    { action: 'tap', identifier: 'password' }, { action: 'type', text: 'fixture-input' },
  ], runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'type') { typeCalls++; return ok({}); }
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot') {
      const value = JSON.parse(response.stdout);
      value.data.nodes.push({ type: 'SecureTextField', identifier: 'password', ref: 'e150', enabled: true, visible: true,
        rect: { x: 1, y: 1, width: 2, height: 1 } }, { type: 'Keyboard', visible: true, rect: { x: 0, y: 4, width: 4, height: 2 } });
      return json(value);
    }
    return response;
  } });
  assert.equal(typeCalls, 0);
  assert.equal(result.outcomes[f.ids.home].error.code, 'CAPTURE_BUDGET_EXHAUSTED');
  assert.equal(f.operations().filter(operation => operation === 'simulator:stop').length, 1);
});

test('independent readiness rejection retains diagnostics and cannot be bypassed by changing the description', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  const agent = agentFixture([
    { action: 'capture', targetId: f.ids.home, description: 'Loaded photo.', requiredLabels: ['screen-title'] },
    { action: 'capture', targetId: f.ids.home, description: 'A plain empty page.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  let assessments = 0;
  agent.assessCapture = async request => {
    assessments++;
    assert.deepEqual(request.image, png);
    // The label the agent required is passed with the element it matched in this frame.
    assert.deepEqual(request.verifiedLabels.map(({ value, matchedField }) => ({ value, matchedField })), [{ value: 'screen-title', matchedField: 'identifier' }]);
    return { policy: 'independent-image-readiness.v3', imageSha256: (await import('node:crypto')).createHash('sha256').update(request.image).digest('hex'), ready: false, reason: 'The required photo is absent.' };
  };
  await assert.rejects(runCiMap({ ...f.options, agent, setup: [{ action: 'open', url: 'sample://home' }] }), { code: 'AGENT_TARGETS_INCOMPLETE' });
  assert.equal(assessments, 1, 'An unchanged rejected frame cannot be resubmitted under a different description');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(Object.keys(bundle.images).length, 0);
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace.filter(e => e.result.error?.code === 'AGENT_CAPTURE_NOT_READY').length, 2);
  const files = await (await import('node:fs/promises')).readdir(join(f.options.mapDirectory, 'capture-diagnostics/readiness'));
  assert.ok(files.some(f => f.endsWith('.png')));
  const receipt = JSON.parse(await readFile(join(f.options.mapDirectory, 'capture-diagnostics/readiness', files.find(f => f.endsWith('.json'))), 'utf8'));
  assert.equal(receipt.ready, false);
});

/** A Settings sheet with no navigation bar or close control, drawn 72 points below the top. */
function sheetRunner(f, { dismissible = true, sheetOrigin = 72 } = {}) {
  let path = '/', sheet = false;
  const swipes = [];
  const runner = request => {
    if (request.command === 'fake-controller') {
      const [command] = request.args;
      if (command === 'open' && request.args[2]?.startsWith('sample://')) { path = '/' + request.args[2].slice('sample://'.length); sheet = path === '/settings'; }
      if (command === 'back' && sheet) return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'in-app back control is not available' } });
      if (command === 'swipe') { swipes.push(request.args.slice(1, 5)); if (dismissible) { sheet = false; path = '/home'; } return ok({}); }
    }
    const response = f.options.runner(request);
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot') {
      const value = JSON.parse(response.stdout);
      for (const node of value.data.nodes) if (node.identifier === CAPTURE_OBSERVER_IDENTIFIER) {
        node.label = JSON.stringify({ provider: 'expo-router', pathname: path, segments: path.split('/').filter(Boolean), parameters: {} });
        node.rect = { x: 0, y: sheet ? sheetOrigin : 0, width: 1, height: 1 };
      }
      value.data.nodes.unshift({ type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 }, visible: true });
      return { ...response, stdout: JSON.stringify(value) };
    }
    return response;
  };
  return { runner, swipes };
}

test('agent back swipes down a sheet that has no in-app back control and verifies the destination changed', async t => {
  const f = await fixture(t);
  const sheet = sheetRunner(f);
  const agent = agentFixture([
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'open', url: 'sample://settings' },
    { action: 'capture', targetId: f.ids.settings, description: 'Settings sheet.', requiredLabels: ['screen-title'] },
    { action: 'back' },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, runner: sheet.runner, agent, setup: [{ action: 'open', url: 'sample://home' }] });
  assert.equal(result.runStatus, 'complete');
  assert.deepEqual(sheet.swipes, [['201', '84', '201', '787']]);
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const back = trace.find(event => event.action === 'back');
  assert.equal(back.result.performed, 'back');
  assert.equal(back.result.via, 'sheet-swipe');
  assert.deepEqual(back.observedBefore.sceneOrigin, { x: 0, y: 72 });
  assert.deepEqual(back.observedAfter.sceneOrigin, { x: 0, y: 0 });
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.captureContexts[f.ids.settings].presentation, { sceneOrigin: { x: 0, y: 72 } });
  assert.deepEqual(bundle.captureContexts[f.ids.home].presentation, { sceneOrigin: { x: 0, y: 0 } });
});

test('agent back reports a sheet that stays open, and never swipes without sheet evidence', async t => {
  const stuck = await fixture(t);
  const kept = sheetRunner(stuck, { dismissible: false });
  const stuckAgent = agentFixture([
    { action: 'capture', targetId: stuck.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'open', url: 'sample://settings' },
    { action: 'capture', targetId: stuck.ids.settings, description: 'Settings sheet.', requiredLabels: ['screen-title'] },
    { action: 'back' },
    { action: 'done' },
  ]);
  await runCiMap({ ...stuck.options, runner: kept.runner, agent: stuckAgent, setup: [{ action: 'open', url: 'sample://home' }] });
  const stuckTrace = (await readFile(join(stuck.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const failed = stuckTrace.find(event => event.action === 'back');
  assert.equal(failed.result.error.code, 'AGENT_SHEET_DISMISS_FAILED');
  assert.equal(failed.result.error.details.back.code, 'COMMAND_FAILED');
  // One retry from a fresh snapshot, then the failure is reported.
  assert.equal(kept.swipes.length, 2);
  assert.equal(failed.result.error.details.gestures.length, 2);

  const plain = await fixture(t);
  const screen = sheetRunner(plain, { sheetOrigin: 0 });
  const plainAgent = agentFixture([
    { action: 'capture', targetId: plain.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'open', url: 'sample://settings' },
    { action: 'capture', targetId: plain.ids.settings, description: 'Settings screen.', requiredLabels: ['screen-title'] },
    { action: 'back' },
    { action: 'done' },
  ]);
  await runCiMap({ ...plain.options, runner: screen.runner, agent: plainAgent, setup: [{ action: 'open', url: 'sample://home' }] });
  const plainTrace = (await readFile(join(plain.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const unavailable = plainTrace.find(event => event.action === 'back');
  assert.equal(unavailable.result.error.code, 'COMMAND_FAILED');
  assert.match(unavailable.result.error.message, /in-app back control is not available/);
  assert.equal(screen.swipes.length, 0);
});

test('agent back swipes again when the first drag moves a sheet without closing it', async t => {
  const f = await fixture(t);
  const sheet = sheetRunner(f, { dismissible: false });
  const base = sheet.runner;
  let drags = 0;
  const runner = request => {
    if (request.command === 'fake-controller' && request.args[0] === 'swipe' && ++drags === 2) {
      // The second drag closes the sheet.
      base({ ...request, args: ['open', 'com.example.app', 'sample://home'] });
    }
    return base(request);
  };
  const agent = agentFixture([
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'open', url: 'sample://settings' },
    { action: 'capture', targetId: f.ids.settings, description: 'Settings sheet.', requiredLabels: ['screen-title'] },
    { action: 'back' },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, runner, agent, setup: [{ action: 'open', url: 'sample://home' }] });
  assert.equal(result.runStatus, 'complete');
  assert.equal(sheet.swipes.length, 2);
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace.find(event => event.action === 'back').result.via, 'sheet-swipe');
});

test('sheet evidence requires a scene below the top without a navigation bar above it', () => {
  const marker = y => ({ identifier: CAPTURE_OBSERVER_IDENTIFIER, type: 'StaticText', label: '{}', rect: { x: 0, y, width: 1, height: 1 } });
  const app = { type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } };
  assert.deepEqual(sheetDismissGesture([app, marker(72)]), [201, 84, 201, 787]);
  assert.equal(sheetDismissGesture([app, marker(0)]), undefined);
  assert.equal(sheetDismissGesture([app, marker(500)]), undefined);
  assert.equal(sheetDismissGesture([marker(72)]), undefined);
  // A pushed screen below a navigation bar has the same offset, but it is not a sheet.
  assert.equal(sheetDismissGesture([app, marker(116), { type: 'NavigationBar', rect: { x: 0, y: 62, width: 402, height: 54 }, visible: true }]), undefined);
});

test('a timed-out native alert query is unknown: the snapshot decides, and it is never retried', async t => {
  const watchdog = () => json({ success: false, error: { code: 'COMMAND_FAILED', message: 'XCTest stalled on the current screen',
    details: { runnerErrorCode: 'MAIN_THREAD_TIMEOUT' } } });
  const clear = await fixture(t, { routes: [route('home')] });
  let queries = 0;
  const result = await runCiMap({ ...clear.options, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'alert' && request.args[1] === 'get') { queries += 1; return watchdog(); }
    return clear.options.runner(request);
  } });
  assert.equal(result.outcomes[clear.ids.home].status, 'captured');
  const inspections = (await readFile(join(clear.options.outputDirectory, 'capture-diagnostics/alert-inspection.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  // Setup has no expected destination, so its link and its final check ask natively, once each: the watchdog
  // answer is not replayed. The route, captured after the setup link, holds a snapshot that shows the
  // destination without an alert and skips the query.
  assert.equal(queries, 2);
  assert.deepEqual(inspections.map(entry => entry.nativeAnswer), ['unknown', 'skipped', 'unknown']);
  assert.ok(inspections.every(entry => entry.snapshotAlert === false));

  const blocked = await fixture(t, { routes: [route('home')], deepLinkAlert: { message: 'Allow notifications?', items: ['Cancel', 'Allow'] } });
  const failed = await runCiMap({ ...blocked.options, runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'alert' && request.args[1] === 'get') return watchdog();
    return blocked.options.runner(request);
  } });
  assert.equal(failed.outcomes[blocked.ids.home].status, 'failed');
  assert.equal(failed.outcomes[blocked.ids.home].error.code, 'CAPTURE_BLOCKED_BY_ALERT');
  assert.equal(blocked.operations().includes('screenshot'), false);
});

test('agent observation waits out a deferred system-surface snapshot instead of failing', async t => {
  const f = await fixture(t, { routes: [route('home')] });
  let refusals = 1, snapshots = 0;
  // The capture clock is injected: the real 3 s timer can fire with Date.now() 2999 ms along, so the
  // refused read advances the clock by the first retry delay and the recorded wait is exact.
  let now = Date.parse('2026-09-30T00:00:00Z');
  const agent = agentFixture([
    { action: 'open', url: 'sample://home' },
    { action: 'capture', targetId: f.ids.home, description: 'Loaded home.', requiredLabels: ['screen-title'] },
    { action: 'done' },
  ]);
  const result = await runCiMap({ ...f.options, agent, now: () => now, runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && ++snapshots && refusals > 0) {
      refusals -= 1;
      now += 3_000;
      // agent-device 0.21.15 while the SafariViewService password prompt is presented.
      return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'regular iOS snapshot presentation requires a valid viewport',
        details: { hint: 'com.apple.SafariViewService hosts the surface presented over the app. No snapshot backend could read this screen.' } } });
    }
    return f.options.runner(request);
  } });
  assert.equal(result.runStatus, 'complete');
  const trace = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/agent-navigation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace[0].action, 'observe');
  assert.equal(trace[0].result.error, undefined);
  const deferrals = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/accessibility-deferral.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  // Only the refused read is recorded; ordinary slow snapshots are not deferrals.
  assert.equal(deferrals.length, 1);
  assert.equal(deferrals[0].retries, 1);
  assert.equal(deferrals[0].waitedMs, 3000);
});

test('setup waits out a Save Password prompt the controller cannot read yet, then declines it', async t => {
  for (const persistent of [false, true]) {
    const f = await fixture(t, { routes: [route('home')] });
    let now = Date.parse('2026-09-30T00:00:00Z');
    let opened = false, unreadable = 0, prompt = false;
    const result = await runCiMap({ ...f.options, now: () => now, setup: [{ action: 'open', url: 'sample://home' }], runner: request => {
      if (request.command === 'fake-controller' && request.args[0] === 'wait' && /^\d+$/.test(request.args[1] ?? '')) now += Number(request.args[1]);
      if (request.command === 'fake-controller' && request.args[0] === 'open') opened = true;
      if (request.command === 'fake-controller' && request.args[0] === 'press' && /^@e200~s\d+$/.test(request.args[1])) prompt = false;
      if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && opened && (persistent || unreadable < 3)) {
        unreadable += 1;
        prompt = true;
        return unreadableSurface();
      }
      const response = f.options.runner(request);
      if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && prompt) {
        const data = JSON.parse(response.stdout).data;
        data.nodes.push({ type: 'StaticText', label: 'Save Password?', visible: true }, { type: 'Button', label: 'Not Now', ref: 'e200', enabled: true, visible: true });
        return ok(data);
      }
      return response;
    } });
    const surfaceWaits = f.requests.filter(request => request.args[0] === 'wait' && request.args[1] === '5000').length;
    const records = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/controller-retries.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.every(record => record.command === 'snapshot' && record.reason === 'unreadable-system-surface'));
    if (!persistent) {
      assert.equal(result.outcomes[f.ids.home].status, 'captured');
      assert.equal(surfaceWaits, 3);
      assert.deepEqual(records.map(record => record.attempt), [1, 2, 3]);
      const prompts = (await readFile(join(f.options.outputDirectory, 'capture-diagnostics/system-prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(prompts.map(({ prompt, action }) => ({ prompt, action })), [{ prompt: 'credential-save', action: 'Not Now' }]);
    } else {
      const error = result.outcomes[f.ids.home].error;
      assert.equal(error.code, 'SETUP_SYSTEM_SURFACE_BLOCKING');
      assert.match(error.message, /A system surface stayed in front of the app for 13\d s/);
      assert.equal(surfaceWaits, 26);
    }
  }
});

test('an Android capture builds an APK, repacks it with the SDK build-tools, and drives agent-device for android', async t => {
  const f = await fixture(t, { repack: 'local', android: true, environment: { ANDROID_HOME: '/opt/android-sdk' } });
  const result = await runCiMap(f.options);
  assert.equal(result.simulatorRuntime.deviceModel, 'Pixel 7');
  assert.equal(result.simulatorRuntime.osVersion, '15.0');
  assert.deepEqual(f.catalogRequests.map(request => request.url), [`https://web-preview-${PREVIEW_ID}.eas-simulator.ngrok.dev/api/devices`], 'the Android preview server lists emulators at /api/devices, not /grid/api');
  for (const command of ['config', 'fingerprint:generate', 'build:list', 'build', 'simulator:start']) {
    const request = f.requests.find(item => item.command === 'fake-eas' && item.args[0] === command);
    assert.equal(value(request, '--platform'), 'android', `eas ${command} targets android`);
  }
  assert.equal(f.requests.find(request => request.args[0] === 'build:list').args.includes('--simulator'), false, 'build:list --simulator is iOS-only');
  const repack = f.requests.find(request => request.command === 'fake-repack');
  assert.equal(value(repack, '--platform'), 'android');
  assert.equal(repack.environment.ANDROID_SDK_ROOT, '/opt/android-sdk', 'repack-app reads ANDROID_SDK_ROOT; ANDROID_HOME is the fallback source');
  // The repacked APK is installed through the controller, not uploaded.
  assert.match(f.requests.find(request => request.command === 'fake-controller' && request.args[0] === 'install').args[1], /app\.apk$/);
  for (const request of f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'open')) {
    assert.equal(value(request, '--platform'), 'android');
  }
  const firstOpen = f.requests.find(request => request.command === 'fake-controller' && request.args[0] === 'open');
  assert.equal(firstOpen.args.includes('--device'), false, 'the EAS AVD profile id is not an agent-device device name; the session has one booted emulator');
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.platform, 'android');
});

test('a local Android repack without an Android SDK fails before repacking', async t => {
  const f = await fixture(t, { repack: 'local', android: true });
  await assert.rejects(runCiMap(f.options), error => error.code === 'ANDROID_SDK_MISSING');
  assert.equal(f.requests.some(request => request.command === 'fake-repack'), false);
});

test('a hosted Android repack needs no Android SDK on the runner', async t => {
  const f = await fixture(t, { android: true });
  const result = await runCiMap(f.options);
  assert.equal(result.easBuildId, 'repacked-app');
  assert.equal(f.operations().includes('workflow:run'), true);
  assert.equal(f.requests.some(request => request.command === 'fake-repack'), false);
});

test('an Android capture reads alerts again while the snapshot helper restarts, and gives up after three retries', async t => {
  const f = await fixture(t, { android: true, environment: { ANDROID_SDK_ROOT: '/opt/android-sdk' }, androidHelperOffline: 2 });
  await runCiMap(f.options);
  const alertGets = f.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'alert' && request.args[1] === 'get');
  assert.ok(alertGets.length >= 3, 'the first two alert reads failed and the third succeeded');

  const stuck = await fixture(t, { android: true, environment: { ANDROID_SDK_ROOT: '/opt/android-sdk' }, androidHelperOffline: 100 });
  // A setup-time alert failure is not fatal here (the fixture's routes need no app link); the cap is what matters.
  await runCiMap(stuck.options).catch(() => undefined);
  const stuckGets = stuck.requests.filter(request => request.command === 'fake-controller' && request.args[0] === 'alert' && request.args[1] === 'get');
  // One read, then resends after 2/5/10/10… s until the next would exceed the 60 s offline budget: seven reads per inspection on the fixture clock (600 ms per round trip).
  assert.ok(stuckGets.length >= 7 && stuckGets.length % 7 === 0, `each inspection is one read plus six retries, got ${stuckGets.length}`);
});

test('launch observation relaunches once per appearance and records the splash it saw, without touching route capture', async t => {
  const f = await fixture(t, { launch: 'screenshot', splashFrames: 2, userInterfaceStyle: 'automatic' });
  await runCiMap(f.options);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.deepEqual(Object.keys(bundle.launch), ['light', 'dark']);
  for (const scheme of ['light', 'dark']) {
    const launch = bundle.launch[scheme];
    assert.equal(launch.status, 'observed');
    assert.equal(launch.source, 'screenshot', 'the fake controller cannot record, so the burst is the evidence');
    assert.equal(launch.video, undefined);
    assert.equal(launch.splash.path, `launch/${scheme}/splash.png`);
    assert.equal(launch.settled.path, `launch/${scheme}/settled.png`);
    assert.ok(launch.splashVisibleMs >= 0);
    assert.ok(Date.parse(launch.relaunchedAt) <= Date.parse(launch.settled.capturedAt));
    const splash = await readFile(join(f.options.outputDirectory, launch.splash.path));
    assert.equal(createHash('sha256').update(splash).digest('hex'), launch.splash.sha256);
    assert.equal(createHash('sha256').update(await readFile(join(f.options.outputDirectory, launch.settled.path))).digest('hex'), launch.settled.sha256);
    assert.notEqual(launch.splash.sha256, launch.settled.sha256);
  }
  const relaunches = f.requests.filter(request => request.args[0] === 'open' && request.args.includes('--relaunch'));
  assert.equal(relaunches.length, 2, 'one relaunch per appearance, before setup and route capture');
  assert.deepEqual(Object.keys(bundle.images).sort(), [f.ids.home, `${f.ids.home}@dark`, f.ids.settings, `${f.ids.settings}@dark`].sort());
  assert.equal(bundle.outcomes['launch:splash'], undefined, 'launch frames are not route evidence');
  assert.ok(f.requests.filter(request => request.args[0] === 'record').every(request => request.allowFailure), 'recording is attempted only where failure is tolerated');
});

test('a decoded launch recording exports the filmstrip and the trimmed video next to the splash frames', async t => {
  const thumb = (value, count) => Array.from({ length: count }, () => Buffer.alloc(36 * 64, value));
  const recordingTools = {
    async frames() { return [...thumb(200, 5), ...thumb(60, 20), ...thumb(240, 10)]; },
    async extractFrame(recording, seconds, width, height, output) { await writeFile(output, splashPng); },
    async normalize(recording) { await writeFile(recording, 'h264-bytes'); },
    async filmstrip(recording, indices, originMs, output) { await writeFile(output, png); },
  };
  const f = await fixture(t, { launch: 'video', recording: true, recordingTools });
  await runCiMap(f.options);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  const launch = bundle.launch.light;
  assert.equal(launch.status, 'observed');
  assert.equal(launch.source, 'recording');
  assert.equal(launch.splashVisibleMs, 2000);
  assert.equal(launch.firstScreenMs, 2000);
  assert.deepEqual(launch.filmstrip.frameTimesMs, [-500, 0, 1900, 2000]);
  assert.deepEqual((await readdir(join(f.options.outputDirectory, 'launch', 'light'))).sort(), ['filmstrip.png', 'launch.mp4', 'settled.png', 'splash.png']);
  for (const file of [launch.splash, launch.settled, launch.filmstrip, launch.video]) {
    const exported = await readFile(join(f.options.outputDirectory, file.path));
    assert.equal(createHash('sha256').update(exported).digest('hex'), file.sha256, `${file.path} is exported byte for byte`);
  }
});

test('a launch faster than the first screenshot is reported as not observed with its settled frame', async t => {
  const f = await fixture(t, { launch: 'video' });
  await runCiMap(f.options);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  const launch = bundle.launch.light;
  assert.equal(launch.status, 'not-observed');
  assert.equal(launch.splash, undefined);
  assert.equal(launch.splashVisibleMs, undefined);
  assert.equal(launch.video, undefined, 'no recording exists when the controller cannot record');
  assert.equal(launch.settled.path, 'launch/light/settled.png');
  assert.deepEqual(await readdir(join(f.options.outputDirectory, 'launch', 'light')), ['settled.png'], 'burst frames do not leak into the export');
});

test('launch observation stays off unless requested, so direct capture never relaunches', async t => {
  const f = await fixture(t);
  await runCiMap(f.options);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.launch, undefined);
});

const readinessLog = async (f, id) => (await readFile(join(f.options.mapDirectory, 'capture-diagnostics', 'readiness.jsonl'), 'utf8'))
  .trim().split('\n').map(line => JSON.parse(line)).filter(line => line.route === id);

test('readiness is a wall-clock budget from the link open: 8 s on iOS, 10 s on Android, half as much again on the retry, no per-poll controller waits', async t => {
  for (const [android, budgetMs] of [[false, 8000], [true, 10000]]) {
    const f = await fixture(t, { markerMismatch: true, ...(android ? { android: true } : {}) });
    const result = await runCiMap(f.options);
    assert.equal(result.outcomes[f.ids.home].observed.reason, 'landing-mismatch');
    assert.equal(f.requests.some(request => request.args[0] === 'wait' && request.args[1] === '250'), false, 'polling pauses host-side, not through the controller');
    const home = await readinessLog(f, f.ids.home);
    assert.deepEqual(home.map(line => [line.attempt, line.budgetMs, line.outcome]),
      [[1, budgetMs, 'ROUTE_LANDING_MISMATCH'], [2, budgetMs * 1.5, 'ROUTE_LANDING_MISMATCH']]);
    for (const line of home) {
      assert.ok(line.polls >= 3, 'at least three snapshots before giving up');
      assert.ok(line.elapsedMs >= line.budgetMs && line.elapsedMs < line.budgetMs * 2, `gave up at ${line.elapsedMs} ms of ${line.budgetMs}`);
      assert.equal(line.extended, false);
    }
    const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
    assert.equal(bundle.procedure.readinessSeconds, budgetMs / 1000);
  }
});

test('a screen still changing when the readiness budget runs out is not settled, after extending to twice the budget', async t => {
  const f = await fixture(t, { markerMismatch: true, unsettled: true });
  const result = await runCiMap(f.options);
  assert.equal(result.outcomes[f.ids.home].error.code, 'CAPTURE_NOT_SETTLED');
  assert.match(result.outcomes[f.ids.home].error.message, /kept changing for \d+ s/);
  const home = await readinessLog(f, f.ids.home);
  assert.equal(home.length, 2);
  for (const line of home) {
    assert.equal(line.extended, true);
    assert.ok(line.elapsedMs >= line.budgetMs * 2, `extended to ${line.elapsedMs} ms of ${line.budgetMs}`);
    assert.equal(line.outcome, 'CAPTURE_NOT_SETTLED');
  }
});

test('capture.readinessSeconds overrides the readiness budget and is recorded with the procedure', async t => {
  const f = await fixture(t, { markerMismatch: true });
  const result = await runCiMap({ ...f.options, readinessSeconds: 3 });
  assert.equal(result.outcomes[f.ids.home].observed.reason, 'landing-mismatch');
  const home = await readinessLog(f, f.ids.home);
  assert.deepEqual(home.map(line => line.budgetMs), [3000, 4500]);
  const bundle = JSON.parse(await readFile(join(f.options.outputDirectory, 'bundle.json'), 'utf8'));
  assert.equal(bundle.procedure.readinessSeconds, 3);
  const healthy = await fixture(t);
  const landed = await runCiMap({ ...healthy.options, readinessSeconds: 3 });
  assert.equal(landed.outcomes[healthy.ids.home].status, 'captured');
  assert.ok((await readinessLog(healthy, healthy.ids.home)).every(line => line.outcome === 'landed' && line.elapsedMs < 3000));
});

test('controller recovery time is not charged to the app\'s readiness budget', async t => {
  const f = await fixture(t, { markerMismatch: true });
  let refusals = 2, inRoute = false;
  const result = await runCiMap({ ...f.options, runner: request => {
    if (request.command === 'fake-controller' && request.args[0] === 'open' && request.args[2] === 'sample://home') inRoute = true;
    if (request.command === 'fake-controller' && request.args[0] === 'snapshot' && inRoute && refusals-- > 0) {
      return busyRead();
    }
    return f.options.runner(request);
  } });
  assert.equal(result.outcomes[f.ids.home].observed.reason, 'landing-mismatch');
  const [first] = await readinessLog(f, f.ids.home);
  assert.ok(first.recoveryMs > 0, 'the busy backoff was waited for');
  assert.ok(first.elapsedMs >= first.budgetMs && first.elapsedMs < first.budgetMs * 2, `the app still got its ${first.budgetMs} ms: ${JSON.stringify(first)}`);
});

test('a verified label is located on the image\'s axes when the screenshot is the portrait screen turned a quarter clockwise', async () => {
  const { verifiedCaptureLabels } = await import('../../dist/capture/route-capture.js');
  const nodes = [{ type: 'Button', label: 'Done', rect: { x: 10, y: 900, width: 100, height: 40 } }];
  // On the screen's own axes the bounds are as the tree gives them.
  assert.deepEqual(verifiedCaptureLabels(nodes, ['Done'])[0].rect, { x: 10, y: 900, width: 100, height: 40 });
  // A 669 x 951 portrait panel captured upright as a 951 x 669 image: the button near its bottom-left is near the image's top-left.
  assert.deepEqual(verifiedCaptureLabels(nodes, ['Done'], { height: 951 })[0].rect, { x: 11, y: 10, width: 40, height: 100 });
});
