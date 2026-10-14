import { lstat, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, sep, isAbsolute, resolve } from "node:path";
import { parseJson } from "./common.js";

const MAX_CI_CONTRACT_FILE_BYTES = 5 * 1024 * 1024;

export async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}


export async function temporaryCaptureDirectory(project: string, value: string, name: string): Promise<string> {
  const roots = await Promise.all([tmpdir(), process.env.RUNNER_TEMP].filter(
    (path): path is string => Boolean(path),
  ).map((path) => realpath(path)));
  const candidate = resolve(value);
  const root = roots.find((path) => candidate !== path && isWithin(path, candidate));
  if (!isAbsolute(value) || !root || isWithin(project, candidate)) {
    throw new Error(`${name} must be an absolute temporary path outside the project`);
  }
  await assertNoSymlinkAncestors(root, candidate, name);
  return candidate;
}


export function absoluteContractFile(value: string, name: string): string {
  if (
    !value
    || !isAbsolute(value)
    || resolve(value) !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} must be a normalized absolute file path`);
  }
  return value;
}

export async function readContractJson(
  path: string,
  name: string,
  requireCurrentOwner: boolean,
): Promise<unknown> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${name} must be a regular non-symlink file`);
  }
  if (info.size <= 0 || info.size > MAX_CI_CONTRACT_FILE_BYTES) {
    throw new Error(`${name} must be non-empty and no larger than ${MAX_CI_CONTRACT_FILE_BYTES} bytes`);
  }
  if (
    requireCurrentOwner
    && typeof process.getuid === "function"
    && info.uid !== process.getuid()
  ) {
    throw new Error(`${name} must be owned by the current runner user`);
  }
  return parseJson(await readFile(path, "utf8"), name);
}

export async function assertNoSymlinkAncestors(
  project: string,
  candidate: string,
  name: string,
): Promise<void> {
  const segments = relative(project, candidate).split(sep).filter(Boolean);
  let cursor = project;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    const info = await lstatIfExists(cursor);
    if (info?.isSymbolicLink()) {
      throw new Error(`${name} must not traverse a symbolic link: ${cursor}`);
    }
  }
}
