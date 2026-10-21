import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A fake EAS accepts any flag, so a flag the pinned eas-cli does not have passes every other test and fails only on a
// real runner: 0.20.6 sent `env:list --non-interactive`, which eas-cli 25.2.0 refuses, so every capture logged "EAS did
// not list the development environment's variables" and never shared a repack (brentvatne/euxy review run 39517635857).
// Every literal `eas` command in src is checked against the command manifest of the eas-cli package.json pins.
const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(await readFile(createRequire(join(root, "package.json")).resolve("eas-cli/oclif.manifest.json"), "utf8")).commands;
const commands = new Map();
for (const [id, command] of Object.entries(manifest)) {
  commands.set(id, command);
  for (const alias of command.aliases ?? []) commands.set(alias, command);
}

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("every literal eas command in src names a flag the pinned eas-cli has", async () => {
  const checked = new Set();
  const unknown = [];
  for (const file of await sources(join(root, "src"))) {
    const text = await readFile(file, "utf8");
    // An argument list that starts with a command id, up to its closing bracket.
    for (const match of text.matchAll(/\[\s*"([a-z]+(?::[a-z-]+)+)"([^\]]*)\]/g)) {
      const command = commands.get(match[1]);
      if (!command) continue; // Explore's own commands (source:verify, explore:binary, …) share the shape.
      checked.add(match[1]);
      const flags = command.flags ?? {};
      for (const flag of match[2].matchAll(/"--([a-z0-9-]+)(?:=[^"]*)?"/g)) {
        if (!(flag[1] in flags)) unknown.push(`${relative(root, file)}: eas ${match[1]} --${flag[1]}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
  // The scan finds the commands capture depends on, so it cannot pass by matching nothing.
  for (const id of ["env:list", "build:list", "build:view", "workflow:run", "workflow:view", "workflow:cancel", "simulator:start", "simulator:stop", "simulator:control"]) {
    assert.ok(checked.has(id), `eas ${id} was not found in src`);
  }
});
