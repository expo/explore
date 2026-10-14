/** Public-file URLs need the same base as the Viewer bundle when hosted below a subpath. */
export function viewerAssetUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}${path.replace(/^\/+/, "")}`;
}
