#!/usr/bin/env node
// npm never publishes package-lock.json, but it installs a package's npm-shrinkwrap.json.
// Packing copies the lockfile so CI's `npm install @expo/explore@<version>` resolves the
// exact dependency tree this repository tested, then removes the copy.
import { copyFile, rm } from "node:fs/promises";

if (process.argv.includes("--remove")) await rm("npm-shrinkwrap.json", { force: true });
else await copyFile("package-lock.json", "npm-shrinkwrap.json");
