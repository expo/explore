/**
 * What a hosted or local report page serves the Viewer instead of the whole ZIP: the manifest (the report's metadata
 * file verbatim plus every asset's size) and each asset on request. `ci:deploy` writes them as a hosted preview's
 * static files, the local report server answers them from the ZIP, and the preview Worker reads the manifest back.
 */
import { MAX_METADATA_BYTES, reportFrom, type LoadedReport } from "./agent-api.js";

/** The manifest format the Viewer accepts (viewer/src/utils/artifact-report.ts). */
export const PREVIEW_MANIFEST_FORMAT = "explore.preview-manifest/1";
/** `assets/<sha256>.<ext>`, the only asset names a report page serves. */
export const PREVIEW_ASSET = /^assets\/([a-f0-9]{64})\.(png|jpg|mp4)$/;
export const ASSET_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", mp4: "video/mp4" };
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/**
 * The metadata file verbatim plus the size of every asset, so the Viewer opens the report before any screenshot.
 * Directory records are not assets. `deployment` names the hosted deployment that wrote it, so a check can tell a new
 * deployment of an unchanged report from the one an alias still points at.
 */
export function manifestBody(loaded: LoadedReport, deployment?: string): string {
  const entries: Record<string, number> = {};
  for (const [name, entry] of loaded.entries) if (name.startsWith("assets/") && !name.endsWith("/")) entries[name] = entry.size;
  const stamp = deployment ? `"deployment":${JSON.stringify(deployment)},` : "";
  return `{"format":"${PREVIEW_MANIFEST_FORMAT}",${stamp}"file":"${loaded.file}","entries":${JSON.stringify(entries)},"report":${new TextDecoder().decode(loaded.raw)}}`;
}

/** The report a manifest describes, reading its assets through `readAsset`; undefined when it is not a manifest of a report. */
export function reportFromManifest(text: string, readAsset: LoadedReport["read"]): LoadedReport | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { format, file, entries, report } = parsed as { format?: unknown; file?: unknown; entries?: unknown; report?: unknown };
  if (format !== PREVIEW_MANIFEST_FORMAT || (file !== "review.json" && file !== "exploration.json")) return undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || !report || typeof report !== "object") return undefined;
  const sizes = new Map<string, { size: number }>();
  for (const [name, size] of Object.entries(entries)) {
    if (!PREVIEW_ASSET.test(name) || !Number.isSafeInteger(size) || (size as number) < 0) return undefined;
    sizes.set(name, { size: size as number });
  }
  const raw = new TextEncoder().encode(JSON.stringify(report));
  if (raw.byteLength > MAX_METADATA_BYTES) return undefined;
  return reportFrom(file, raw, sizes, (name, limit) => (sizes.has(name) ? readAsset(name, limit) : Promise.resolve(undefined)));
}

/** One asset of the report with its content type; undefined when the report has no such asset. */
export async function previewAsset(loaded: LoadedReport, path: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const match = PREVIEW_ASSET.exec(path);
  if (!match || !loaded.entries.has(path)) return undefined;
  const bytes = await loaded.read(path, MAX_ASSET_BYTES);
  return bytes ? { bytes, type: ASSET_TYPES[match[2]!]! } : undefined;
}
