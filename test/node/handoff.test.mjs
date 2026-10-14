import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { claudeDeepLink, codexDeepLink, handoffPageUrl, handoffPrompt } = await tsImport("../../viewer/src/utils/handoff.ts", import.meta.url);

const TOKEN = "exwitrhlayedwcxt7ogiwauyiugp4vpk";

test("only a hosted preview has a link an agent can fetch", () => {
  assert.equal(
    handoffPageUrl(new URL(`https://app-explore--abc.expo.app/p/${TOKEN}?platform=android&screen=x#/map`)),
    `https://app-explore--abc.expo.app/p/${TOKEN}?platform=android`,
  );
  assert.equal(handoffPageUrl(new URL(`https://app-explore--abc.expo.app/p/${TOKEN}/`)), `https://app-explore--abc.expo.app/p/${TOKEN}`);
  assert.equal(handoffPageUrl(new URL("http://127.0.0.1:4319/#/map")), undefined);
  assert.equal(handoffPageUrl(new URL("https://explore.expo.app/r?repo=a/b&run=1&attempt=1")), undefined);
});

const input = {
  pageUrl: `https://app-explore--abc.expo.app/p/${TOKEN}?platform=android`,
  appName: "euxy",
  pullRequest: { number: 153, title: "Splash", url: "https://github.com/brentvatne/euxy/pull/153", base: { ref: "main" }, head: { ref: "x" } },
  appearances: ["Light", "Dark"],
};

test("the prompt names the pull request, links the report and asks for both appearances", () => {
  const prompt = handoffPrompt(input);
  assert.match(prompt, /^Review the visual changes in PR #153 of brentvatne\/euxy\.\n/);
  assert.ok(prompt.includes(`\n${input.pageUrl}\n`));
  assert.ok(prompt.includes("screenshots in light and dark"));
  assert.ok(!prompt.includes("I'm looking at"));
});

test("the scoped prompt ends with what the reader is looking at", () => {
  const prompt = handoffPrompt(input, { view: "Screens", platform: "Android", appearance: "Light", screen: "/new-pattern" });
  assert.match(prompt, /\n\nI'm looking at: \/new-pattern · Screens · Android · Light$/);
});

test("a report without a pull request is reviewed by app name, in one appearance without the clause", () => {
  const prompt = handoffPrompt({ ...input, pullRequest: undefined, appearances: ["Light"] });
  assert.match(prompt, /^Review this Expo Explore report of euxy\./);
  assert.ok(prompt.includes("compare the before and after screenshots, and"));
});

test("deep links carry the encoded prompt", () => {
  assert.equal(claudeDeepLink("a & b\nc"), "claude-cli://open?q=a%20%26%20b%0Ac");
  assert.equal(codexDeepLink("a & b\nc"), "codex://new?prompt=a%20%26%20b%0Ac");
});
