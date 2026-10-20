import { copyFile, mkdir, readdir, readFile, writeFile, appendFile, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { bundleColorSchemes, mergeSchemeOutcomes, routeIdOfScreen, schemeScreenId, type ColorScheme } from "../capture/appearance.js";
import type { CaptureOutcome } from "../contracts/capture.js";
import type { CaptureBundle } from "../contracts/capture.js";
import type { ExploreMap } from "../types.js";

const LIST_FIELDS = ["artifacts", "screens", "variants", "observations", "elements", "actionAttempts", "transitions", "journeys", "frontier", "gaps"] as const;

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

async function copyTree(source: string, destination: string, skip: (relativePath: string) => boolean, root = source): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name), rel = relative(root, from);
    if (skip(rel)) continue;
    if (entry.isDirectory()) { await mkdir(to, { recursive: true }); await copyTree(from, to, skip, root); continue; }
    if (!entry.isFile()) continue;
    if ((await lstat(to).catch(() => undefined))) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

/**
 * A secondary appearance session's result: its export, or the error it failed with, when it left none. In brentvatne/euxy's
 * main baseline run 39506374824 the dark session's install failed after the light session had captured 16 of 16 routes.
 */
export type SecondaryCaptureExport = { directory: string; scheme: ColorScheme } | { scheme: ColorScheme; error: NonNullable<CaptureOutcome["error"]> };

/**
 * Fold the exports of a side's secondary appearance sessions into its primary export, in place: the frames, outcomes,
 * launch evidence and map records of each `<id>@<scheme>` screen, and their files. Each session captured its passes as
 * one run would (`appearancePass`), so records only append; a secondary export never replaces a primary record. A session
 * that failed is listed in the bundle's `sessionFailures`, adds a failed `<id>@<scheme>` outcome carrying its error for
 * every selected route, and leaves the run partial, so its appearance reads as unavailable with its own reason (a route
 * the primary lost too would otherwise show the primary's) instead of going missing.
 */
export async function mergeCaptureExports(primary: string, secondaries: readonly SecondaryCaptureExport[]): Promise<void> {
  if (secondaries.length === 0) return;
  const bundle = await readJson<CaptureBundle>(join(primary, "bundle.json"));
  const map = await readJson<ExploreMap>(join(primary, "screen-map.json"));
  const known = { screens: new Set(map.screens.map(screen => screen.id)), artifacts: new Set(map.artifacts.map(artifact => artifact.id)) };
  // The outcomes recombine as one run's passes do (mergeSchemeOutcomes): a secondary pass records a verified frame under
  // `<id>@<scheme>` and a lost route under `<id>`, which the merge folds into the primary record the same way.
  const schemes = bundleColorSchemes(bundle);
  const passes: Record<string, CaptureOutcome>[] = schemes.map(() => ({}));
  for (const [id, outcome] of Object.entries(bundle.outcomes)) if (!routeIdOfScreen(id).scheme) passes[0]![id] = outcome;
  const failedSessions: string[] = [];
  const failedOutcomes: Record<string, CaptureOutcome> = {};
  for (const secondary of secondaries) {
    const { scheme } = secondary;
    if ("error" in secondary) {
      failedSessions.push(`The ${scheme} session failed (${secondary.error.code}): ${secondary.error.message.replace(/\.+$/, "")}.`);
      (bundle.sessionFailures ??= []).push({ scheme, error: secondary.error });
      // A primary that renders no such appearance has no slot for its frames; the failure stays on the bundle alone.
      if (!schemes.includes(scheme)) continue;
      for (const id of bundle.selectedSurfaceIds) {
        failedOutcomes[schemeScreenId(id, scheme)] = { status: "failed", attempts: 0, landing: "unverified", reason: secondary.error.message, error: secondary.error };
      }
      continue;
    }
    const other = await readJson<CaptureBundle>(join(secondary.directory, "bundle.json"));
    const pass = passes[schemes.indexOf(scheme)];
    // A session that could not show its appearance (Argent without appearance.set captures one) has nothing to add, as
    // one run would have no pass for it.
    if (!pass && !bundleColorSchemes(other).includes(scheme)) continue;
    if (!pass) throw new Error(`The ${scheme} session's export is not an appearance of the primary export (${schemes.join(", ")})`);
    for (const [id, outcome] of Object.entries(other.outcomes)) pass[routeIdOfScreen(id).routeId] = outcome;
    const otherMap = await readJson<ExploreMap>(join(secondary.directory, "screen-map.json"));
    for (const [id, image] of Object.entries(other.images)) if (routeIdOfScreen(id).scheme && !bundle.images[id]) bundle.images[id] = image;
    for (const [scheme, record] of Object.entries(other.launch ?? {})) { bundle.launch ??= {}; bundle.launch[scheme] ??= record; }
    for (const [id, context] of Object.entries(other.captureContexts ?? {})) { bundle.captureContexts ??= {}; bundle.captureContexts[id] ??= context; }
    for (const field of LIST_FIELDS) {
      const records = (otherMap[field] ?? []) as Array<Record<string, unknown>>;
      const target = ((map as unknown as Record<string, unknown[]>)[field] ??= []);
      for (const record of records) {
        if (field === "screens" && known.screens.has(record.id as string)) continue;
        if (field === "artifacts" && known.artifacts.has(record.id as string)) continue;
        if (field === "screens") known.screens.add(record.id as string);
        if (field === "artifacts") known.artifacts.add(record.id as string);
        target.push(record);
      }
    }
    // Files: artifacts and launch evidence are new paths; diagnostics append to the primary's lines.
    await copyTree(secondary.directory, primary, rel => rel === "bundle.json" || rel === "screen-map.json" || rel === "screen-map.schema.json" || rel === "manifest.json"
      || rel === "execution.json" || rel.startsWith("capture-diagnostics"));
    const diagnostics = join(secondary.directory, "capture-diagnostics");
    for (const entry of await readdir(diagnostics, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const to = join(primary, "capture-diagnostics", entry.name);
      await mkdir(dirname(to), { recursive: true });
      if (entry.name.endsWith(".jsonl")) await appendFile(to, await readFile(join(diagnostics, entry.name)));
      else if (!(await lstat(to).catch(() => undefined))) await copyFile(join(diagnostics, entry.name), to);
    }
  }
  // An open gap a secondary pass left makes the run partial, as it does one run's (a complete run has none), and so does
  // a secondary session that failed. A partial run names why, as the map's schema requires.
  if (map.gaps.some(gap => gap.status === "open") || failedSessions.length) {
    map.run.status = "partial";
    map.run.stopReason = [map.run.stopReason ?? (failedSessions.length ? undefined : "Some source targets could not be captured; see bundle outcomes."),
      ...failedSessions].filter(Boolean).join(" ");
  }
  const manifest = await readJson<{ files: unknown[] }>(join(primary, "manifest.json"));
  manifest.files = map.artifacts.map(artifact => ({ path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, mimeType: artifact.mimeType }));
  await writeFile(join(primary, "screen-map.json"), JSON.stringify(map));
  bundle.outcomes = { ...mergeSchemeOutcomes(passes, schemes), ...failedOutcomes };
  await writeFile(join(primary, "bundle.json"), JSON.stringify(bundle));
  await writeFile(join(primary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
