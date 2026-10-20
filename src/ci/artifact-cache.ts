import { bundleColorSchemes, routeIdOfScreen, schemeScreenId } from "../capture/appearance.js";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readCaptureBundle } from "../review/capture-review.js";
import { readExportedMap } from "../review/evidence-assessment.js";
import { parseRuntimeExecutionContext } from "../review/runtime-adapter.js";
import { AGENT_ACCEPTANCE_POLICY, assertAgentAcceptance, type CaptureBundle } from "../contracts/capture.js";
import { assertDecodedPng } from "../shared/png-evidence.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { captureRepack, type ExploreConfig } from "../config/explore-config.js";
import { hasVerifiedCapture } from "../capture/health.js";
import { CAPTURE_OBSERVER_HASH } from "../capture/observer.js";
import { ARGENT_VERSION } from "../shared/argent-version.js";

const METADATA = "cache-metadata.json";
const CONTRACT = "explore.capture-cache";
/** The most evidence a capture cache holds; a downloaded baseline is refused past it before it is unpacked. */
export const CAPTURE_CACHE_MAX_BYTES = 250 * 1024 * 1024;
/** The most files a capture cache holds, besides its metadata. */
export const CAPTURE_CACHE_MAX_FILES = 10_000;
type Recipe = { inventory: unknown; profile: string; config: string; toolsCommit: string };
type FileRecord = { path: string; bytes: number; sha256: string };
type CacheMetadata = { contract: typeof CONTRACT; recipe: string; commit: string; files: FileRecord[] };
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const recipeKey = ({ inventory, profile, config, toolsCommit }: Recipe) => {
  let parsedConfig: unknown = config;
  try { parsedConfig = JSON.parse(config); } catch { /* Non-JSON opaque recipe strings remain exact. */ }
  return hash(canonicalJson({ inventory, profile, config: parsedConfig, toolsCommit }));
};

/** Only settings that can change captured runtime evidence belong in the recipe. */
export function captureRecipeConfig(config: ExploreConfig, instructionsSha256?: string): string {
  // How many sessions capture the evidence (capture.maxSessions), and how long a review waits for a baseline, do not change it.
  const { maxSessions: _maxSessions, baselineWaitMinutes: _baselineWaitMinutes, ...capture } = config.capture;
  void _maxSessions; void _baselineWaitMinutes;
  return canonicalJson({
    observer: CAPTURE_OBSERVER_HASH,
    mode: config.mode,
    ...(config.mode === "agent" ? { agent: { ...config.agent, instructionsSha256, acceptancePolicy: AGENT_ACCEPTANCE_POLICY } } : {}),
    app: { platform: config.app.platform, bundleId: config.app.bundleId, easProfile: config.app.easProfile,
      ...(config.app.scheme === undefined ? {} : { scheme: config.app.scheme }) },
    device: config.device, parameters: config.parameters, setup: config.setup ?? [],
    // The repack as it resolves, so a config that leaves it to the default keeps the recipe it had when the default was written out.
    capture: { ...capture, repack: captureRepack(config) },
    // agent-device recipes stay as they were; an Argent capture is keyed to the Argent release that drove it.
    ...(config.capture.controller === "argent" ? { controllerVersion: ARGENT_VERSION } : {}),
  });
}

function requiresAgentAcceptance(recipe: Recipe, bundle: CaptureBundle): boolean {
  if (bundle.captureContexts !== undefined || bundle.agentAcceptance !== undefined) return true;
  try { return JSON.parse(recipe.config)?.mode === "agent"; }
  catch { return false; }
}

