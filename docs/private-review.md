# Report access and capture evidence

Private and public repositories use the same [source-driven CI workflow](quickstart-ci.md). GitHub Actions stores the report artifact; reviewers download it and drop it on the central Viewer, which renders it in the browser.

## Access

Report bytes move from GitHub to the reviewer's browser only. GitHub decides who can download the artifact: the reviewer signs in to GitHub and needs read access to the repository, for public and private repositories alike. The Viewer keeps no GitHub credential, no repository allowlist, and no report store, so nothing is enabled per repository on Expo's side. Report links are not access tokens: a link only names the run whose report the page expects.

The page that **Open** opens verifies that a dropped ZIP is the report for that run attempt (its `review.json` names the repository, run, and attempt) and refuses other files with the expected file name. It keeps the dropped ZIP in that browser's cache (up to four reports, 256 MiB, seven days) so reloads and per-screen links open without another drop; nothing is uploaded or shared between browsers, and clearing site data removes the copies. Artifacts follow the workflow's retention period (30 days in the templates); after that, rerun Explore.

The Viewer reads the ZIP supplied by the reviewer; it has no hosted artifact download endpoint or separate Viewer login.

## Hosted previews

Hosted previews are off by default. When `report.preview.hosting: eas` is set, the review workflow's `deploy` job uploads each run's reports (one per captured platform or target) to an [EAS Hosting](https://docs.expo.dev/eas/hosting/introduction/) deployment in your Expo account, and the comment shows an **Explore report** link that opens it directly, in place of the **Open** drop page. The GitHub artifact and **zip** stay as they are.

**What a reviewer needs.** Only the link. It looks like `https://acme-explore--k7f3z0d1q8.expo.app/p/f6r2…` and carries a 160-bit token generated for that run. It opens the Viewer and the report for one PR revision; it does not show the repository, other runs, or anything else in the Expo account.

**Several platforms or targets.** One deployment holds every target's report (a config without `targets` has one per platform). The link opens the first one (`?target=<id>` selects another, and `?platform=ios` or `?platform=android` from older links still works); the Viewer's menu lists the others from `/p/<token>/reports.json`, which names each target, its platform, label, device, and change count and nothing else. Every report and the listing sit behind the same token.

**What is protected, and how.**

- *The token.* Every path of a preview carries the link's 160-bit token: the page at `/p/<token>`, each target's manifest at `/p/<token>/targets/<target>.json`, and every screenshot at `/p/<token>/assets/<sha256>.<ext>`. Nobody can find a path without the token. With any other token, every path under the deployment answers `404`, including the Viewer itself; `ci:deploy` verifies this before it publishes the link.
- *The report's files.* `ci:deploy` uploads the report as plain static files of the deployment, under the token. They are not encrypted: the token in their paths is what keeps them private, the same way it keeps the link private. EAS Hosting serves them directly, with its own default headers (the browser may cache a screenshot for an hour). The deployment's server route serves the page, the manifest the Viewer asks for, the target listing and the agent API, with `private, no-store` and `noindex`.
- *How long a link works.* A link works as long as its EAS Hosting deployment exists. Explore sets no expiry of its own. EAS Hosting deletes a deployment after 30 days on the Free plan and 90 days on paid plans, **unless an alias points at it**: an aliased deployment (such as `--alias` uploads of `explore:binary`) is kept until the alias moves or is deleted. To end a link sooner, delete the deployment in the EAS Hosting dashboard or with `eas deploy:delete` (delete its alias first if it has one); the CDN stops serving its files within about five minutes. To expire links on your own schedule, delete deployments from a scheduled job. Deleting a deployment does not reach into a browser that already opened the link: what that browser cached stays until it ages out. `report.preview.expiresAfter` and `--expires-in` from earlier versions are accepted and ignored, with a warning.
- *Deletion.* Explore deletes nothing. Each review of a pull request deploys a new preview and the comment links the newest one (recorded in a hidden `<!-- expo-explore-deployments:… -->` line under the comment marker); earlier deployments and the deployments of closed pull requests stay until EAS Hosting deletes them as above, or someone deletes them in the dashboard or with `eas deploy:delete`.
- *The Viewer itself.* The Viewer's JavaScript is public and the same for every deployment; it holds no report data.
- *Agent access.* The same link also answers as Markdown and as a JSON API (`/llms.txt`, `/api/v1/...`, see [the agent guide](../README.md#agents)) so a coding agent can read the report without a download. Those routes read the same static files, behind the same token, with `private, no-store` and `noindex`; they add no second credential and no new place where the report is stored.

**What is not protected.** The link is a bearer credential. Anyone who receives it, by forwarding the comment, a notification email, or a chat message, can open the report until the deployment is deleted, and anyone who sees a screenshot's URL can fetch that screenshot. Members of the Expo account who can inspect the preview project's deployments can read its files. Expo's request logs record URL paths, so they record the token. Keep the default drop flow when a leaked link would be a problem.

**Comparison with the default.** The default flow uses GitHub's own permissions: a reviewer must be signed in to GitHub with read access to the repository to download the report. Hosted previews trade that check for one-click opening. Choose them when the review audience is the people who already see the PR.

**What the `deploy` job receives.** The capture and report artifacts, `EXPO_TOKEN` (to create the preview project once and deploy to it), and `pull-requests: write` (to update the comment). It does not receive the app's test secrets or model API keys; capture, report, and deploy are separate jobs, and the report job remains credential-free.

**The token.** Use an access token of a [robot user](https://docs.expo.dev/accounts/programmatic-access/) that is allowed to create projects in the account, created in the Expo dashboard; `eas-cli` has no command for creating tokens.

## Capture source and evidence

No authored surface file, fixture inventory, required landmark, or runtime probe is needed. The analyzer discovers routes from Expo Router files or React Navigation registrations at exact commits. Parameter values and structured setup are optional execution inputs, never additional route definitions.

The selected device comes from config.yaml. App data, time, and network remain live. Captures collect actual screenshots and accessibility evidence, validate files, and keep per-target outcomes. A discovered route without a usable entry link remains visible as uncovered. Redirects and structural source edges are not represented as observed interactions.

The repeatability guarantee covers canonical planning and comparison of fixed evidence. It does not promise identical live screenshots. See [capture and comparison behavior](public-capture-review.md).

## CI trust boundary

Automatic capture is restricted to open, non-draft, same-repository PRs whose authors have current write access, plus the logins listed under `ci.trustedAuthors` in the default branch's `.expo-explore/config.yaml` (bots such as `devin-ai-integration[bot]`; the workflow reads the default branch, so a pull request cannot add its own author). The workflow resolves current metadata through GitHub's API and executes tools from a reviewed pinned snapshot. App dependencies and build code still execute within the authorized capture job.

The report job receives only captured data and the permissions needed to read artifacts and publish a comment. It does not receive Expo or model credentials. Publication verifies that the PR still refers to the captured base/head before marking a report ready.

Generated files remain outside source checkouts. Intermediate evidence and diagnostics expire after 7 days; final reports and baselines expire after 30 days.

## Review

Open **Open** from the PR comment and drop the report downloaded with **zip**. The report identifies the exact captured revisions. Changes, Map, Screens, inspectors, variants, and downloads use the existing Viewer.

Record actual CI run, commit, artifact, device, and cleanup results during acceptance. Passing fixture tests alone does not establish a real report download or simulator capture.
