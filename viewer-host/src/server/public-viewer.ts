const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const IDENTIFIER = /^[1-9][0-9]{0,15}$/;
const IDENTITY_KEYS = ["repo", "run", "attempt", "artifact"] as const;

/** The GitHub Actions run a report link expects; `artifact` names the ZIP to download when known. */
export type ArtifactIdentity = { repo: string; run: string; attempt: string; artifact?: string };

/**
 * A report link binds the page to one run attempt; its Viewer selection (`screen`, `focus`,
 * `inspect`, …) passes through untouched. A report page without identity keys opens any dropped report.
 */
export function parseArtifactIdentity(parameters: URLSearchParams): ArtifactIdentity | undefined {
  if (!IDENTITY_KEYS.some(key => parameters.has(key))) return undefined;
  if (["repo", "run", "attempt"].some(key => parameters.getAll(key).length !== 1)
    || parameters.getAll("artifact").length > 1) throw new Error("Invalid report link");
  const repo = parameters.get("repo")!;
  if (!REPOSITORY.test(repo) || repo.split("/").some(segment => segment === "." || segment === "..")) {
    throw new Error("Invalid report repository");
  }
  const identity: ArtifactIdentity = { repo: repo.toLowerCase(), run: parameters.get("run")!, attempt: parameters.get("attempt")! };
  const artifact = parameters.get("artifact");
  if (artifact !== null) identity.artifact = artifact;
  for (const value of [identity.run, identity.attempt, identity.artifact]) {
    if (value !== undefined && (!IDENTIFIER.test(value) || !Number.isSafeInteger(Number(value)))) {
      throw new Error("Invalid report identifier");
    }
  }
  return identity;
}

function headers(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": "https://cors.invalid",
  });
}

/** The report page is the root; `/r` stays for links in pull-request comments written before. */
const REPORT_PATHS = new Set(["/", "/r"]);

/** Serve Vite at the address-bar route so query state and the Viewer selection survive. */
export function publicViewerResponse(request: Request, indexHtml: string): Response {
  const url = new URL(request.url);
  if (request.method !== "GET" || !REPORT_PATHS.has(url.pathname)) {
    return new Response("Not found", { status: 404, headers: headers() });
  }
  try { parseArtifactIdentity(url.searchParams); }
  catch { return new Response("Invalid report link", { status: 400, headers: headers() }); }
  return new Response(indexHtml, { headers: headers() });
}

export function publicViewerUnsupported(): Response {
  return new Response("Not found", { status: 404, headers: headers() });
}
