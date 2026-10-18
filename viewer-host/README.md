# Expo Explore Viewer host

This is the central `expo-public/explore-viewer` EAS Hosting app. A PR's **Open Explore** link opens `/r?repo=owner/name&run=123&attempt=1&artifact=456`, a page that asks for that run's report. The reviewer downloads the `explore-review-<run>-<attempt>` ZIP from GitHub Actions (**Download report** in the same comment) and drops it on the page; the staged Viewer unpacks it in the browser. A bare `/r` opens any downloaded report.

Applications do not configure or deploy their own Viewer. Set the central origin to the project's production alias or custom domain. The hosting project is linked in `app.config.js`; do not create another EAS project when deploying it.

The same app has a second export, the **preview** variant (`EXPLORE_HOST_VARIANT=preview`, routes in `src/app-preview`), which `expo-explore ci:deploy` deploys once per review into the reviewed application's own EAS account when hosted previews are enabled. See [Preview deployments](#preview-deployments).

## Report access

Report bytes move from GitHub to the reviewer's browser only. This host keeps no GitHub credential, no repository allowlist, and no report store: GitHub's own sign-in and repository permissions decide who can download a report, so nothing is enabled per repository on the Expo side, and report links are not access tokens. Reports remain in GitHub Actions for the workflow's retention period; after that, rerun Explore.

The Viewer verifies that a dropped ZIP is the report for the linked run attempt (`review.json` names the repository, run, and attempt) and refuses other files with the expected file name. It keeps the dropped ZIP in the browser's Cache Storage (`explore-reports`, keyed by repository, run, and attempt; at most four reports, 256 MiB, seven days) so a reload or a per-screen link from the same comment opens without another drop. Screenshots are extracted lazily and verified against their recorded hashes. Nothing is uploaded and nothing is shared between browsers.

## Environment

The central host reads no environment variables and holds no secrets. A preview deployment reads only the `EXPLORE_PREVIEW_*` values written into it at deploy time (below).

## Routes

`/` shows the landing guidance and `/r` serves the Viewer for report links and drops. Every other path is a 404; there is no server middleware.

## Preview deployments

A hosted preview is one immutable EAS Hosting deployment per review, in the reviewed application's own EAS account, that opens the report without a download. Its export (`npm run export:preview`, written to `dist-preview/`) holds the identical staged Viewer under `/viewer/` and three API routes:

- `/p/<token>` serves the Viewer shell for exactly one 160-bit token (32 lowercase base32 characters) to requests that accept HTML; the shell's `#root` holds a text index of the report (title, counts, API links) until the Viewer renders, and a `Link` header names the JSON and Markdown alternates. Requests that do not prefer HTML (`Accept: */*`, `text/markdown`, `application/json`) get the same index as Markdown, so an agent handed the link finds the API by itself.
- `/p/<token>/manifest.json` is what the Viewer opens: the report's metadata file (`review.json` or `exploration.json`) verbatim plus the size of every asset, about 12 KB over the wire; the shell preloads it so it downloads alongside the Viewer bundle. The Worker answers it from its target's static manifest, passed through unparsed unless the isolate already holds it. `/p/<token>/reports.json` lists the capture targets (up to 8, each with its platform and label) a multi-target deployment serves; `?target=<id>` selects one on every other route, and `?platform=<p>`, from links before targets, selects the target named `<p>`, else the first of that platform.
- `/p/<token>/llms.txt` is the Markdown index at a fixed path, and `/p/<token>/api/v1/...` is the read-only agent API (`src/server/agent-api.ts`): summary, `/screens[?status=]`, `/screens/<id>`, `/transitions`, and for exploration reports `/journeys`, `/gaps`, `/frontier`, `/assets/<sha256>`, `/raw`, with `?limit=`/`?cursor=` paging (50 default, 200 max). The Worker reads the target's static manifest when a request first needs it and keeps parsed manifests in memory within 32 MB; requests that arrive together share one fetch. `/api/v1/assets/<sha256>` reads the screenshot's static file.
- `/` and every other path, token, or method answer the same `404 Not found`, so a response never confirms that a deployment or token exists. A static file the Worker cannot fetch this time answers `503`, which the Viewer retries.

