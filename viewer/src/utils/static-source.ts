const WORKSPACE_PARAMETER = "workspace";
const ARTIFACTS_PARAMETER = "artifacts";

export type StaticViewerSource = {
  mode: "static";
  workspaceUrl: string;
  artifactBaseUrl: string;
} | {
  mode: "api";
} | {
  mode: "invalid";
  error: string;
};

function singleParameter(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new Error(`The ${name} parameter may appear only once.`);
  if (values.length === 0) return undefined;
  const value = values[0]?.trim();
  if (!value) throw new Error(`The ${name} parameter cannot be empty.`);
  return value;
}

function httpUrl(value: string, baseUrl: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new Error(`The ${name} parameter is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`The ${name} parameter must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`The ${name} parameter must not contain URL credentials.`);
  }
  url.hash = "";
  return url;
}

function artifactDirectory(value: string, baseUrl: string): URL {
  const url = httpUrl(value, baseUrl, ARTIFACTS_PARAMETER);
  if (url.search) {
    throw new Error("The artifacts parameter must be a directory URL without a query string.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function resolveStaticViewerSource(pageUrl: string): StaticViewerSource {
  try {
    const page = new URL(pageUrl);
    const workspaceParameter = singleParameter(page.searchParams, WORKSPACE_PARAMETER);
    const artifactsParameter = singleParameter(page.searchParams, ARTIFACTS_PARAMETER);
    if (!workspaceParameter) {
      if (artifactsParameter) {
        throw new Error("The artifacts parameter requires a workspace parameter.");
      }
      return { mode: "api" };
    }

    const workspaceUrl = httpUrl(workspaceParameter, page.href, WORKSPACE_PARAMETER);
    const artifactBaseUrl = artifactsParameter
      ? artifactDirectory(artifactsParameter, page.href)
      : new URL("artifacts/", workspaceUrl);

    return {
      mode: "static",
      workspaceUrl: workspaceUrl.href,
      artifactBaseUrl: artifactBaseUrl.href,
    };
  } catch (error) {
    return {
      mode: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const STATIC_VIEWER_SOURCE: StaticViewerSource = typeof window === "undefined"
  ? { mode: "api" }
  : resolveStaticViewerSource(window.location.href);

export function withStaticSourceParameters(
  routeUrl: string,
  source: StaticViewerSource = STATIC_VIEWER_SOURCE,
): string {
  if (source.mode !== "static") return routeUrl;
  const url = new URL(routeUrl, "https://viewer.invalid");
  url.searchParams.set(WORKSPACE_PARAMETER, source.workspaceUrl);
  url.searchParams.set(ARTIFACTS_PARAMETER, source.artifactBaseUrl);
  return `${url.pathname}${url.search}`;
}

export function staticArtifactUrl(
  artifactPath: string,
  sha256: string,
  buildId: string,
  source: StaticViewerSource = STATIC_VIEWER_SOURCE,
): string | undefined {
  if (source.mode !== "static") return undefined;
  const encodedPath = [buildId, ...artifactPath.split("/")]
    .map(encodeURIComponent)
    .join("/");
  const url = new URL(encodedPath, source.artifactBaseUrl);
  url.searchParams.set("sha256", sha256);
  return url.href;
}
