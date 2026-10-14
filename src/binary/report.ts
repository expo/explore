import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { EXPLORATION_REPORT_KIND, type ExplorationReport } from "../contracts/standalone-report.js";
import { ExploreStore, getCoverage } from "../map/store.js";
import { CiError } from "../shared/ci-errors.js";
import { EXPLORE_VERSION } from "../shared/package-paths.js";
import type { BinaryExploreResult, SessionExploreResult } from "./run.js";

/** The report directory `explore:binary` / `explore:session` leaves next to the map: what the hosted Viewer and `view` open. */
export async function writeExplorationReport(result: BinaryExploreResult | SessionExploreResult, outputPath: string): Promise<{ reportPath: string; reportFile: string; imageCount: number }> {
  const store = new ExploreStore(result.outputDirectory);
  const map = await store.read();
  const directory = resolve(outputPath);
  await mkdir(join(directory, "assets"), { recursive: true });
  const assets: ExplorationReport["assets"] = [];
  for (const artifact of [...map.artifacts].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    if (artifact.kind !== "screenshot") continue;
    const source = resolve(store.root, artifact.path);
    const bytes = await readFile(source);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new CiError({ code: "REPORT_ASSET_HASH_MISMATCH", stage: "export",
      message: `Screenshot ${artifact.path} does not match its recorded hash`, nextAction: "Rerun explore:binary; do not edit the map's artifacts." });
    const path = `assets/${artifact.sha256}.png`;
    await copyFile(source, join(directory, path));
    assets.push({ sha256: artifact.sha256, path });
  }
  const report: ExplorationReport = { kind: EXPLORATION_REPORT_KIND, map, coverage: getCoverage(map), assets,
    exploration: { app: "archive" in result
        ? { name: result.archive.appName, bundleId: result.archive.bundleId, platform: result.archive.platform,
          ...(result.archive.version ? { version: result.archive.version } : {}), ...(result.archive.buildNumber ? { buildNumber: result.archive.buildNumber } : {}) }
        : result.app,
      ...("archive" in result ? { archive: { kind: result.archive.kind, sha256: result.archive.sha256, bytes: result.archive.bytes, fileName: basename(result.archive.path) } } : {}),
      device: { model: result.runtime.deviceModel, osVersion: result.runtime.osVersion },
      model: { provider: result.model.provider, model: result.model.model },
      budget: map.run.limits as ExplorationReport["exploration"]["budget"],
      stopReason: result.exploration.stopReason, ...(result.exploration.summary ? { summary: result.exploration.summary } : {}),
      startedAt: map.run.createdAt, completedAt: map.run.completedAt ?? map.run.updatedAt, exploreVersion: EXPLORE_VERSION } };
  const reportFile = join(directory, "exploration.json");
  await writeFile(reportFile, JSON.stringify(report), { flag: "wx" });
  return { reportPath: directory, reportFile, imageCount: assets.length };
}