/** Checks an export the way a cache entry is checked before it is written or restored: its provenance, profile and frames. */
export async function validateEvidence(directory: string, bundle: CaptureBundle): Promise<void> {
  const map = await readExportedMap(directory, { checkArtifacts: true });
  const execution = parseRuntimeExecutionContext(JSON.parse(await readFile(join(directory, "execution.json"), "utf8")));
  if (!bundle.runtimeProfile || !/^[a-f0-9]{40}$/.test(bundle.gitCommit)
    || map.run.build.gitCommit !== bundle.gitCommit
    || map.run.platform !== execution.platform || map.run.controller !== execution.controller
    || new Set(bundle.selectedSurfaceIds).size !== bundle.selectedSurfaceIds.length
    || Object.keys(bundle.images).some(id => !bundle.selectedSurfaceIds.includes(routeIdOfScreen(id).routeId))) {
    throw new Error("Capture cache requires complete, consistent capture provenance");
  }
  for (const key of ["deviceModel", "osVersion", "locale", "orientation", "colorScheme"] as const) {
    if (bundle.runtimeProfile[key] !== execution[key] || map.run.environment[key] !== execution[key]) {
      throw new Error("Capture cache runtime evidence does not match its profile");
    }
  }
  if ((bundle.runtimeProfile.colorSchemes ?? "") !== (map.run.environment.colorSchemes?.join(",") ?? "")) {
    throw new Error("Capture cache appearance evidence does not match its profile");
  }
  const artifacts = new Map(map.artifacts.map(artifact => [artifact.id, artifact]));
  const verifiedIds = Object.keys(bundle.images).filter(id => hasVerifiedCapture(bundle, routeIdOfScreen(id).routeId));
  if (!verifiedIds.length) throw new Error("Capture cache requires at least one verified screenshot");
  for (const id of Object.keys(bundle.images)) {
    const frame = bundle.images[id]!;
    const observations = map.observations.filter(observation => observation.screenId === id);
    if (!observations.length || observations.some(observation => !observation.screenshotArtifactId || !observation.accessibilityArtifactId)) {
      throw new Error("Capture cache requires screenshot and accessibility evidence for every surface");
    }
    const representative = observations.find(observation => {
      const artifact = artifacts.get(observation.screenshotArtifactId!);
      return artifact?.path === frame.path && artifact.sha256 === frame.sha256 && observation.capturedAt === frame.capturedAt;
    });
    if (!representative || frame.sourceCommit !== bundle.gitCommit) {
      throw new Error("Capture cache image provenance does not match runtime evidence");
    }
    const bytes = await readFile(join(directory, frame.path));
    assertDecodedPng(bytes, "Cached image");
    if (frame.width !== bytes.readUInt32BE(16) || frame.height !== bytes.readUInt32BE(20)) {
      throw new Error("Capture cache image dimensions do not match the captured image");
    }
  }
}

async function fileInventory(directory: string, path = ""): Promise<FileRecord[]> {
  const files: FileRecord[] = [];
  for (const name of (await readdir(join(directory, path))).sort()) {
    const child = path ? `${path}/${name}` : name;
    if (child === METADATA) continue;
    const info = await lstat(join(directory, child));
    if (info.isSymbolicLink()) throw new Error("Capture cache cannot contain symbolic links");
    if (info.isDirectory()) files.push(...await fileInventory(directory, child));
    else if (info.isFile()) files.push({ path: child, bytes: info.size, sha256: hash(await readFile(join(directory, child))) });
    else throw new Error("Capture cache contains an unsupported file");
  }
  if (files.length > CAPTURE_CACHE_MAX_FILES || files.reduce((sum, file) => sum + file.bytes, 0) > CAPTURE_CACHE_MAX_BYTES) {
    throw new Error("Capture cache exceeds the evidence size limit");
  }
  return files;
}

/**
 * The routes a review can reuse from a capture: a verified frame in every appearance it renders. A baseline whose dark
 * session failed (brentvatne/euxy's main baseline run 39506374824) holds its light frames and a failed `<route>@dark`;
 * reusing the light frame alone would leave the review's base with no dark frame, and dark would read as unavailable
 * because of the base. Such a route is captured by the review's base instead, in every appearance.
 */
export function reusableSurfaceIds(bundle: CaptureBundle): string[] {
  const secondarySchemes = bundleColorSchemes(bundle).slice(1);
  return bundle.selectedSurfaceIds.filter(id => hasVerifiedCapture(bundle, id)
    && secondarySchemes.every(scheme => bundle.images[schemeScreenId(id, scheme)] && bundle.outcomes[schemeScreenId(id, scheme)] === undefined));
}

/**
 * Why a capture of `commit` in `sourceDirectory` is not offered for reuse, when it is there and captured some routes:
 * none has every appearance (its dark session failed). Undefined otherwise, the cache's usual misses included.
 */
export async function incompleteCaptureReason(sourceDirectory: string, commit: string): Promise<string | undefined> {
  try {
    const bundle = await readCaptureBundle(sourceDirectory);
    if (bundle.gitCommit !== commit || reusableSurfaceIds(bundle).length || !bundle.selectedSurfaceIds.some(id => hasVerifiedCapture(bundle, id))) return undefined;
    const failed = (bundle.sessionFailures ?? []).map(failure => failure.scheme);
    return failed.length ? `its ${failed.join(" and ")} session failed, so no route has every appearance` : "no route was captured in every appearance";
  } catch { return undefined; }
}

/** Cache full exported evidence, including accessibility maps and all referenced screenshots. */
export async function writeCaptureArtifactCache(directory: string, recipe: Recipe): Promise<boolean> {
  try {
    // A restored subset rewrites its bundle. Never advertise the previous inventory if revalidation fails.
    await rm(join(directory, METADATA), { force: true });
    const bundle = await readCaptureBundle(directory);
    if (!bundle.runtimeProfile) return false;
    assertAgentAcceptance(bundle, undefined, { required: requiresAgentAcceptance(recipe, bundle) });
    await validateEvidence(directory, bundle);
    // A capture with no route a review could reuse is not offered: a review that found it would wait for it, and capture
    // its sides in turn instead of together, only to capture every route of the base itself.
    if (!reusableSurfaceIds(bundle).length) return false;
    const metadata: CacheMetadata = {
      contract: CONTRACT, recipe: recipeKey(recipe), commit: bundle.gitCommit, files: await fileInventory(directory),
    };
    await writeFile(join(directory, METADATA), JSON.stringify(metadata));
    return true;
  } catch {
    // Evidence remains usable for this report; incomplete evidence is never offered as a cache hit.
    return false;
  }
}

