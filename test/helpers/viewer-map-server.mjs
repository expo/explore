import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startViewerServer } from "../../dist/map/viewer-server.js";
import { writeViewerMapFixture } from "./viewer-map-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "explore-e2e-viewer-"));
try {
  await writeViewerMapFixture(root);
  const viewer = await startViewerServer({ root, port: Number(process.argv[2]), aiBackend: false });
  let closing;
  const shutdown = () => closing ??= viewer.close().then(() => rm(root, { recursive: true, force: true }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}
