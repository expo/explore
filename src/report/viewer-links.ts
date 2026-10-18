export const DEFAULT_VIEWER_ORIGIN = "https://explore-preview.expo.app";

/**
 * Every link a public review comment publishes, built in one place from the Viewer's URL grammar:
 * the report page (the hosted root) names the run attempt and its report artifact, `focus=`
 * narrows the diff filter to one status, and `screen=` plus `view=compare` opens one changed
 * surface in Compare.
 */
export type ViewerDeepLinks = {
  /** The review as the Viewer opens it by default: Map canvas, Changes rail. */
  open: string;
  /** Changes rail filtered to one diff status, with the Diff inspector selected. */
  focus: (status: "added" | "modified" | "removed") => string;
  /** One changed surface in Compare: large Before and After, and the other changes one key away. */
  surface: (surfaceId: string) => string;
};

/** A hosted preview: the Viewer and its report served from one token-gated EAS Hosting deployment. */
export type PreviewLinks = ViewerDeepLinks & {
  /** Epoch milliseconds after which the deployment's Worker stops serving the report; null when the link does not expire. */
  expiresAt: number | null;
};

export type ViewerLinks = {
  /** Absent until the report artifact is uploaded; the comment then links only GitHub pages. */
  viewer: ViewerDeepLinks | null;
  /** Set once `ci:deploy` has verified a hosted preview; the comment then links to it as **Explore report**. */
  preview?: PreviewLinks;
  /** Set by `ci:report` when `report.preview` asks for a hosted preview that `ci:deploy` has not published yet: the
      comment says the report is not ready rather than linking the central Viewer's download-and-drop page. */
  deploying?: true;
  /** GitHub's download page for the uploaded report ZIP; null before upload. */
  download: string | null;
  /** The GitHub Actions run attempt that produced the review. */
  run: string;
  /** The repository-owned configuration file at the reviewed head commit. */
  config: string;
  /** The Actions run page anchor that lists uploaded artifacts. */
  artifacts: string;
};

export type ViewerLinkInput = {
  /** Viewer URL as configured (`https://host/map` or an origin). Only its origin is used. */
  viewerUrl?: string;
  /** Stable GitHub upload-artifact URL; only set after upload succeeds. */
  artifactUrl?: string;
  repository: string;
  headSha: string;
  runId: string;
  runAttempt: string;
  /** Set by the matrix workflows; the Viewer then downloads the platform-suffixed report artifact. */
  platform?: "ios" | "android";
  /** The capture target's id when the run captures several (wins over `platform`); the artifact is suffixed with it. */
  target?: string;
  configPath: string;
};

/** The target id grammar (TARGET_ID_PATTERN, minus the names isTargetId reserves). */
const TARGET_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The query parameter that selects a target's report: `platform=<id>` for a target named after its platform, so links for
 * configs without targets stay byte-identical and old Workers and Viewers still read them; `target=<id>` for any other.
 */
export function targetParameter(id: string): ["platform" | "target", string] {
  if (!TARGET_ID.test(id) || ["base", "head", "report"].includes(id) || id.startsWith("install-")) throw new Error("target id is invalid");
  return [id === "ios" || id === "android" ? "platform" : "target", id];
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;
// A secondary appearance surface is `<route>@<scheme>` (see schemeScreenId).
const SURFACE_ID = /^[A-Za-z0-9._-]{1,200}(@(light|dark))?$/;

function safeHttpUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(`${label} must be an HTTP URL without credentials or whitespace`);
  }
  return url;
}

function repositoryPath(repository: string): string {
  const segments = repository.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9._-]{1,100}$/.test(segment))) {
    throw new Error("repository must be owner/name");
  }
  return segments.map(encodeURIComponent).join("/");
}

const PREVIEW_PATH = /^\/p\/[a-z2-7]{32}$/;

/** Deep links on a verified preview URL (`https://<project>--<id>.expo.app/p/<token>`), same grammar as the central Viewer. */
export function previewLinks(previewUrl: string, expiresAt: number | null, target?: string): PreviewLinks {
  const url = safeHttpUrl(previewUrl, "preview URL");
  if (url.protocol !== "https:" || url.search || url.hash || !PREVIEW_PATH.test(url.pathname)) {
    throw new Error("preview URL must be an https token page without a query or fragment");
  }
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new Error("preview expiry must be a timestamp or null");
  const selection = target ? targetParameter(target) : undefined;
  const make = (params: Record<string, string> = {}) => {
    const link = new URL(url.href);
    // Several targets share one token page; `platform` or `target` picks this report's archive.
    if (selection) link.searchParams.set(...selection);
    for (const [key, value] of Object.entries(params)) link.searchParams.set(key, value);
    return link.href;
  };
  return { open: make(), expiresAt,
    focus: (status) => make({ focus: status, inspect: "diff" }),
    surface: (id) => {
      if (!SURFACE_ID.test(id)) throw new Error("route id is invalid");
      return make({ view: "compare", screen: id });
    } };
}

export function viewerLinks(input: ViewerLinkInput): ViewerLinks {
  const viewer = safeHttpUrl(input.viewerUrl ?? DEFAULT_VIEWER_ORIGIN, "viewer URL");
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) throw new Error("headSha must be a full lowercase commit");
  if (!SAFE_ID.test(input.runId) || !SAFE_ID.test(input.runAttempt)) throw new Error("run identifiers are invalid");
  if (input.configPath.startsWith("/") || input.configPath.includes("\\")
    || input.configPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("configPath must be a relative repository path");
  }
  const repository = `https://github.com/${repositoryPath(input.repository)}`;
  const targetId = input.target ?? input.platform;
  const selection = targetId ? targetParameter(targetId) : undefined;
  const artifact = input.artifactUrl ? safeHttpUrl(input.artifactUrl, "artifact URL") : undefined;
  if (artifact && (artifact.origin !== "https://github.com" || artifact.search || artifact.hash
    || !new RegExp(`^/${repositoryPath(input.repository).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/${input.runId}/artifacts/[1-9][0-9]*$`).test(artifact.pathname))) {
    throw new Error("artifact URL must identify an artifact from this repository and run");
  }
  return {
    viewer: artifact ? (() => {
      const make = (params: Record<string, string> = {}) => {
        const url = new URL("/", viewer.origin);
        url.searchParams.set("repo", input.repository);
        url.searchParams.set("run", input.runId);
        url.searchParams.set("attempt", input.runAttempt);
        if (selection) url.searchParams.set(...selection);
        url.searchParams.set("artifact", artifact.pathname.split("/").at(-1)!);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.href;
      };
      return { open: make(), focus: (status: "added" | "modified" | "removed") => make({ focus: status, inspect: "diff" }),
        surface: (id: string) => {
          if (!SURFACE_ID.test(id)) throw new Error("route id is invalid");
          return make({ view: "compare", screen: id });
        } };
    })() : null,
    download: artifact ? artifact.href : null,
    run: `${repository}/actions/runs/${encodeURIComponent(input.runId)}/attempts/${encodeURIComponent(input.runAttempt)}`,
    config: `${repository}/blob/${input.headSha}/${input.configPath.split("/").map(encodeURIComponent).join("/")}`,
    artifacts: `${repository}/actions/runs/${encodeURIComponent(input.runId)}#artifacts`,
  };
}
