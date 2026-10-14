# Report access and capture evidence

Private and public repositories use the same [source-driven CI workflow](quickstart-ci.md). GitHub Actions stores the report artifact; reviewers download it and drop it on the central Viewer, which renders it in the browser.

## Access

Report bytes move from GitHub to the reviewer's browser only. GitHub decides who can download the artifact: the reviewer signs in to GitHub and needs read access to the repository, for public and private repositories alike. The Viewer keeps no GitHub credential, no repository allowlist, and no report store, so nothing is enabled per repository on Expo's side. Report links are not access tokens: a link only names the run whose report the page expects.

The page that **Open** opens verifies that a dropped ZIP is the report for that run attempt (its `review.json` names the repository, run, and attempt) and refuses other files with the expected file name. It keeps the dropped ZIP in that browser's cache (up to four reports, 256 MiB, seven days) so reloads and per-screen links open without another drop; nothing is uploaded or shared between browsers, and clearing site data removes the copies. Artifacts follow the workflow's retention period (30 days in the templates); after that, rerun Explore.

The Viewer reads the ZIP supplied by the reviewer; it has no hosted artifact download endpoint or separate Viewer login.

## Hosted previews

Hosted previews are off by default. When `report.preview.hosting: eas` is set, the review workflow's `deploy` job uploads each run's reports (one per captured platform) to an [EAS Hosting](https://docs.expo.dev/eas/hosting/introduction/) deployment in your Expo account, and the comment shows an **Explore report** link that opens it directly, in place of the **Open** drop page. The GitHub artifact and **zip** stay as they are.

**What a reviewer needs.** Only the link. It looks like `https://acme-explore--k7f3z0d1q8.expo.app/p/f6r2…` and carries a 160-bit token generated for that run. It opens the Viewer and the report for one PR revision; it does not show the repository, other runs, or anything else in the Expo account.

**Several platforms.** One deployment holds every platform's report. The link opens the primary platform's report (`?platform=ios` or `?platform=android` selects one); the Viewer's platform menu lists the others from `/p/<token>/reports.json`, which names each platform, its device, and its change count and nothing else. Every report and the listing sit behind the same token and expiry.

**What is protected, and how.**

- *The report bytes.* `ci:deploy` zips the report and encrypts it (AES-256-GCM) before upload. The key is stored only in that deployment's server environment; it never appears in a URL, a log line, or a comment. The files on the CDN are ciphertext.
- *Access to the decrypted report.* A server route in the deployment checks the token and the expiry, fetches the ciphertext from its own deployment, decrypts it, and streams it to the browser. Without the exact token every path under the deployment answers `404`, including the Viewer itself; `ci:deploy` verifies this before it publishes the link.
- *Expiry.* The expiry (`report.preview.expiresAfter`, 30 days by default, `never` to disable) is sealed into the deployment when it is created and enforced by the route, not by the browser. After it passes, the exact token still opens the Viewer for a browser, but the report routes, the Markdown index, and the agent API answer `410` and the Viewer says the link expired on that date; every other path still answers `404`. To revoke a link earlier, delete the deployment in the EAS Hosting dashboard; the CDN stops serving it within seconds and the route within a few minutes.
- *Deletion.* Nothing is deleted automatically. Each review of a pull request deploys a new preview and the comment links the newest one (recorded in a hidden `<!-- expo-explore-deployments:… -->` line under the comment marker); earlier deployments and the deployments of closed pull requests stay until someone deletes them in the EAS Hosting dashboard or with `eas deploy:delete`, so a link keeps opening for as long as its expiry allows.
- *The Viewer itself.* The Viewer's JavaScript is public and the same for every deployment; it holds no report data.
- *Agent access.* The same link also answers as Markdown and as a JSON API (`/llms.txt`, `/api/v1/...`, see [the agent guide](../README.md#agents)) so a coding agent can read the report without a download. Those routes are served by the same server route from the same decrypted bytes, behind the same token, expiry, `private, no-store`, and `noindex`; they add no second credential and no new place where the report is stored.

**What is not protected.** The link is a bearer credential. Anyone who receives it, by forwarding the comment, a notification email, or a chat message, can open the report until it expires. Members of the Expo account who can inspect the preview project's deployments can read the key. Expo's request logs record URL paths, so they record the token; they do not record the report. Keep the default drop flow when a leaked link would be a problem.

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
