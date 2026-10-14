import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const workspace = process.cwd();
const output = resolve(workspace, "dist");

if (dirname(output) !== workspace) {
  throw new Error(`Refusing to clean unexpected output path: ${output}`);
}

// The hosted Viewer export is built separately (npm run build:hosting:preview) and takes minutes; a CLI rebuild keeps it.
const keep = new Set(["hosting-preview"]);
for (const entry of await readdir(output).catch(() => [])) {
  if (!keep.has(entry)) await rm(resolve(output, entry), { recursive: true, force: true });
}
