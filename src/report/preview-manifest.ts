/**
 * What a hosted or local report page serves the Viewer instead of the whole ZIP: the manifest (the report's metadata
 * file verbatim plus every asset's size) and each asset on request. `ci:deploy` writes them as a hosted preview's
 * static files, the local report server answers them from the ZIP, and the preview Worker reads the manifest back.
 */
import { reportFromJson, type LoadedReport } from "./agent-api.js";

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

/** The largest metadata file the Viewer opens (`ARTIFACT_LIMITS.metadata` in viewer/src/utils/artifact-report.ts). */
export const MAX_PREVIEW_METADATA_BYTES = 8 * 1024 * 1024;
/** A manifest is the metadata file plus one size per asset; the Viewer refuses a larger one. */
export const MAX_MANIFEST_BYTES = MAX_PREVIEW_METADATA_BYTES + 2 * 1024 * 1024;
const REPORT_KEY = ',"report":';

/**
 * The report a manifest describes, reading its assets through `readAsset`; undefined when it is not a manifest of a report.
 * The metadata is parsed once and kept as the manifest's own bytes. `manifestBody` writes `report` last, so its bytes are
 * the text between `,"report":` and the closing brace; any other layout is parsed whole and re-serialized.
 */
export function reportFromManifest(bytes: Uint8Array, readAsset: LoadedReport["read"]): LoadedReport | undefined {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return undefined;
  const text = new TextDecoder().decode(bytes);
  let header: unknown, report: unknown, raw: Uint8Array | undefined;
  const at = text.indexOf(REPORT_KEY);
  // A string cannot hold `,"report":` (its quotes are escaped); a nested key can, and then the header before it is not JSON on its own.
  if (at !== -1 && text.endsWith("}") && /^[\x20-\x7e]*$/.test(text.slice(0, at))) {
    try {
      header = JSON.parse(`${text.slice(0, at)}}`);
      report = JSON.parse(text.slice(at + REPORT_KEY.length, -1));
      raw = bytes.subarray(at + REPORT_KEY.length, bytes.byteLength - 1);
    } catch { header = undefined; }
  }
  if (raw === undefined) {
    try { header = JSON.parse(text); } catch { return undefined; }
    report = (header as { report?: unknown } | null)?.report;
    raw = new TextEncoder().encode(JSON.stringify(report));
  }
  if (!header || typeof header !== "object") return undefined;
  const { format, file, entries } = header as { format?: unknown; file?: unknown; entries?: unknown };
  if (format !== PREVIEW_MANIFEST_FORMAT || (file !== "review.json" && file !== "exploration.json")) return undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries) || !report || typeof report !== "object") return undefined;
  const sizes = new Map<string, { size: number }>();
  for (const [name, size] of Object.entries(entries)) {
    if (!PREVIEW_ASSET.test(name) || !Number.isSafeInteger(size) || (size as number) < 0) return undefined;
    sizes.set(name, { size: size as number });
  }
  if (raw.byteLength > MAX_PREVIEW_METADATA_BYTES) return undefined;
  return reportFromJson(file, raw, report, sizes, (name, limit) => (sizes.has(name) ? readAsset(name, limit) : Promise.resolve(undefined)));
}

/** One asset of the report with its content type; undefined when the report has no such asset. */
export async function previewAsset(loaded: LoadedReport, path: string): Promise<{ bytes: Uint8Array; type: string } | undefined> {
  const match = PREVIEW_ASSET.exec(path);
  if (!match || !loaded.entries.has(path)) return undefined;
  const bytes = await loaded.read(path, MAX_ASSET_BYTES);
  return bytes ? { bytes, type: ASSET_TYPES[match[2]!]! } : undefined;
}
