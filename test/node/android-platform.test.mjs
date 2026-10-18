import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { validateExploreConfig } = await tsImport("../../src/config/explore-config.ts", import.meta.url);
const { simulatorProfiles } = await tsImport("../../src/config/setup.ts", import.meta.url);
const { assertCaptureEasProfile } = await tsImport("../../src/capture/eas-build.ts", import.meta.url);
const { assertSimulatorSessionIdentity } = await tsImport("../../src/capture/simulator.ts", import.meta.url);
const { openedSimulatorDevice } = await tsImport("../../src/capture/controller.ts", import.meta.url);
const { CONTROLLER_SESSION } = await tsImport("../../src/capture/common.ts", import.meta.url);
const { renderPublicComment } = await tsImport("../../src/report/pr-comment-body.ts", import.meta.url);
const { viewerLinks } = await tsImport("../../src/report/viewer-links.ts", import.meta.url);

const config = (platform) => ({
  mode: "deterministic",
  app: { platform, bundleId: "dev.brent.euxy", easProfile: "explore" },
  navigation: { provider: "expo-router" },
  device: { name: platform === "android" ? "pixel_7" : "iPhone 17" },
  exploration: { scope: "changes" },
  capture: { maxMinutes: 30, maxActions: 500 },
});

test("config accepts app.platform android and keeps ios as the default", () => {
  assert.equal(validateExploreConfig(config("android")).app.platform, "android");
  assert.equal(validateExploreConfig(config("ios")).app.platform, "ios");
  const unset = config("ios");
  delete unset.app.platform;
  assert.equal(validateExploreConfig(unset).app.platform, "ios");
  assert.throws(() => validateExploreConfig(config("web")), /app\.platform/);
});

test("Android capture profiles build an APK without a development client", () => {
  const eas = { build: {
    base: { distribution: "internal" },
    explore: { extends: "base", android: { buildType: "apk" } },
    store: { distribution: "store" },
    aab: { distribution: "internal", android: { buildType: "app-bundle" } },
    dev: { extends: "explore", developmentClient: true },
    simulator: { ios: { simulator: true } },
  } };
  assert.deepEqual(simulatorProfiles(eas, "android").sort(), ["base", "explore"]);
  assert.deepEqual(simulatorProfiles(eas), ["simulator"]);
  assert.throws(() => simulatorProfiles({ build: { a: { extends: "b" }, b: { extends: "a" } } }, "android"), /Circular/);
});

test("EAS profile errors name the side and commit that resolved them", () => {
  const appConfig = { android: { package: "dev.brent.euxy" }, ios: { bundleIdentifier: "dev.brent.euxy" } };
  const base = { side: "base", commit: "a".repeat(40) };
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { distribution: "store" } }, "dev.brent.euxy", "android", base), error =>
    error.code === "EAS_PROFILE_NOT_SIMULATOR" && error.message.includes("at the base commit aaaaaaaa does not produce an Android emulator APK")
      && error.nextAction.includes("on the default branch (the base side is built from its own checkout)"));
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { simulator: false } }, "dev.brent.euxy", "ios", { side: "head", commit: "b".repeat(40) }), error =>
    error.message.includes("at the head commit bbbbbbbb does not produce an iOS Simulator application") && error.nextAction === "Set ios.simulator: true on the selected profile in eas.json, then rerun Explore.");
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { buildType: "apk" } }, "dev.other.app", "android", base), error =>
    error.code === "APP_BUNDLE_ID_MISMATCH" && error.message.includes("resolved at the base commit aaaaaaaa") && /default branch first/.test(error.nextAction));
  // Without a source (doctor) the wording is unchanged.
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { simulator: false } }, "dev.brent.euxy"), error =>
    error.message === "The selected EAS build profile does not produce an iOS Simulator application.");
});

test("the resolved Android EAS profile must produce an APK for the configured package", () => {
  const appConfig = { android: { package: "dev.brent.euxy" }, ios: { bundleIdentifier: "dev.brent.euxy" } };
  assertCaptureEasProfile({ appConfig, buildProfile: { distribution: "internal", buildType: "apk" } }, "dev.brent.euxy", "android");
  assertCaptureEasProfile({ appConfig, buildProfile: { distribution: "internal" } }, "dev.brent.euxy", "android");
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { distribution: "store" } }, "dev.brent.euxy", "android"),
    error => error.code === "EAS_PROFILE_NOT_SIMULATOR");
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { distribution: "internal", developmentClient: true } }, "dev.brent.euxy", "android"),
    error => error.code === "EAS_PROFILE_NOT_SIMULATOR");
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { buildType: "apk" } }, "dev.other.app", "android"),
    error => error.code === "APP_BUNDLE_ID_MISMATCH");
  // iOS validation is unchanged: an APK profile is not a simulator profile.
  assert.throws(() => assertCaptureEasProfile({ appConfig, buildProfile: { buildType: "apk" } }, "dev.brent.euxy"),
    error => error.code === "EAS_PROFILE_NOT_SIMULATOR");
});

