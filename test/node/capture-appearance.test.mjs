import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { resolveColorSchemes, parseAppearance, schemeScreenId, routeIdOfScreen, appearanceArgs, mergeSchemeOutcomes } =
  await tsImport("../../src/capture/appearance.ts", import.meta.url);

test("auto follows the app's userInterfaceStyle, light when it declares none", () => {
  assert.deepEqual(resolveColorSchemes("auto", { userInterfaceStyle: "automatic" }, "ios"), ["light", "dark"]);
  assert.deepEqual(resolveColorSchemes("auto", { userInterfaceStyle: "dark" }, "ios"), ["dark"]);
  assert.deepEqual(resolveColorSchemes("auto", { userInterfaceStyle: "light" }, "ios"), ["light"]);
  assert.deepEqual(resolveColorSchemes("auto", {}, "android"), ["light"]);
  assert.deepEqual(resolveColorSchemes("auto", undefined, "ios"), ["light"]);
});

test("auto prefers the platform's own userInterfaceStyle", () => {
  assert.deepEqual(resolveColorSchemes("auto", { userInterfaceStyle: "automatic", android: { userInterfaceStyle: "dark" } }, "android"), ["dark"]);
  assert.deepEqual(resolveColorSchemes("auto", { userInterfaceStyle: "automatic", android: { userInterfaceStyle: "dark" } }, "ios"), ["light", "dark"]);
});

test("an explicit appearance wins over the app config, first scheme primary", () => {
  assert.deepEqual(resolveColorSchemes(["dark", "light"], { userInterfaceStyle: "light" }, "ios"), ["dark", "light"]);
  assert.deepEqual(resolveColorSchemes(["dark", "dark"], { userInterfaceStyle: "automatic" }, "ios"), ["dark"]);
});

test("parseAppearance accepts auto, one scheme, or a list, and rejects anything else", () => {
  assert.equal(parseAppearance(undefined, "capture.appearance"), "auto");
  assert.equal(parseAppearance("auto", "capture.appearance"), "auto");
  assert.deepEqual(parseAppearance("dark", "capture.appearance"), ["dark"]);
  assert.deepEqual(parseAppearance(["light", "dark", "light"], "capture.appearance"), ["light", "dark"]);
  for (const bad of ["system", [], ["dark", "sepia"], 1]) {
    assert.throws(() => parseAppearance(bad, "capture.appearance"), /capture\.appearance must be "auto", "dark", "light", or a list of those/);
  }
});

test("secondary schemes suffix the route's screen id and map back to the route", () => {
  assert.equal(schemeScreenId("route:/settings", undefined), "route:/settings");
  assert.equal(schemeScreenId("route:/settings", "dark"), "route:/settings@dark");
  assert.deepEqual(routeIdOfScreen("route:/settings@dark"), { routeId: "route:/settings", scheme: "dark" });
  assert.deepEqual(routeIdOfScreen("route:/settings"), { routeId: "route:/settings" });
  assert.deepEqual(routeIdOfScreen("user@example"), { routeId: "user@example" });
  assert.deepEqual(appearanceArgs("light"), ["settings", "appearance", "light"]);
});

test("a secondary appearance pass that failed leaves the primary frame and marks only <route>@<scheme> unavailable", () => {
  const captured = { status: "captured", attempts: 1, landing: "verified", screenshotSha256: "a".repeat(64) };
  const failed = { status: "failed", attempts: 2, landing: "unverified", reason: "no dark" };
  const merged = mergeSchemeOutcomes([
    { ok: captured, broken: captured, onlyFirst: { ...captured, attempts: 2 }, neverLanded: failed },
    { ok: { ...captured, screenshotSha256: "b".repeat(64) }, broken: failed, neverLanded: failed },
  ], ["light", "dark"]);
  assert.deepEqual(merged.ok, captured);
  assert.deepEqual(merged.broken, { ...captured, attempts: 2 });
  assert.deepEqual(merged["broken@dark"], failed);
  assert.deepEqual(merged.onlyFirst, { ...captured, attempts: 2 });
  assert.deepEqual(merged.neverLanded, failed, "a route the primary pass never captured keeps its own failure");
  assert.equal(merged["neverLanded@dark"], undefined);
});

