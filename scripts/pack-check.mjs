#!/usr/bin/env node
// What `npm publish` would ship, without running prepack: CI builds dist and verifies the hosted
// export in their own jobs, so the pack check only has to prove the `files` list still resolves to
// a complete package. Prepack's shrinkwrap copy is made and removed here the same way.
import { execFileSync } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";

const required = ["action.yml", "npm-shrinkwrap.json", "dist/cli.js", "dist/viewer/index.html", "schema/", "templates/", "skills/explore-setup/SKILL.md", "skills/explore-binary/SKILL.md", "docs/"];
await copyFile("package-lock.json", "npm-shrinkwrap.json");
try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
  const paths = pack.files.map(file => file.path);
  const missing = required.filter(entry => entry.endsWith("/") ? !paths.some(path => path.startsWith(entry)) : !paths.includes(entry));
  if (missing.length) {
    console.error(`The package would ship without: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`${pack.name}@${pack.version}: ${pack.entryCount} files, ${(pack.unpackedSize / 1e6).toFixed(1)} MB unpacked`);
} finally {
  await rm("npm-shrinkwrap.json", { force: true });
}
