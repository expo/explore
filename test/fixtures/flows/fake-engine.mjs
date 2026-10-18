// A two-screen app for the flows worker: Home (a Send button) and Contacts (a heading and one contact).
import { defineEngine, resolveExpression } from "e2e/engine";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const screens = {
  home: [{ ref: { id: "send", revision: "1" }, role: "button", name: "Send", testId: "home-send", rect: { x: 0, y: 0, width: 100, height: 40 } }],
  contacts: [
    { ref: { id: "title", revision: "2" }, role: "heading", name: "Your contacts", rect: { x: 0, y: 0, width: 100, height: 40 } },
    { ref: { id: "alex", revision: "2" }, role: "button", name: "Alex Rivera", rect: { x: 0, y: 50, width: 100, height: 40 } },
  ],
};

export function engine() {
  let screen = "home";
  let attemptDir = "";
  let shots = 0;
  const root = () => ({ ref: { id: "root", revision: screen }, role: "window", children: screens[screen] });
  return defineEngine({
    name: "fake-device", version: "0.0.1", spiVersion: 1, platform: "fake",
    async startAttempt(info) { attemptDir = info.artifactsDir; screen = "home"; shots = 0; },
    async observe() { return { root: root(), viewport: { width: 100, height: 100 } }; },
    async locate(expression) { return resolveExpression(expression, [root()]); },
    actions: ["tap"],
    async perform(ref) { if (ref.id === "send") screen = "contacts"; },
    session: { async restart() { screen = "home"; } },
    artifacts: { async screenshot() {
      shots += 1;
      const path = `screenshots/${String(shots).padStart(3, "0")}.png`;
      mkdirSync(join(attemptDir, "screenshots"), { recursive: true });
      writeFileSync(join(attemptDir, path), PNG);
      return path;
    } },
  });
}