test("a secondary pass's unattributed frame is kept under <route>@<scheme> when the route has a primary frame, else reported as its miss", () => {
  const captured = { status: "captured", attempts: 1, landing: "verified", screenshotSha256: "a".repeat(64) };
  const unattributed = { status: "captured", attempts: 2, landing: "unverified", reason: "Expected /p; the app showed /patterns on both attempts.",
    observed: { reason: "landing-mismatch", route: "/patterns", attempts: 2 }, screenshotSha256: "b".repeat(64) };
  const failed = { status: "failed", attempts: 2, landing: "unverified", reason: "never landed" };
  const merged = mergeSchemeOutcomes([{ p: captured, lost: failed }, { p: unattributed, lost: unattributed }], ["light", "dark"]);
  assert.deepEqual(merged.p, { ...captured, attempts: 2 }, "the primary frame stays, with the larger attempt count");
  assert.deepEqual(merged["p@dark"], unattributed, "the dark frame stays, marked unattributed");
  assert.equal(merged["lost@dark"], undefined);
  assert.equal(merged.lost.status, "failed", "without a primary frame there is no slot for the dark one");
  assert.equal(merged.lost.screenshotSha256, undefined);
  assert.equal(merged.lost.error.code, "ROUTE_LANDING_MISMATCH");
  assert.equal(merged.lost.reason, unattributed.reason);
});

test("without scheme names, a failed pass fails the route (legacy merge)", () => {
  const captured = { status: "captured", attempts: 1, landing: "verified", screenshotSha256: "a".repeat(64) };
  const failed = { status: "failed", attempts: 2, landing: "unverified", reason: "no light" };
  assert.deepEqual(mergeSchemeOutcomes([{ broken: captured }, { broken: failed }]).broken, failed);
});

test("a route the primary pass lost keeps its verified secondary frame under <id>@<scheme>", () => {
  const captured = { status: "captured", attempts: 1, landing: "verified", screenshotSha256: "a".repeat(64) };
  const failed = { status: "failed", attempts: 1, landing: "unverified", reason: "Configured UI prerequisites did not complete." };
  const merged = mergeSchemeOutcomes([{ p: failed, q: failed }, { p: { ...captured, screenshotSha256: "b".repeat(64) }, q: failed }], ["light", "dark"]);
  assert.deepEqual(merged.p, failed, "the primary appearance stays unavailable");
  assert.deepEqual(merged["p@dark"], { ...captured, screenshotSha256: "b".repeat(64) }, "the dark frame is published on its own");
  assert.deepEqual(merged.q, failed);
  assert.equal(merged["q@dark"], undefined, "two failures stay one failure");
  assert.equal(Object.keys(mergeSchemeOutcomes([{ p: failed }, { p: captured }]))["p@dark"], undefined, "no scheme list, no secondary slot");
});

test("a note on a verified frame of another appearance stays with the route its primary frame is published under", () => {
  const captured = { status: "captured", attempts: 1, landing: "verified", screenshotSha256: "a".repeat(64) };
  const incomplete = "Setup did not complete: a setup step stopped twice (RUNNER_WEDGED), so this route was opened by app link without the state the remaining setup steps prepare.";
  const merged = mergeSchemeOutcomes([{ p: captured, q: { ...captured, reason: "Already noted." } }, { p: { ...captured, reason: incomplete }, q: captured }], ["light", "dark"]);
  assert.equal(merged.p.reason, `In dark: ${incomplete}`);
  assert.equal(merged.p.status, "captured");
  assert.equal(merged.q.reason, "Already noted.", "a pass without a note adds none");
  assert.equal(merged["p@dark"], undefined, "the dark frame is still published under the route, as before");
});
