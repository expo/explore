import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The Explore package that runs this code: a checkout or an npm install. */
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(TOOL_ROOT, "package.json"), "utf8")) as { name: string; version: string };
/** The exact package spec that CI installs, such as @expo/explore@0.1.0. */
export const EXPLORE_PACKAGE = `${manifest.name}@${manifest.version}`;
export const EXPLORE_VERSION = manifest.version;

/** The node_modules directory that holds a dependency: nested in a checkout, hoisted in an npm install. */
function modulesDirectory(name: string): string {
  const directory = (require.resolve.paths(name) ?? []).find(candidate => existsSync(join(candidate, name, "package.json")));
  if (!directory) throw new Error(`${name} is not installed. Reinstall @expo/explore.`);
  return directory;
}

/** A file inside an installed dependency. */
export function packageFile(name: string, path: string): string {
  return join(modulesDirectory(name), name, path);
}

/** The executable npm links for a dependency's bin. */
export function packageBin(name: string, bin: string): string {
  return join(modulesDirectory(name), ".bin", bin);
}