`ci:deploy` writes the report as static files of the deployment, under the token, and EAS Hosting serves them directly, before the Worker:

| Path | Content |
| --- | --- |
| `/p/<token>/targets/<target>.json` | one target's manifest (`report.json` for a single unlisted report), stamped with the deployment so `ci:deploy` can tell it from the one an alias still serves |
| `/p/<token>/assets/<sha256>.<png\|jpg\|mp4>` | every screenshot and recording, once, shared by the targets that show it |

It also writes a deploy-time `.env` next to the export; EAS Hosting delivers it to the Worker and to nothing else:

| Variable | Value |
| --- | --- |
| `EXPLORE_PREVIEW_TOKEN` | the path token in the review comment's **Explore report** link |
| `EXPLORE_PREVIEW_REPORT` | `/p/<token>/targets/report.json` (a single iOS report), or |
| `EXPLORE_PREVIEW_REPORTS` | JSON listing each target, its platform, label, change count and device, and its manifest's path |

Nothing is encrypted: what keeps a report private is the 160-bit token in every path, the same as for the link itself. A preview link is a bearer link: anyone who has it can open the report until the deployment is deleted (EAS Hosting deletes one without an alias after 30 days on Free and 90 on paid plans), and Expo account members who can read the project's deployments are inside that trust boundary. Explore sets no expiry; `EXPLORE_PREVIEW_KEY` and `EXPLORE_PREVIEW_EXPIRES_AT` from earlier deployments belong to those deployments' own Workers.

`npm run verify:export:preview` loads the exported route bundles and checks the token, the manifest route, content negotiation, the agent API (including a screenshot read from its static file), and 404 behavior against the example report laid out as `ci:deploy` writes it.

## Validation and deployment

From the Explore repository root:

```sh
npm ci
npm --prefix viewer-host ci
npm --prefix viewer-host run validate
```

The export builds the current Viewer with the `/viewer/` base in a temporary directory, stages it into this app, exports Expo's server routes, checks the emitted routes/assets, and runs the hosted asset browser tests. It preserves the root `dist/viewer` bundle used by the local CLI and browser tests. Temporary build output is removed on success and failure. Before promoting a deployment, open a real PR report through the preview alias by downloading and dropping its artifact.

Deploy only the linked central project after configuring its environment and confirming the intended production domain. This repository's build and tests do not prove a deployment exists.

Every push to `main` deploys to production through the [deploy workflow](../.github/workflows/deploy-viewer-host.yml), which runs the same export and verification as CI and then `eas deploy --prod --environment production`. It authenticates with the repository's `EXPO_TOKEN` secret, an EAS access token for the account that owns the project. To deploy by hand, run the same `eas deploy` command from `viewer-host` after `npm run build:hosting`. The production alias can take a minute to serve the new deployment. Never deploy the preview variant to the central project; `ci:deploy` deploys it into the reviewed application's account.

### Pull request previews

Each pull request in this repository gets its own preview of the Viewer it changes, through the [Viewer preview workflow](../.github/workflows/viewer-preview.yml): the preview variant built from the pull request, serving fixed reports from a real app, deployed to `explore-viewer-pr--pr-<number>.expo.app` in the separate `expo-public/explore-viewer-pr` project. One comment on the pull request links Map, Screens, and Compare for each platform and is updated on every push; the link keeps its token, so it never changes. The reports are the assets of the `viewer-preview-fixtures` release, not files in git. To serve newer ones, run `scripts/refresh-viewer-preview-fixtures.sh <hosted preview link> <where it came from>` (for example the latest euxy review); the next push to each pull request picks them up. To deploy by hand, run `npm run build:cli && npm run build:hosting:preview`, download the release assets, and run `node scripts/deploy-viewer-preview.mjs --fixtures <dir> --alias <alias> --project explore-viewer-pr --owner expo-public`.
