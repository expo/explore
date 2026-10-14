import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeRouteName } from "../../dist/contracts/source-route-title.js";

test("route segments read as reviewer-facing titles", () => {
  assert.equal(humanizeRouteName("atms"), "ATMs");
  assert.equal(humanizeRouteName("Atms"), "ATMs");
  assert.equal(humanizeRouteName("topup"), "Top-up");
  assert.equal(humanizeRouteName("index"), "Root");
  assert.equal(humanizeRouteName("forgotPassword"), "Forgot password");
  assert.equal(humanizeRouteName("sign-in"), "Sign in");
  assert.equal(humanizeRouteName("verify_otp"), "Verify OTP");
  assert.equal(humanizeRouteName("(app)"), "App");
  assert.equal(humanizeRouteName("Onboarding"), "Onboarding");
});

test("prose titles keep their words", () => {
  assert.equal(humanizeRouteName("Send money"), "Send money");
  assert.equal(humanizeRouteName("Find an ATM"), "Find an ATM");
  assert.equal(humanizeRouteName("Other"), "Other");
  assert.equal(humanizeRouteName(""), "");
});
