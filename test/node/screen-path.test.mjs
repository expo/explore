import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { displayPathForScreen } = await tsImport("../../viewer/src/utils/screen-path.ts", import.meta.url);

test("uses recorded Expo Router paths without changing route groups or parameters", () => {
  assert.equal(
    displayPathForScreen({ title: "Profile", route: "/(tabs)/profile/[id]" }),
    "/(tabs)/profile/[id]",
  );
  assert.equal(displayPathForScreen({ title: "Settings", route: "settings" }), "/settings");
});

test("turns Mobbin inventory routes into stable page paths instead of capture numbers", () => {
  assert.equal(
    displayPathForScreen({ title: "Home — Active financial tools", route: "/mobbin/screens/52" }),
    "/home",
  );
  assert.equal(
    displayPathForScreen({ title: "Help Center", route: "/mobbin/jan-2024/screens/100" }),
    "/help-center",
  );
  assert.equal(
    displayPathForScreen({ title: "Cards & Spending — Empty", route: "/mobbin/screens/9" }),
    "/cards-and-spending",
  );
});

test("provides a readable fallback when a non-Expo source has no route", () => {
  assert.equal(displayPathForScreen({ title: "Requesting a completed form — Direct deposit" }), "/requesting-a-completed-form");
});