test("the Android controller open response is accepted only for the Android platform", () => {
  // Shape observed from agent-device 0.21.15 against an EAS Android emulator session.
  const response = JSON.stringify({ success: true, data: {
    session: CONTROLLER_SESSION, appName: "dev.brent.euxy", appBundleId: "dev.brent.euxy", appId: "dev.brent.euxy",
    device: { platform: "android", target: "mobile", id: "emulator-5554", name: "EasAndroidDevice01",
      identifiers: { deviceId: "emulator-5554", deviceName: "EasAndroidDevice01", serial: "emulator-5554" }, android: { serial: "emulator-5554" } },
    identifiers: { session: CONTROLLER_SESSION, deviceId: "emulator-5554", deviceName: "EasAndroidDevice01", serial: "emulator-5554",
      appId: "dev.brent.euxy", appBundleId: "dev.brent.euxy" },
  } });
  assert.deepEqual(openedSimulatorDevice(response, "dev.brent.euxy", "open", "android"), { deviceId: "emulator-5554", deviceModel: "EasAndroidDevice01" });
  assert.throws(() => openedSimulatorDevice(response, "dev.brent.euxy", "open"), /full ios device shape/);
  assert.throws(() => openedSimulatorDevice(response, "dev.brent.euxy", "open", "ios"), /full ios device shape/);
});

test("the PR comment names the Android target while it captures", () => {
  const pullRequest = { repositoryId: "1", repository: "expo/explore-playground", number: 1, title: "Android", url: "https://github.com/expo/explore-playground/pull/1",
    base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "android", sha: "b".repeat(40) } };
  const body = renderPublicComment({
    phase: "capturing", pullRequest, mode: "changes", executionMode: "deterministic", configPath: ".expo-explore/config.yaml",
    links: viewerLinks({ repository: pullRequest.repository, headSha: pullRequest.head.sha, runId: "42", runAttempt: "1", configPath: ".expo-explore/config.yaml" }),
    startedAt: Date.parse("2026-09-11T03:00:48Z"), updatedAt: Date.parse("2026-09-11T03:07:00Z"),
    build: { appName: "euxy", appVersion: "1.2.0", appBuildNumber: "1", platform: "android", easProfile: "explore", easBuildId: "eas-build", reusedEasBuild: true },
    runtime: { provider: "eas-simulator", controller: "agent-device", controllerPackageVersion: "0.21.15", easCliVersion: "24.12.1", platform: "android",
      deviceModel: "EasAndroidDevice01", osVersion: "35", locale: "en-US", orientation: "portrait", colorScheme: "light" },
    capture: { planned: { base: 3, head: 3 }, done: { base: 0, head: 1 }, baseFromCache: false },
  });
  assert.match(body, /^### Explore review · capturing$/m);
  assert.match(body, /^Android · capturing head 1\/3 · \[run\]\(<[^>]+>\)$/m);
  assert.doesNotMatch(body, /iOS/);
});

test("an Android EAS Simulator session proves its identity for the Android platform only", () => {
  const session = { id: "01a124bc-bce6-7d04-bf47-a87f41f28339", name: "Explore map: euxy [c_DJk2lOZSVuvYQCv0Fq]", type: "agent-device",
    status: "IN_PROGRESS", platform: "ANDROID",
    deviceRunSessionUrl: "https://expo.dev/accounts/brent-org/projects/euxy/simulator-sessions/01a124bc-bce6-7d04-bf47-a87f41f28339" };
  const project = { owner: "brent-org", slug: "euxy", projectId: "project", name: "euxy" };
  assertSimulatorSessionIdentity(JSON.stringify(session), session.id, session.name, project, undefined, "android");
  assert.throws(() => assertSimulatorSessionIdentity(JSON.stringify(session), session.id, session.name, project, undefined, "ios"), /exact expected simulator session/);
  assert.throws(() => assertSimulatorSessionIdentity(JSON.stringify(session), session.id, session.name, project), /exact expected simulator session/);
  assert.throws(() => assertSimulatorSessionIdentity(JSON.stringify({ ...session, platform: "IOS" }), session.id, session.name, project, undefined, "android"),
    /exact expected simulator session/);
});
