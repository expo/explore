import { isPreviewPath } from "./artifact-report";
import type { PullRequestPresentation } from "./review-model";

/**
 * The link an agent can read: a hosted preview (`/p/<token>`), or a local review's Viewer (`capture:review` on this
 * machine serves the same path), answers a fetch that does not ask for HTML with a Markdown index of the report's
 * JSON API. Other pages (a local `explore view`, a dropped report) have nothing an agent can fetch, so they get no handoff.
 */
export function handoffPageUrl(page: URL): string | undefined {
  if (!isPreviewPath(page.pathname)) return undefined;
  const url = new URL(page.origin + page.pathname.replace(/\/$/, ""));
  const platform = page.searchParams.get("platform");
  if (platform) url.searchParams.set("platform", platform);
  return url.href;
}

/** What the reader is looking at, for the scoped prompt's last line. */
export type HandoffView = {
  view: string;
  platform?: string;
  appearance?: string;
  /** The selected screen's route or title. */
  screen?: string;
};

export type HandoffInput = {
  pageUrl: string;
  appName: string;
  pullRequest?: PullRequestPresentation | undefined;
  /** Several appearances were captured, so the agent should check each one. */
  appearances: string[];
};

function repository(pullRequest: PullRequestPresentation): string | undefined {
  return /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull\/\d+|compare\/.+)$/.exec(pullRequest.url ?? "")?.[1];
}

/** The prompt to paste into an agent; `view` adds what the reader is looking at as its last line. */
export function handoffPrompt(input: HandoffInput, view?: HandoffView): string {
  const repo = input.pullRequest ? repository(input.pullRequest) : undefined;
  const subject = input.pullRequest?.origin === "compare" || input.pullRequest?.origin === "local"
    ? `Review the visual changes from ${input.pullRequest.base.ref} to ${input.pullRequest.head.ref}${repo ? ` of ${repo}` : ""}.`
    : input.pullRequest
    ? `Review the visual changes in PR #${input.pullRequest.number}${repo ? ` of ${repo}` : ""}.`
    : `Review this Expo Explore report of ${input.appName}.`;
  const appearances = input.appearances.length > 1
    ? ` in ${input.appearances.map(name => name.toLowerCase()).join(" and ")}`
    : "";
  // A local review's link answers only on this machine, and only while `capture:review` keeps serving it.
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(input.pageUrl).hostname);
  const lines = [
    subject,
    "Expo Explore report:",
    input.pageUrl,
    "",
    `Fetch the link first${local ? " (from this machine, with curl if your fetch tool refuses local addresses)" : ""}. It explains the report's JSON API. Go through the changed screens, compare the before and after screenshots${appearances}, and tell me which changes look intended and which look like regressions. For each regression, name the source file to fix.`,
    ...(local ? ["", "The link is served by `expo-explore capture:review` on this machine and stops working when it exits."] : []),
  ];
  if (view) {
    const where = [view.screen, view.view, view.platform, view.appearance].filter(Boolean).join(" · ");
    if (where) lines.push("", `I'm looking at: ${where}`);
  }
  return lines.join("\n");
}

/** Opens Claude Code with the prompt (https://code.claude.com/docs/en/deep-links). */
export function claudeDeepLink(prompt: string): string {
  return `claude-cli://open?q=${encodeURIComponent(prompt)}`;
}

/** Opens the Codex app with the prompt (https://developers.openai.com/codex/app/commands#deep-links). */
export function codexDeepLink(prompt: string): string {
  return `codex://new?prompt=${encodeURIComponent(prompt)}`;
}
