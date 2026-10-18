/**
 * What a hosted or local report page serves the Viewer instead of the whole ZIP: the manifest (the report's metadata
 * file verbatim plus every asset's size) and each asset on request. The preview Worker, the local report server and
 * the deploy check share these, so all three agree byte for byte.
 */
import type { LoadedReport } from "./agent-api.js";
import { readZipEntry } from "./zip-reader.js";

/** The manifest format the Viewer accepts (viewer/src/utils/artifact-report.ts). */
export const PREVIEW_MANIFEST_FORMAT = "explore.preview-manifest/1";
/** `assets/<sha256>.<ext>`, the only asset names a report page serves. */
export const PREVIEW_ASSET = /^assets\/([a-f0-9]{64})\.(png|jpg|mp4)$/;
const ASSET_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", mp4: "video/mp4" };
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/** The metadata file verbatim plus the size of every asset, so the Viewer opens the report before any screenshot. Directory records are not assets. */
export function manifestBody(loaded: LoadedReport): string {
  const entries: Record<string, number> = {};
  for (const [name, entry] of loaded.entries) if (name.startsWith("assets/") && !name.endsWith("/")) entries[name] = entry.size;
  return `{"format":"${PREVIEW_MANIFEST_FORMAT}","file":"${loaded.file}","entries":${JSON.stringify(entries)},"report":${new TextDecoder().decode(loaded.raw)}}`;
}

/** One asset of the report, inflated from the decrypted ZIP, with its content type; undefined when the report has no such asset. */
export async function previewAsset(loaded: LoadedReport, path: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const match = PREVIEW_ASSET.exec(path);
  const entry = match ? loaded.entries.get(path) : undefined;
  if (!match || !entry) return undefined;
  const bytes = await readZipEntry(loaded.zip, entry, MAX_ASSET_BYTES);
  return bytes ? { bytes, type: ASSET_TYPES[match[2]!]! } : undefined;
}
