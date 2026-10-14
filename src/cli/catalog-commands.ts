import { mkdir, writeFile, rm, stat, realpath, copyFile } from "node:fs/promises";
import { resolve, sep, dirname, relative, isAbsolute } from "node:path";
import { validateComparisonDocument, loadBuildWorkspace, buildWorkspacePayload } from "../map/build-workspace.js";
import { generateComparison, CompareError } from "../map/compare.js";
import { startViewerServer, openViewerInBrowser, waitForViewerShutdown } from "../map/viewer-server.js";
import { ExploreStore, validateMap, ExploreError } from "../map/store.js";
import { type ExploreMap, type BuildCatalog, BUILD_CATALOG_CONTRACT } from "../types.js";
import { required, flag, output, nonNegativeInteger, store, has } from "./args.js";

export async function compareCommand(): Promise<void> {
  const baselineRoot = resolve(process.cwd(), required("baseline"));
  const currentRoot = resolve(process.cwd(), required("current"));
  const outputPath = resolve(process.cwd(), required("output"));

  const loadSide = async (root: string, side: string): Promise<ExploreMap> => {
    const sideStore = new ExploreStore(root);
    const map = await sideStore.read();
    const errors = await validateMap(map, sideStore);
    if (errors.length) {
      throw new ExploreError(`Cannot compare invalid ${side} map at ${root}: ${errors.join("; ")}`);
    }
    return map;
  };
  const [baselineMap, currentMap] = await Promise.all([
    loadSide(baselineRoot, "baseline"),
    loadSide(currentRoot, "current"),
  ]);

  let result;
  try {
    result = generateComparison(baselineMap, currentMap);
  } catch (error) {
    if (error instanceof CompareError) throw new ExploreError(error.message);
    throw error;
  }
  await validateComparisonDocument(result.comparison, baselineMap, currentMap);

  // Every catalog precondition is checked before the first write, so a failed
  // run never leaves a partial or unloadable document on disk. Written paths
  // always use forward slashes; a catalog is a portable artifact.
  const toPosix = (value: string) => value.split(sep).join("/");
  let catalogOutput: string | undefined;
  let catalog: BuildCatalog | undefined;
  const catalogPath = flag("catalog-output");
  if (catalogPath) {
    catalogOutput = resolve(process.cwd(), catalogPath);
    const catalogDir = dirname(catalogOutput);
    const describe = (map: ExploreMap, root: string) => {
      const buildId = map.run.build.id;
      const version = map.run.build.version;
      if (!buildId || !version) {
        throw new ExploreError(
          `Cannot write a catalog: the map at ${root} is missing run.build.id or run.build.version; initialize runs with --build-id and --build-version`,
        );
      }
      const mapDir = relative(catalogDir, root);
      if (mapDir.startsWith("..") || isAbsolute(mapDir)) {
        throw new ExploreError(
          `The catalog must live at or above both map directories; ${root} is outside ${catalogDir}`,
        );
      }
      return { id: buildId, kind: "build" as const, version, mapDir: mapDir ? toPosix(mapDir) : "." };
    };
    const comparisonRelative = relative(catalogDir, outputPath);
    if (comparisonRelative.startsWith("..") || isAbsolute(comparisonRelative)) {
      throw new ExploreError(
        `The comparison output must live at or below the catalog directory: ${outputPath}`,
      );
    }
    catalog = {
      contract: BUILD_CATALOG_CONTRACT,
      name: flag("catalog-name") ?? currentMap.run.name,
      currentBuildId: result.comparison.currentBuildId,
      defaultBaselineBuildId: result.comparison.baselineBuildId,
      builds: [describe(baselineMap, baselineRoot), describe(currentMap, currentRoot)],
      comparisons: [
        {
          baselineBuildId: result.comparison.baselineBuildId,
          currentBuildId: result.comparison.currentBuildId,
          path: toPosix(comparisonRelative),
        },
      ],
    };
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result.comparison, null, 2)}\n`, "utf8");

  let reviewOutput: string | undefined;
  const reviewPath = flag("review-output");
  if (reviewPath) {
    reviewOutput = resolve(process.cwd(), reviewPath);
    await mkdir(dirname(reviewOutput), { recursive: true });
    await writeFile(reviewOutput, `${JSON.stringify(result.review, null, 2)}\n`, "utf8");
  }

  if (catalog && catalogOutput) {
    await mkdir(dirname(catalogOutput), { recursive: true });
    await writeFile(catalogOutput, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    try {
      await loadBuildWorkspace(catalogOutput);
    } catch (error) {
      await rm(catalogOutput, { force: true });
      throw error;
    }
  }

  output({
    ok: true,
    output: outputPath,
    ...(reviewOutput ? { reviewOutput } : {}),
    ...(catalogOutput ? { catalogOutput } : {}),
    baselineBuildId: result.comparison.baselineBuildId,
    currentBuildId: result.comparison.currentBuildId,
    summary: result.summary,
  });
}



export async function exportWeb(): Promise<void> {
  const workspace = await loadBuildWorkspace(resolve(process.cwd(), required("catalog")));
  const destination = resolve(process.cwd(), required("output"));
  if (await stat(destination).catch(() => undefined)) throw new ExploreError("Export destination already exists");
  const payload = buildWorkspacePayload(workspace);
  let copied = 0;
  await mkdir(destination, { recursive: true });
  for (const [buildId, build] of workspace.builds) {
    if (!/^[A-Za-z0-9._-]+$/.test(buildId) || buildId === "." || buildId === "..") throw new ExploreError(`Build id is not usable as a path segment: ${buildId}`);
    const root = await realpath(build.root);
    for (const artifact of build.map.artifacts) {
      const source = await realpath(resolve(root, artifact.path));
      const rel = relative(root, source);
      const targetRoot = resolve(destination, "artifacts", buildId);
      const target = resolve(targetRoot, artifact.path);
      if (rel.startsWith("..") || isAbsolute(rel) || relative(targetRoot, target).startsWith("..")) throw new ExploreError(`Artifact escapes build ${buildId}: ${artifact.path}`);
      await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); copied += 1;
    }
  }
  await writeFile(resolve(destination, "workspace.json"), JSON.stringify(payload));
  output({ ok: true, output: destination, workspace: resolve(destination, "workspace.json"), builds: [...workspace.builds.keys()], artifacts: copied });
}

export async function view(): Promise<void> {
  const requestedPort = flag("port") === undefined ? undefined : nonNegativeInteger("port");
  const catalog = flag("catalog");
  const viewer = await startViewerServer({
    root: store.root,
    ...(catalog ? { catalog: resolve(process.cwd(), catalog) } : {}),
    ...(requestedPort === undefined ? {} : { port: requestedPort }),
  });
  output({
    ok: true,
    url: viewer.url,
    ...(catalog ? { catalog: resolve(process.cwd(), catalog) } : { map: store.mapPath }),
    message: "Expo Explore viewer is running. Press Ctrl+C to stop.",
  });
  if (!has("no-open")) openViewerInBrowser(viewer.url);
  await waitForViewerShutdown(viewer);
}
