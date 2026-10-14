import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const workspace = process.cwd();
const cli = resolve(workspace, "dist", "cli.js");

if (dirname(dirname(cli)) !== workspace) {
  throw new Error(`Refusing to change mode for unexpected CLI path: ${cli}`);
}

await chmod(cli, 0o755);