/** Whether a cache directory advertises this commit and recipe; the runtime profile and evidence are still checked on restore. */
export async function captureArtifactCacheMayMatch(options: Recipe & { sourceDirectory?: string; commit: string }): Promise<boolean> {
  if (!options.sourceDirectory) return false;
  try {
    const raw = await readFile(join(options.sourceDirectory, METADATA), "utf8");
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return false;
    const metadata = JSON.parse(raw) as CacheMetadata;
    const { inventory, profile, config, toolsCommit } = options;
    return metadata.contract === CONTRACT && metadata.commit === options.commit && metadata.recipe === recipeKey({ inventory, profile, config, toolsCommit });
  } catch {
    return false;
  }
}

/** Artifact retention, a partial capture, changed tools/config, or invalid evidence is a cache miss. */
export async function restoreCaptureArtifactCache(options: Recipe & {
  sourceDirectory?: string; directory: string; commit: string; selectedIds: string[];
  runtimeProfile: CaptureBundle["runtimeProfile"];
  captureContexts?: CaptureBundle["captureContexts"];
}): Promise<boolean> {
  if (!options.sourceDirectory || !options.runtimeProfile) return false;
  let stage: string | undefined;
  try {
    const source = await realpath(options.sourceDirectory);
    const raw = await readFile(join(source, METADATA), "utf8");
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return false;
    const metadata = JSON.parse(raw) as CacheMetadata;
    const { inventory, profile, config, toolsCommit } = options;
    if (metadata.contract !== CONTRACT || metadata.commit !== options.commit
      || metadata.recipe !== recipeKey({ inventory, profile, config, toolsCommit }) || !Array.isArray(metadata.files)) return false;
    // Comparing the complete inventory also rejects unlisted extras and missing runtime evidence.
    if (JSON.stringify(await fileInventory(source)) !== JSON.stringify(metadata.files)) return false;
    for (const file of metadata.files) {
      const path = resolve(source, file.path); const rel = relative(source, path);
      if (isAbsolute(file.path) || !rel || rel === ".." || rel.startsWith(`..${sep}`)
        || await realpath(path) !== path) return false;
    }
    const bundle = await readCaptureBundle(source);
    assertAgentAcceptance(bundle, undefined, { required: options.captureContexts !== undefined || requiresAgentAcceptance(options, bundle) });
    if (bundle.gitCommit !== options.commit || bundle.profile !== profile
      || canonicalJson(bundle.runtimeProfile) !== canonicalJson(options.runtimeProfile)
      || !options.selectedIds.some(id => hasVerifiedCapture(bundle, id))) return false;
    await validateEvidence(source, bundle);
    try { await lstat(options.directory); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    stage = await mkdtemp(`${options.directory}.cache-`);
    const stagedEvidence = join(stage, "evidence");
    await cp(source, stagedEvidence, { recursive: true, force: false, errorOnExist: true });
    const reusable = new Set(reusableSurfaceIds(bundle));
    const available = options.selectedIds.filter(id => reusable.has(id)
      && (!options.captureContexts || options.captureContexts[id] && bundle.captureContexts?.[id]
        && canonicalJson(options.captureContexts[id]) === canonicalJson(bundle.captureContexts[id])));
    if (!available.length) return false;
    // Secondary-appearance frames (`<route>@<scheme>`) travel with their route's verified primary frame.
    const images = Object.fromEntries(Object.entries(bundle.images).filter(([id]) => available.includes(routeIdOfScreen(id).routeId)
      && (routeIdOfScreen(id).scheme === undefined || bundle.outcomes[id] === undefined)));
    const outcomes = Object.fromEntries(available.map(id => [id, bundle.outcomes[id]!]));
    const captureContexts = bundle.captureContexts ? Object.fromEntries(available.map(id => [id, bundle.captureContexts![id]])) : undefined;
    const agentAcceptance = bundle.agentAcceptance ? { policy: bundle.agentAcceptance.policy,
      frames: Object.fromEntries(available.map(id => [id, bundle.agentAcceptance!.frames[id]!])) } : undefined;
    // Only complete routes are restored, so a failed pass of the baseline's is no part of the restored bundle.
    await writeFile(join(stagedEvidence, "bundle.json"), JSON.stringify({ ...bundle, side: "base", selectedSurfaceIds: available, images, outcomes, sessionFailures: undefined,
      ...(captureContexts ? { captureContexts } : {}), ...(agentAcceptance ? { agentAcceptance } : {}) }));
    await cp(stagedEvidence, options.directory, { recursive: true, force: false, errorOnExist: true });
    return true;
  } catch {
    return false;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
