import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const CLAUDE_SDK_VERSION = "0.3.285";

const require = createRequire(import.meta.url);

/** Resolve the SDK's exact native dependency, never an unrelated global Claude installation. */
export async function resolveClaudeExecutable(): Promise<string> {
  try {
    const sdkRoot = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const sdk: unknown = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
    if (!isRecord(sdk) || sdk.version !== CLAUDE_SDK_VERSION) throw new Error();
    const report = process.platform === "linux" ? process.report?.getReport() : undefined;
    const glibc = isRecord(report) && isRecord(report.header) && typeof report.header.glibcVersionRuntime === "string";
    const suffix = process.platform === "linux" && !glibc ? "-musl" : "";
    const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`);
    const native: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (!isRecord(native) || native.version !== CLAUDE_SDK_VERSION) throw new Error();
    return join(dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude");
  } catch {
    throw new Error("Explore's bundled Claude runtime is unavailable. Reinstall with optional dependencies.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
