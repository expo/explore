import { spawnSync } from "node:child_process";
import { compareStrings, isRecord, assertAllowedKeys, requiredString, safeRepoPath } from "../contracts/source-validation.js";

type SimpleSourceChange = {
  status: "added" | "modified" | "removed" | "type-changed";
  path: string;
};

type MovedSourceChange = {
  status: "renamed" | "copied";
  path: string;
  previousPath: string;
};

export type SourceChange = SimpleSourceChange | MovedSourceChange;


const fullShaPattern = /^[0-9a-f]{40}$/i;
function fullSha(value: unknown, name: string): string {
  const parsed = requiredString(value, name);
  if (!fullShaPattern.test(parsed)) throw new Error(`${name} must be a full 40-character Git SHA`);
  return parsed.toLowerCase();
}

export function canonicalizeSourceChanges(value: unknown, name = "changedFiles"): SourceChange[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const changes = value.map((change, index): SourceChange => {
    const changeName = `${name}[${index}]`;
    if (!isRecord(change)) throw new Error(`${changeName} must be an object`);
    const status = requiredString(change.status, `${changeName}.status`);
    const path = safeRepoPath(requiredString(change.path, `${changeName}.path`), `${changeName}.path`);
    if (status === "renamed" || status === "copied") {
      assertAllowedKeys(change, ["status", "path", "previousPath"], changeName);
      const previousPath = safeRepoPath(
        requiredString(change.previousPath, `${changeName}.previousPath`),
        `${changeName}.previousPath`,
      );
      if (previousPath === path) throw new Error(`${changeName} moves a path onto itself`);
      return { status, path, previousPath };
    }
    if (
      status === "added"
      || status === "modified"
      || status === "removed"
      || status === "type-changed"
    ) {
      assertAllowedKeys(change, ["status", "path"], changeName);
      return { status, path };
    }
    throw new Error(`${changeName}.status is unsupported: ${status}`);
  });
  changes.sort((left, right) => {
    const pathOrder = compareStrings(left.path, right.path);
    return pathOrder === 0 ? compareStrings(left.status, right.status) : pathOrder;
  });
  for (let index = 1; index < changes.length; index += 1) {
    if (changes[index]?.path === changes[index - 1]?.path) {
      throw new Error(`${name} contains duplicate destination path ${changes[index]?.path}`);
    }
  }
  return changes;
}

export function parseTwoDotNameStatus(output: Buffer): SourceChange[] {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: SourceChange[] = [];
  for (let index = 0; index < fields.length;) {
    const statusField = fields[index];
    index += 1;
    if (!statusField) throw new Error("git diff returned an empty status field");
    if (/^[AMDT]$/.test(statusField)) {
      const statusByCode: Record<string, SimpleSourceChange["status"]> = {
        A: "added",
        M: "modified",
        D: "removed",
        T: "type-changed",
      };
      const status = statusByCode[statusField];
      if (!status) throw new Error(`git diff returned unsupported status ${statusField}`);
      const path = fields[index];
      index += 1;
      if (!path) throw new Error(`git diff returned an incomplete ${status} record`);
      changes.push({ status, path: safeRepoPath(path, "path") });
      continue;
    }
    const movedMatch = /^([RC])(\d{1,3})$/.exec(statusField);
    if (movedMatch) {
      const scoreField = movedMatch[2];
      if (!scoreField || Number(scoreField) > 100) {
        throw new Error(`git diff returned invalid similarity score ${statusField}`);
      }
      const previousPath = fields[index];
      const path = fields[index + 1];
      index += 2;
      const status = movedMatch[1] === "R" ? "renamed" : "copied";
      if (!previousPath || !path) throw new Error(`git diff returned an incomplete ${status} record`);
      const safePreviousPath = safeRepoPath(previousPath, "previous path");
      const safePath = safeRepoPath(path, "path");
      if (safePreviousPath === safePath) throw new Error(`git diff returned a ${status} path onto itself`);
      changes.push({ status, previousPath: safePreviousPath, path: safePath });
      continue;
    }
    throw new Error(`git diff returned unsupported status ${statusField}`);
  }
  return canonicalizeSourceChanges(changes);
}

export function readTwoDotSourceChanges(options: {
  cwd: string;
  baseSha: string;
  headSha: string;
  timeoutMs?: number;
  /** App-relative paths by default; repository-relative paths for workspace-wide invalidation. */
  relativeToProject?: boolean;
}): SourceChange[] {
  const baseSha = fullSha(options.baseSha, "baseSha");
  const headSha = fullSha(options.headSha, "headSha");
  if (baseSha === headSha) throw new Error("baseSha and headSha must identify different commits");
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "diff",
      options.relativeToProject === false ? "--no-relative" : "--relative",
      "--name-status",
      "-z",
      "--find-renames",
      `${baseSha}..${headSha}`,
      "--",
    ],
    {
      cwd: options.cwd,
      shell: false,
      encoding: "buffer",
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH },
    },
  );
  if (result.error) throw new Error(`Could not read two-dot source changes: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr);
    throw new Error(`git diff failed: ${stderr.trim().slice(0, 500)}`);
  }
  if (!Buffer.isBuffer(result.stdout)) throw new Error("git diff returned an unexpected output type");
  return parseTwoDotNameStatus(result.stdout);
}

