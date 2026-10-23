# Explore CI flow

How a review runs, from the pull request event to the Viewer link, and how the same pipeline runs locally. Readers who want the user-facing instructions should start with the [CI quick start](docs/quickstart-ci.md); this file is the map of the implementation.

Source of truth: `templates/explore-review.yml`, `templates/explore-baseline.yml`, `templates/explore-compare.yml`, `action.yml`, `src/ci/pipeline.ts`, `src/ci/verified-plan.ts`, `src/capture/run.ts`, `src/capture/route-capture.ts`, `src/capture/agent/*`, `test/ci/run.mjs`.

## At a glance

|  | Production (an app repository's GitHub Actions) | Local CI test (this repository) |
| --- | --- | --- |
| Entry point | `explore-review.yml` on pull requests, `explore-baseline.yml` on default-branch pushes | `npm run ci:local -- --app APP --scenario SCENARIO [--mode] [--scope]`; several cells with `npm run ci:local:matrix` |
| Tools | The `@expo/explore` release pinned by the `EXPLORE_VERSION` repository variable, installed with `npm pack` + `npm ci` against its `npm-shrinkwrap.json` | The working tree, built into `dist/` |
| App source | The pull request's exact base and head SHAs | A disposable two-commit git repository built from an app folder and a scenario overlay |
| Pipeline | `capture:review` → `runCiReview` | The same `runCiReview`, called directly |
| EAS credentials | `EXPO_TOKEN` secret | Local `eas login` session or `EXPO_TOKEN` |
| Model credentials (agent mode) | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Claude Code or Codex subscription login; API keys are removed from the subprocess |
| Base cache | A baseline workflow artifact for the exact base SHA, when one exists, or the baseline run still capturing it, waited for alongside head | None; both sides are captured |
| Output | Report artifact + sticky PR comment with **Open** / **zip** | `runs/<id>/artifacts/report.zip` + `PR-comment.md`, opened with `ci:local:view` |

## 1. Installing Explore in an app repository

`expo-explore setup` writes `.expo-explore/config.yaml`; `expo-explore setup --workflows` copies the two workflow templates into `.github/workflows/`; `expo-explore doctor` checks the result. The quick start covers the prerequisites (Node ≥ 24.12, an EAS project with EAS Simulator access, a simulator build profile in `eas.json`), the repository variable `EXPLORE_VERSION`, the `EXPO_TOKEN` secret, and the provider key for agent mode.

Why the workflows pin a release instead of using the pull request's copy of anything: the capture and publish jobs hold Expo and GitHub credentials, and the review workflow runs on `pull_request_target`, so GitHub always runs the default branch's workflow with its `EXPLORE_VERSION`. A pull request can change the app, never the tooling that captures it. The app's own build code is not sandboxed.

Older setups vendored the tools into `.github/vendor/expo-explore` and pinned them with `EXPLORE_TOOLS_COMMIT`. That flow is gone; `doctor` reports `WORKFLOW_OUTDATED` / `TOOLS_SNAPSHOT_UNUSED` and the quick start says how to migrate.

`action.yml` is a composite action with the same steps (trust check → install the pinned CLI → `source:verify` → `capture:review` → stop sessions) for repositories that want to embed Explore in their own workflow.

## 2. Production workflows

### 2.1 Triggers

| Workflow | Trigger | Condition | Result |
| --- | --- | --- | --- |
| `explore-review.yml` | `pull_request_target` (opened, synchronize, reopened, ready_for_review), `workflow_dispatch` with `pr=N` | Open, non-draft, same-repository PR whose author has write access or is listed in `ci.trustedAuthors` | Captures base and head, compares, packages a report, comments on the PR |
| `explore-baseline.yml` | `push` to the default branch, `workflow_dispatch` | Default branch only | Captures every route of one commit per configured target and uploads `explore-baseline-<sha>-<target>` for later PRs to reuse |
| `explore-compare.yml` | `workflow_dispatch` or `workflow_call` with `base` and `head` (branch, tag or SHA) | Whoever can run or call workflows (write access) | Captures base and head, compares, packages a report like a PR review (`capture:review --compare`), and links it from the run summary; no PR comment |

Each workflow starts with a `targets` job: it installs the pinned CLI and runs `expo-explore config:targets`, whose target ids (`jq -c '[.targets[].id]'`) become the matrix of the capture, report, and baseline jobs (`fail-fast: false`). A config without `targets:` has one target per platform named after it (`["ios"]`, `["ios","android"]`), so its artifact names, baselines and comment records are the ones per-platform versions wrote; a config with `targets:` lists its own (`["iphone","duo-closed","duo-open","android"]`), and several may share a platform. Every matrix job passes `--target "$TARGET"` (`TARGET: ${{ matrix.target }}`), and GitHub names each job after its target (`capture (duo-open)`), so one target's failure neither cancels nor hides another's report.

### 2.2 `explore-review.yml`

| Job | Step | What it does |
| --- | --- | --- |
| targets | Install Explore, resolve and authorize the live pull request | As in the capture job below; it exports the PR's number and commits so the failure job can comment even when a capture job fails before resolving the PR itself. Then checks out head and lists the targets. |
| capture (matrix: target) | Install Explore | Validates `EXPLORE_VERSION`, `npm pack`s that release into `$TOOLS_PREFIX`, then `npm ci --omit=dev --include=optional --ignore-scripts` against the release's shrinkwrap. The agent runtimes and `eas-cli` are optional dependencies, so `--include=optional` is what makes capture possible. The step is defined once per workflow file (a YAML anchor) and reused in every job. |
| | Resolve and authorize the live pull request | `ci:pr` reads the PR through the API. Forks, drafts and authors without write access (unless listed in `ci.trustedAuthors` of the default branch's `config.yaml`, read through the API) fail with `SOURCE_NOT_TRUSTED`. Writes `explore-pr.json` (repository, number, base/head ref and SHA) and the step outputs. Runs before any PR code is checked out. |
| | checkout `app-base`, `app-head` | Checks out the exact base and head SHAs with full history and without persisted credentials. |
| | Verify deterministic source planning | `source:verify` builds the capture plan from source alone in two fresh processes and compares the bytes. Runs before any build or simulator work and needs no credentials. |
| | Install app dependencies | `npm ci --ignore-scripts` in both checkouts (`APP_INSTALL_DIR` for monorepos). |
| | Find / Download optional exact-base evidence | `ci:find-baseline` looks for a finished run's `explore-baseline-<base sha>-<target>` artifact (a run another target's baseline failed in counts: a baseline job uploads its artifact only after its own steps passed) (target `ios` also accepts the older unsuffixed `explore-baseline-<base sha>`) from the baseline workflow on the default branch and downloads it as `EXPLORE_CAPTURE_CACHE`. With none, it names a baseline run of the base commit still queued or capturing (`pending`), held to the same checks: the baseline workflow, the default branch of this repository, a `push` or `workflow_dispatch`, exactly the base SHA; nothing from the PR head selects it. Missing evidence and a failed lookup are not errors. |
| | Capture review | `capture:review` (§3). With `EXPLORE_BASELINE_RUN` (the find step's `pending`) it waits for that run's baseline of this target (§3.1). `EXPO_TOKEN`, the provider key and the app's `{{secret:NAME}}` values reach only this step. The sticky PR comment is updated while it runs. It writes `preview=<hosting>` to the step outputs, which decides whether the deploy job runs. |
| | Stop capture sessions and check the checkouts | `ci:after-capture`, whenever the PR was resolved, success or not: stops the EAS Simulator sessions named in `head-session` / `base-session`, nothing else, then fails with `CHECKOUT_MODIFIED` if capture modified an app checkout. |
| | Upload captured review / diagnostics | `explore-capture-<run>-<attempt>-<target>` feeds the report job. On failure `explore-diagnostics-<run>-<attempt>-<target>` keeps plans, exports and agent diagnostics for 7 days. |
| report (matrix: target) | Download the capture, install Explore | Runs without Expo or model credentials, after every capture job, whether or not each succeeded (`!cancelled()`). Each leg downloads its own target's capture by an exact-name pattern: a target whose capture failed uploaded none, so its leg packages and publishes nothing, and the other targets' reports still reach the comment. |
| | Package hosted review bundle | `ci:report` writes the report directory. |
| | Upload hosted review bundle | `explore-review-<run>-<attempt>-<target>`, kept 30 days. |
| | Publish current PR hosted links | `ci:publish` re-checks that the artifact belongs to this PR, then updates the sticky comment with **Open** (the hosted Viewer) and **zip**. The comment is rendered from one hidden record per target (`<!-- expo-explore-record:<target>:… -->`, plus one history line for earlier runs); each job folds its own record into the ones the comment already carries and re-renders the whole comment, so parallel targets do not overwrite each other. Rows, report links and validation columns are labelled with the target's label (`iOS` and `Android` without `targets:`) and follow config order. |
| `deploy` (only when `report.preview` is set; after every report job, once any of them published) | Deploy the hosted preview | `ci:deploy --inputs --reports` downloads every capture and report artifact the run has (a target whose capture or report job failed has none and is left out), writes each report's manifest and screenshots as static files under the link's token, deploys them with the prebuilt preview Viewer to a dedicated EAS Hosting project (the only post-capture job holding `EXPO_TOKEN`), verifies that only `/p/<token>` answers, then updates the comment with **Explore report**. The link works as long as the EAS Hosting deployment. |
| failure | Report failure only on the current PR | Downloads whichever diagnostics exist and posts the failure comment to this PR alone, replacing only each failed target's record when the run has several; the target is the id the failed job's diagnostics artifact name ends with (or, when download-artifact extracted a lone artifact without its directory, the `target` its `error.json` records), and its label comes from the record the capture job already posted. Once the other targets published, the comment shows their reports and this failure, with no new-run line. |

A reviewer downloads the report ZIP and drops it on the hosted Viewer; downloading needs read access to the repository.

### 2.3 `explore-baseline.yml`

Validate baseline source → Install Explore → Verify deterministic source planning (base = head = this SHA) → Install app dependencies → Capture complete single-commit baseline (`capture:baseline`; any missing route fails the job) → Stop the capture session and check the checkout (`ci:after-capture`) → Upload exact-commit baseline evidence (`explore-baseline-<sha>`, 30 days) and, on failure, `explore-baseline-diagnostics-<run>-<attempt>`.

### 2.4 `explore-compare.yml`

The same jobs as a PR review, for any `base` and `head` without a pull request. The `targets` job resolves both refs once with `ci:compare-refs` (a tag wins over a branch of the same name; the same commit twice fails with `COMPARE_SAME_COMMIT`) and passes the comparison to the capture jobs, which run `capture:review --compare`; its only GitHub requests are the wait for a baseline run still capturing the base (§3.1), with the job's `actions: read` token. The optional `scope` input overrides `exploration.scope` for that run; `expires-in` is accepted and ignored. The report job's `ci:publish` writes each target's **Open** and **zip** links to the run summary, and the deploy job adds the hosted link there; nothing comments on a pull request.

## 3. Inside `capture:review` (`runCiReview`)

| # | Stage | Work | Example failure codes |
| --- | --- | --- | --- |
| 1 | `plan` | `buildVerifiedPlan`: snapshot both sources, compute the two-dot diff, run `plan-worker` twice with reversed input order and compare the canonical plans byte for byte. Summarises `sourceChange` per surface into `execution-plan.json`; the PR comment shows the planned capture count and warnings. | `SOURCE_ANALYSIS_FAILED`, inconsistent plan |
| 2 | `preflight` | Checks `EXPO_TOKEN`. `prepareCiExploration`: nothing for deterministic mode; for agent mode, confirms the instructions file is committed, creates the provider session and makes one short tool-free model request. | `AGENT_API_KEY_MISSING`, `AGENT_INSTRUCTIONS_UNCOMMITTED`, `AGENT_MODEL_NOT_FOUND` |
| 3 | `capture-head` | `runCiMap(head)` (§4). Records head's runtime profile and build. | `CAPTURE_*`, `SETUP_*`, `EAS_*` |
| 4 | `capture-base` | Tries the cache first: a baseline is reused only when its recipe matches (tools, config, instructions, device, profile, observer hash, runtime profile). Only routes missing from the cache run through `runCiMap(base)`. With no cache but a baseline run still capturing the base, base starts only once the wait for it ends (§3.1). | same |
| 5 | `compare` | `assessPublicEvidence` compares pixels and accessibility for route pairs verified on both sides; `prepareCaptureReview` assigns verdicts (§6). | |
| 6 | `capture-validation` | Every selected route was captured on both sides. | `CAPTURE_INCOMPLETE` |
| 7 | `comparison-validation` | Every pair was compared visually and for accessibility. | `COMPARISON_INCOMPLETE` |
| 8 | `notes` (agent mode) | `generateAgentChangeNotes`: a separate model session writes a per-screen explanation from the evidence and the source diff (≤ 10 minutes). It cannot change a verdict; unchanged screens keep the fixed text "No visible change." | |
| 9 | done | Writes `report-input.json` and `execution.json`, final PR comment update. | |

A failure at any stage is recorded in `state.failure`, a partial report is written when a plan exists, and the PR comment switches to the failed state.

### 3.1 Waiting for a baseline still being captured

Right after a merge, the next pull request's review starts while the baseline workflow is still capturing the new base: in brentvatne/euxy's review run 39348956443 it had started 15 s before, and every target captured its base too (10–14 minutes per target instead of about 6, on twice the EAS Simulator sessions). A baseline job takes 6–8 minutes and head capture 5–8, so `capture:review` waits for the baseline beside head instead of before it (`src/ci/baseline-wait.ts`):

1. The wait starts after preflight, only when `EXPLORE_BASELINE_RUN` names a run, no downloaded baseline matches, base has routes to capture, and `capture.baselineWaitMinutes` (default 15, 0 never waits) is not 0. Head starts capturing at once.
2. Every 20 s it reads the run (checked again by the same trust rules as `ci:find-baseline`), this target's artifact (`explore-baseline-<sha>-<target>`) in that run, and the run's jobs, logging `waiting for main's baseline run <id> of <sha> (<target>: in progress, in "<step>" for 2 min, 3 min)` once a minute or when the state changes, after one line with the run's link. The step is the one the baseline job is in: in brentvatne/euxy#179 a baseline sat 19 minutes installing ffmpeg while the line said only "in progress". When the state or the step changes, the sticky comment's line for the target says so too (`head 16/16 · base waits for the default branch's baseline (in "<step>")`), through a post that skips the PR check and never fails the review. Each read retries GitHub's 5xx and network failures (`retryGitHubLookup`).
3. When the artifact is listed, it is downloaded in-process (the token goes to GitHub, never to the storage URL it redirects to), unpacked into `<output>/baseline-download` within the cache's size limits, and restored as a downloaded baseline once head has its runtime profile. Another target's failed job does not matter; each target's job uploads its own artifact.
4. The wait ends without a baseline when this target's job fails, is cancelled or is skipped, the run ends without listing the artifact for a minute, the time runs out, GitHub refuses the token (`actions: read` missing) or keeps failing, or head fails. Base then captures at once, beside head when the sides capture concurrently. The wait never fails the review.

Head capture is never delayed. When the baseline arrives while head captures, base costs only its restore; when it does not, base starts the moment the wait gives up, so a failed baseline delays base only by the time it took to fail. Sessions are planned as without a wait: with a share of two or more, head keeps its half while base waits, so base can start in the rest; with one session, base follows head as before, and the wait may go on past head, up to its limit.

## 4. Capturing one side (`runCiMap`)

| # | Stage | Work |
| --- | --- | --- |
| 1 | cache | If a reuse directory exists, its bundle and map are validated and copied. With no routes left, skip straight to export. |
| 2 | `configuration` | `eas config --profile` confirms the app identity and scheme, `ios.simulator: true` and the bundle ID; `eas simulator:availability`. |
| 3 | `build` | `eas fingerprint:generate`; a finished simulator build with the same fingerprint is reused, otherwise `eas build --wait` (up to 45 minutes). |
| 4 | `instrumentation` | A hosted EAS `repack` workflow job (`eas workflow:run --json` from a staged copy of the checkout, then its run read until it ends) rebundles the current JavaScript with a read-only navigation observer (the same observer on both sides), and the repacked app is downloaded and installed into the session; `capture.repack: local` (the default with `capture.simulator: local`) runs `@expo/repack-app` on the runner, and its app is installed without an upload. Generated files stay outside the checkout. Preparing the app has one 30-minute budget, a failed hosted repack starts again, and a run attempt's matrix jobs make one repack of each commit between them (§4.1). |
| 5 | `session` | `eas simulator:start`; the session ID is written to `<side>-session`; the app is installed. |
| 6 | route capture | Mode-specific (§5). `agent-device` drives the simulator and records a screenshot plus the accessibility tree. A capture is accepted only when the observer's reported destination matches the requested route. |
| 7 | `export` / `cleanup` | Validate the map, write `<side>-export/` (`bundle.json`, `execution.json`, PNGs, `capture-diagnostics/`), stop the session. |

### 4.0 Timings and heartbeats

Every capture job appends its timings to `$RUNNER_TEMP/explore-diagnostics/timings.jsonl` as it runs (`src/shared/timings.ts`). The diagnostics artifact already uploads that folder `if: always()`, so no workflow change is needed, and a job killed partway leaves what it did up to then.

- **Spans.** The review's and the baseline's phases (`controllers`, `plan`, `preflight`, `capture`, `compare`, `notes`, `report`). For each side and appearance pass: `configuration`, `fingerprint`, `build-lookup`, `native-build`, `repack`, `repack-share-wait`, `build-download`, `session-start` (from the request, beside the repack, to the session EAS hands over), `session-verify`, `install`, `launch`, each `route`, and `session-stop`. Spans overlap: head runs beside the baseline wait, and the session starts beside the repack.
- **The wait for a baseline.** `baseline-wait` is the whole wait, beside head; `baseline-blocked` is what it cost, from where base would have started to its end. The steps the baseline job finished, or was still in, are recorded as `baseline-step`.
- **What is written.** Phase names, ids, counts, durations and outcome codes; strings pass `safeText` (redacted, no links, one short line), and links are rebuilt from validated ids (`githubRunLink`, `easPageLink`), never copied from eas-cli's output. A simulator session's link is never written: sessions start with `--public-link`.
- **The summary.** The capture command appends a table to the job summary when it ends; `ci:after-capture` does for a capture stopped before it could.
- **Heartbeats.** A poll-driven wait prints when it starts and once a minute after: the baseline wait, the hosted repack (its state, time waited and budget left) and a shared repack being followed. A call that blocks its thread prints its bound first (`eas build --wait` 45 minutes, `workflow:run` 10, `build:download` 10, the app install 15). A side on a worker thread (sides captured at once, split appearance passes) has its parent print `head: still in install (3 min of at most 15 min)` once a minute while it is blocked; on the main thread nothing can run meanwhile.

### 4.1 The hosted repack: one budget, retries, and one repack per commit for a run's jobs

`prepareHostedRepack` (`src/capture/eas-build.ts`) runs the repack job. Three things keep it from failing a target, running long, or repeating work.

**One budget.** Preparing the app gets 30 minutes (`HOSTED_REPACK_BUDGET_MS`), counted from the moment the EAS session starts beside the repack. That covers waiting for another job's repack, following it, and every repack this job starts, including each run's wait. Before this, each run had a 30-minute wait of its own, so a share wait plus retries could prepare for over an hour. The rules:

- A repack starts only when at least 5 minutes of the budget are left.
- A run still going at the end of the budget is cancelled, and the target fails with `EAS_REPACK_FAILED` (`failure: timeout`).
- The session was asked for the capture's minutes plus a 20-minute allowance (`SESSION_PREPARATION_MINUTES`). If the app took longer than the allowance, the session is stopped and a fresh one started before the install, so the capture keeps all its minutes. This counts as one of the session's replacements.

**Explore waits on the run itself.** `workflow:run` runs without `--wait`. Explore reads the run's id from the JSON, or from the "See logs:" link if the JSON is missing, then reads `eas workflow:view <id> --json` every 20 s. It does not use `--wait` because eas-cli 25.2.0's `--wait` exits with code 13 after six failed status reads and leaves the run going, and Explore then started another one beside it. Now:

- A run whose state stays unreadable six times in a row is cancelled (`eas workflow:cancel`). So is a run that outlasts the budget, or whose capture is stopped. None of them is replaced.
- If the start times out, `defaultRunner` keeps what it printed. When that names the run, Explore waits on it. When it doesn't, Explore starts no other, because one may be running.
- `capture:review` and `capture:baseline` turn the runner's SIGINT and SIGTERM, which GitHub sends to a cancelled job, into an abort. The capture then stops its session and cancels the run it waits on. A second signal quits at once.

**A failed repack starts again.** In brentvatne/euxy#176 (review run 39506405687), EAS ended a repack's build while its "Upload artifact" step was saving the app ("Turtle build is not in progress", reported as `Failed to upload application archive.`), and the target failed with `EAS_REPACK_FAILED`. Only a run EAS reports finished can be followed by another. `hostedRepackFailure` reads the build's error, the job's errors, the failed step's logs (`eas workflow:logs <job> --json`) and the CLI's output, in this order:

| Failure | Read from | Fresh repacks |
| --- | --- | --- |
| `canceled` | a run someone cancelled | 0 |
| `configuration` | `Not logged in`, `Unauthorized`, `not authorized`, `E401`/`E403`, `401 Unauthorized`/`403 Forbidden` (a private registry's included) | 0 |
| `infrastructure` | a file of EAS's worker missing (`'/opt/eas/…'`) | 2 |
| `app` | the `Repack` / `Repack app` step failed, or Metro, Babel or Expo named the app's code or files: `Unable to resolve`, `SyntaxError`, `TransformError`, `Cannot find module`, `could not read ./…` | 0 |
| `timeout` | `EAS_BUILD_TIMEOUT_ERROR`: a rerun would run out its time again (a bundling hang, say) | 0 |
| `infrastructure` | a failed `Spin up…`, `Set up…`, `Download…` or `Upload…` step; EAS's or eas-cli's exact words (`Turtle build is not in progress`, `Failed to upload application archive`, `SERVER_ERROR`, `Failed to upload project sources`, `Failed to start the workflow with the API`, `Unexpected response from server (5xx)`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `socket hang up`, `fetch failed`) | 2 |
| `unknown` | nothing above | 1 |

Each new start logs the failed run's link and reason, for example `the hosted EAS repack https://expo.dev/…/workflows/<id> failed (…); starting another repack (1/2)`. The session is started once, beside the first repack, and installs whichever repack succeeds.

**One repack per commit for a run attempt's matrix jobs.** Captures that run in one process already share a build in a directory (`src/capture/shared-build.ts`): the appearance passes of one side, which run in worker threads, and the targets of a local review. The first to claim a key builds and repacks, and the others wait for its `result.json` ("using the build another capture of this run is preparing for this commit"). A GitHub matrix job is a runner of its own, with no directory in common, so in #176 the four iOS jobs each logged `reusing EAS build a81d5d80 … repacking it with this commit's JavaScript` and made four identical repacks. The jobs of one run attempt meet on EAS instead:

1. `hostedRepackPeers` lists, in config order, the targets that repack the same app on EAS: one platform, EAS profile and bundle id. `capture:review`, `capture:review --compare` and `capture:baseline` pass them on.
   - A capture gets a `RepackShare` when it has two or more peers and `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` and `GITHUB_REPOSITORY` are set. Its scope is the run attempt, its leader is the first peer, and its rank is its place among the peers.
   - A single target, a local review, `capture.repack: local`, and a native build this job made itself behave as before. Nobody else's key can match a native build this job made.
2. The build to repack is the newest finished build with the fingerprint that Explore did not repack itself (`existingBuild`, from 20 builds). If repacks carry their source's fingerprint, every job still picks the same build.
3. Once the copy is staged, the capture takes a key (`hostedRepackShareKey`) from:
   - the run attempt, the platform and the native build id;
   - the EAS profile and environment name;
   - a snapshot of the environment's variables: `eas env:list --format long` for the project and the account, which names each variable with its value (masked when sensitive or secret) and when it was last updated;
   - the Explore release;
   - a digest of every staged file with its path, executable bit and content (`stagedProjectDigest`), which covers the commit's JavaScript and the generated observer.

   If either variable list fails, the capture repacks without sharing. Its own repack's message ends with `[explore share <key>]`.
4. It reads the platform's 50 most recent builds (`eas build:list --limit 50 --json`, a single page) for one whose message ends with that marker, and joins any it finds, whichever job started it. A finished one is downloaded instead of repacking. A queued or running one is then read by its id (`eas build:view <id> --json`) every 30 s, so newer builds on a busy project cannot push it off the list.
5. How long a capture looks is staggered (`sharedRepackWaitMs`). The leader looks once and repacks if it finds nothing. The next target looks every 15 s for 3 minutes, and each target after it a minute longer. When the leader makes no repack (its baseline covered every route, or `max-parallel` kept it out of the first jobs), the next target's repack appears before the one after it would start another, so they all join one. In a re-run attempt, which runs only the jobs it re-runs, the stagger starts at once (1, 2, 3 minutes).
6. When the repack it follows fails, is cancelled or loses the key, the capture looks for another with the same key for 60 s, staggered the same way, before it repacks itself. That catches the leader's retry, which starts at once (#176).
7. It also repacks itself, with the retries above, when nothing appears in its wait, or when EAS fails to answer three times in a row. Looking stops while the budget still has 5 minutes for a repack of its own. A followed repack that does not finish within the budget fails the target. No capture waits on a job that cannot answer, and none waits past its budget.

Only a build whose marker is this capture's own key is used, and every input to the key is what this capture would itself have uploaded and built with. So two jobs share a repack only when their uploads, native build, profile, environment variables and Explore release are the same, in the same run attempt. The run attempt is in the scope, and a review's or a first attempt's repacks are never used by another run or attempt. That covers the baseline workflow, whose artifacts later reviews reuse, and "Re-run failed jobs" after an `EXPO_PUBLIC_*` value was fixed, which rebundles with the new value.

What the key does not protect against: every input to it is public or predictable, and the pull request's head code runs in the capture job with `EXPO_TOKEN` (`app.config.*` under `eas config` and `eas fingerprint:generate`, and the app's build code on EAS). Head code could therefore make a build whose message carries the base side's marker, and base captures of the same run attempt in other matrix jobs would install it. That is within the trust the capture already gives EAS: the same credentials could publish a simulator build with a reused fingerprint, which every capture already reuses by fingerprint (the `build` stage above), and head code in one job can already tamper with that job's own base side on the runner. The run attempt in the scope keeps such a build out of every other run, including the baseline. Requiring the build's `initiatingActor` to be this job's own credentials would not exclude head code, which runs with the same token. Explore cannot tell offline which actor EAS records for a workflow's repack build, so it does not check it.

Cost, per side and job:

- The leader makes 1 `build:list` and 2 `env:list`.
- A follower makes up to 13 `build:list` while the next target waits, plus 4 more per target after it.
- About 2 `build:view` a minute while it follows a repack: about 10 for a 5-minute repack.
- Each repack this job runs reads its run every 20 s: about 15 `workflow:view` for 5 minutes, and one `workflow:logs` if it fails.

In #176's run that is about 20 calls per side for each of the three iOS targets that would otherwise have repacked, in place of three repacks. A follower whose leader and earlier peers make no repack of this side loses its wait, 3 to 5 minutes, before it repacks itself. Native builds are not shared across jobs: a fingerprint EAS has no build for is built by every job that needs it.

## 5. Deterministic and agent modes

| | Deterministic | Agent |
| --- | --- | --- |
| Config | `mode: deterministic`, optional `setup` and `parameters` | `mode: agent`, `agent.provider` / `model` / `instructions`, optional `setup` |
| Model use | None | Throughout capture: navigation, recovery, readiness checks, notes |
| Reaching a screen | Replays `setup`, then deep-links to every other route | The agent operates the UI from the current screen; deep links remain available |
| Preconditions | `setup` actions only (`open`, `tap`, `fill`, `type`, `scroll`, `wait`; `requiresRoute` for routes that exist on one side) | Prose in the instructions file; `setup` is an initial replay the agent can recover from |
| `setup` failure | Capture stops; remaining routes fail | The agent tries to recover |
| Acceptance | `ready` condition holds and the observer destination matches | The exact image the agent saw, destination match, and a separate readiness session passes |
| Retry | One retry for a transient route failure | The agent decides; `stop_blocked` when it cannot continue |
| Notes | Template text plus evidence facts | AI explanation on top; verdicts unchanged |
| Route without a deep link | Not captured (uncovered) | Captured when reachable through the UI and the observer identifies one source route |
| Fits | Stable flows with fixed selectors | Sign-in, branching and state-dependent flows |
| Cost | EAS only | EAS plus model usage, recorded in `agent-usage.jsonl` |

### 5.1 Deterministic capture (`capturePlannedRoutes`)

1. Run `setup` actions in order; `{{secret:NAME}}` is substituted at execution time; actions whose `requiresRoute` is absent on this side are skipped.
2. When an action's `ready` condition holds on a selected route, capture immediately (prepared target); a transient failure gets one retry from a fresh snapshot.
3. A `setup` failure leaves a diagnostic screenshot and accessibility tree in `capture-diagnostics/` and marks the remaining routes `SETUP_FAILED`.
4. Remaining routes: open `scheme://path` with `parameters`, confirm the landing, capture; at most two attempts.
5. iOS "open link" confirmations and the save-password sheet (Not Now) are handled; any other alert is `CAPTURE_BLOCKED_BY_ALERT`.
6. Exceeding `maxActions` / `maxMinutes` ends the side with `budget-exhausted`.

### 5.2 Agent capture

1. Preflight: instructions committed, provider runtime ready (Claude Agent SDK or Codex app-server), model reachable.
2. `agentCaptureConstraints` removes literals that differ between base and head from the shared readiness landmarks.
3. Replay `setup` if present; a failure is passed to the agent as information.
4. Start the navigation session. Tools: `observe` (accessibility tree, image on demand), `act` (open, tap, fill, type, scroll, wait, back, dismiss-keyboard), `read_source`, `get_progress`, `capture`, `finish`, `stop_blocked`.
5. On `capture`: the exact PNG the agent saw, the route destination and the context are checked, then a separate model session (`assessCaptureReadiness`, ≤ 90 seconds) rules on loading states, overlays and blank frames. Rejected frames go to `capture-diagnostics/readiness/`.
6. `finish` after every target is captured and the instructions' procedure is complete; `stop_blocked` fails the side with the partial evidence.
7. Secrets are visible to the model only as `{{secret:NAME}}` references; the coordinator types the values. A screenshot is refused if a secret value shows up in the accessibility tree.
8. After the comparison, the `notes` stage (§3, row 8) writes the explanations.

## 6. Verdicts

| Source change \ evidence | Differs | Same | Not comparable |
| --- | --- | --- | --- |
| Route added / removed | Added / Removed | Added / Removed | Added / Removed |
| Screen source changed (`screen`) | Modified | Unchanged (not counted as a change) | Needs review |
| Only app-wide inputs changed (`app-wide`) | Modified | Unchanged (one line in the PR comment) | Needs review |
| No source change (`none`) | Screen variant (listed apart from Changes) | Unchanged | Unchanged |

A screen whose source changed but whose screenshots were not compared (it is outside the capture scope) has no
verdict: the PR comment does not list it, the agent API reports `not-compared`, and the Viewer marks it Not compared.
Earlier versions listed it as Source-affected. A planned capture that failed is counted as unavailable and named under
Validation.

"Differs" means the screenshots differ or the accessibility tree does. A Modified screen whose screenshots match is
**Accessibility only**: what screen readers and voice control read changed (a label, a role, an element added to the tree)
but nothing shows in the capture. It is still a change: the PR comment counts it apart ("3 visual changes · 12
accessibility only") under 🟦 Accessibility only, the Viewer marks it blue and Compare steps through it, and the agent API
reports `status: "accessibility-only"` with `sourceStatus: "modified"`. The report contract is unchanged (its review
status stays `modified`), so earlier reports read the same way. The accessibility tree can include content outside the
screenshot, such as rows scrolled below the fold or elements under a sheet, so an accessibility-only change is not always
invisible on a device.

A pixel mismatch that rounds to 0.00% is noise and counts as "same". Diff regions inside the status-bar band are excluded from the verdict and reported as `ignoredStatusBarRegions`; the Viewer marks that band in Compare.

Each changed region also records whether its content only moved. CI searches for the shift (up to 20 screenshot
pixels vertically and 4 horizontally, whole pixels and then sixths of one) that best lines Before up with After inside
the region; near-ties go to the smallest move, and a second fit nearly as good two or more pixels away (repeating
content) or a best fit at the edge of the search leaves the region unmeasured. When the shift explains most of the
region's difference (a quarter for a move of half a pixel or less, where text re-rasterizes rather than moves; 60%
above that) and, aligned by it, no more than two pixels still differ by over 140 in any channel, the region gets
`shift: { x, y }` in screenshot pixels (right and down positive). New text, another colour or a caret is not a move.
Every region the comparison found is measured, not only the eight it publishes, and `allRegionsMoved: true` says all
of them moved. Moves are measured while the comparison's time budget lasts.

The Viewer draws moved areas dashed, at each side's own position, labelled with how far they moved to a tenth
("↑4.1pt"); areas whose moves are within a third of each other merge into one outline, never around a changed area.
When every region moved, What changed says how far per direction in place of the generic visual finding, and adds
"Nothing on this screen changed content" when no other finding remains. A switch there turns the labels off. iOS
screenshots are one pixel per point, so labels read in points; Android's are labelled in screenshot pixels, since the
report does not know the screen's density.

## 7. Local CI test

`test/ci/run.mjs` runs the production pipeline against an app folder in this repository (`test/ci/apps/wallet`) and a scenario (`test/ci/scenarios/<app>/<name>/`: `scenario.json`, `overlay/`, `expected.json`, optional `setup.yaml`). The [local CI test harness README](test/ci/README.md) covers prerequisites, scenarios, expectations, the matrix runner and how to revisit a result. In outline:

1. `npm run build:cli`; create `test/ci/runs/<run-id>/` (never overwritten).
2. Freeze the inputs under `inputs/` (scenario, config, effective config with the setup slot filled and scope applied, instructions, expectations, source digests).
3. Build the disposable two-commit git repository: base = the app, head = app − `removed` + `overlay`. The planner computes the diff exactly as in production.
4. `--plan-only` stops after `buildVerifiedPlan` and the plan-level expectations; no install, model or EAS.
5. Otherwise `runCiReview` with `subscription: true`, the local EAS login, and `EXPLORE_CAPTURE_CACHE` unset. App dependencies are installed right before capture (`prepareCapture`), and an app `typecheck` script runs on both sides so a broken overlay fails before EAS.
6. Export `artifacts/report.zip` (partial on failure when a plan exists), compare `report/review.json` with `expected.json` into `run.json.expectations` (mismatch exits 1), write `PR-comment.md`, `agent-mode-cost.md`, `issues.md`, `logs/events.jsonl`.
7. `npm run ci:local:view -- --run test/ci/runs/<id>` opens the report in a local Viewer; `ci:local:recompare` reruns compare, notes and export from the existing captures; `ci:local:matrix` runs several scenario:mode:scope cells in parallel processes.

Ctrl+C requests cancellation and waits for the capture sessions to be cleaned up.

Differences from production: no trust or permission checks; no base cache; report packaging happens in the same process instead of a separate credential-free job; the PR comment is a file; models run through the subscription CLIs with instructions committed to the disposable snapshot.

## 8. This repository's CI (`.github/workflows/ci.yml`)

On pull requests and pushes to `main`: `npm test` (build + node suite), `npm run typecheck`, `npm run lint`, `npm pack --dry-run`, the Playwright Viewer e2e suite, hosted artifact loading tests, and the Viewer host's typecheck, tests and export. No simulator capture runs here; that is what the local CI test is for. `publish.yml` publishes any `package.json` version npm does not have yet.
