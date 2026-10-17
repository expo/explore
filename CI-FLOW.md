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
| Base cache | A baseline workflow artifact for the exact base SHA, when one exists | None; both sides are captured |
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
| | Find / Download optional exact-base evidence | `ci:find-baseline` looks for a successful `explore-baseline-<base sha>-<target>` artifact (target `ios` also accepts the older unsuffixed `explore-baseline-<base sha>`) from the baseline workflow on the default branch and downloads it as `EXPLORE_CAPTURE_CACHE`. Missing evidence is not an error. |
| | Capture review | `capture:review` (§3). `EXPO_TOKEN`, the provider key and the app's `{{secret:NAME}}` values reach only this step. The sticky PR comment is updated while it runs. It writes `preview=<hosting>` to the step outputs, which decides whether the deploy job runs. |
| | Stop capture sessions and check the checkouts | `ci:after-capture`, whenever the PR was resolved, success or not: stops the EAS Simulator sessions named in `head-session` / `base-session`, nothing else, then fails with `CHECKOUT_MODIFIED` if capture modified an app checkout. |
| | Upload captured review / diagnostics | `explore-capture-<run>-<attempt>-<target>` feeds the report job. On failure `explore-diagnostics-<run>-<attempt>-<target>` keeps plans, exports and agent diagnostics for 7 days. |
| report (matrix: target) | Install Explore, download the capture | Runs without Expo or model credentials. |
| | Package hosted review bundle | `ci:report` writes the report directory. |
| | Upload hosted review bundle | `explore-review-<run>-<attempt>-<target>`, kept 30 days. |
| | Publish current PR hosted links | `ci:publish` re-checks that the artifact belongs to this PR, then updates the sticky comment with **Open** (the hosted Viewer) and **zip**. The comment is rendered from one hidden record per target (`<!-- expo-explore-record:<target>:… -->`, plus one history line for earlier runs); each job folds its own record into the ones the comment already carries and re-renders the whole comment, so parallel targets do not overwrite each other. Rows, report links and validation columns are labelled with the target's label (`iOS` and `Android` without `targets:`) and follow config order. |
| `deploy` (only when `report.preview` is set; after every report job) | Deploy the hosted preview | `ci:deploy --inputs --reports` downloads every target's capture and report artifacts, zips and encrypts each report, deploys it with the prebuilt preview Viewer to a dedicated EAS Hosting project (the only post-capture job holding `EXPO_TOKEN`), verifies that only `/p/<token>` answers, then updates the comment with **Explore report** and the link's expiry. |
| failure | Report failure only on the current PR | Downloads whichever diagnostics exist and posts the failure comment to this PR alone, replacing only the failed target's record when the run has several; the target is the id the failed job's diagnostics artifact name ends with, and its label comes from the record the capture job already posted. |

A reviewer downloads the report ZIP and drops it on the hosted Viewer; downloading needs read access to the repository.

### 2.3 `explore-baseline.yml`

Validate baseline source → Install Explore → Verify deterministic source planning (base = head = this SHA) → Install app dependencies → Capture complete single-commit baseline (`capture:baseline`; any missing route fails the job) → Stop the capture session and check the checkout (`ci:after-capture`) → Upload exact-commit baseline evidence (`explore-baseline-<sha>`, 30 days) and, on failure, `explore-baseline-diagnostics-<run>-<attempt>`.

### 2.4 `explore-compare.yml`

The same jobs as a PR review, for any `base` and `head` without a pull request. The `targets` job resolves both refs once with `ci:compare-refs` (a tag wins over a branch of the same name; the same commit twice fails with `COMPARE_SAME_COMMIT`) and passes the comparison to the capture jobs, which run `capture:review --compare` with no GitHub requests. The optional `scope` and `expires-in` inputs override `exploration.scope` and `report.preview.expiresAfter` for that run. The report job's `ci:publish` writes each target's **Open** and **zip** links to the run summary, and the deploy job adds the hosted link there; nothing comments on a pull request.

## 3. Inside `capture:review` (`runCiReview`)

| # | Stage | Work | Example failure codes |
| --- | --- | --- | --- |
| 1 | `plan` | `buildVerifiedPlan`: snapshot both sources, compute the two-dot diff, run `plan-worker` twice with reversed input order and compare the canonical plans byte for byte. Summarises `sourceChange` per surface into `execution-plan.json`; the PR comment shows the planned capture count and warnings. | `SOURCE_ANALYSIS_FAILED`, inconsistent plan |
| 2 | `preflight` | Checks `EXPO_TOKEN`. `prepareCiExploration`: nothing for deterministic mode; for agent mode, confirms the instructions file is committed, creates the provider session and makes one short tool-free model request. | `AGENT_API_KEY_MISSING`, `AGENT_INSTRUCTIONS_UNCOMMITTED`, `AGENT_MODEL_NOT_FOUND` |
| 3 | `capture-head` | `runCiMap(head)` (§4). Records head's runtime profile and build. | `CAPTURE_*`, `SETUP_*`, `EAS_*` |
| 4 | `capture-base` | Tries the cache first: a baseline is reused only when its recipe matches (tools, config, instructions, device, profile, observer hash, runtime profile). Only routes missing from the cache run through `runCiMap(base)`. | same |
| 5 | `compare` | `assessPublicEvidence` compares pixels and accessibility for route pairs verified on both sides; `prepareCaptureReview` assigns verdicts (§6). | |
| 6 | `capture-validation` | Every selected route was captured on both sides. | `CAPTURE_INCOMPLETE` |
| 7 | `comparison-validation` | Every pair was compared visually and for accessibility. | `COMPARISON_INCOMPLETE` |
| 8 | `notes` (agent mode) | `generateAgentChangeNotes`: a separate model session writes a per-screen explanation from the evidence and the source diff (≤ 10 minutes). It cannot change a verdict; unchanged screens keep the fixed text "No visible change." | |
| 9 | done | Writes `report-input.json` and `execution.json`, final PR comment update. | |

A failure at any stage is recorded in `state.failure`, a partial report is written when a plan exists, and the PR comment switches to the failed state.

## 4. Capturing one side (`runCiMap`)

| # | Stage | Work |
| --- | --- | --- |
| 1 | cache | If a reuse directory exists, its bundle and map are validated and copied. With no routes left, skip straight to export. |
| 2 | `configuration` | `eas config --profile` confirms the app identity and scheme, `ios.simulator: true` and the bundle ID; `eas simulator:availability`. |
| 3 | `build` | `eas fingerprint:generate`; a finished simulator build with the same fingerprint is reused, otherwise `eas build --wait` (up to 45 minutes). |
| 4 | `instrumentation` | A hosted EAS `repack` workflow job (`eas workflow:run --wait --json` from a staged copy of the checkout) rebundles the current JavaScript with a read-only navigation observer (the same observer on both sides), and the repacked app is downloaded and installed into the session; `capture.repack: local` (the default with `capture.simulator: local`) runs `@expo/repack-app` on the runner, and its app is installed without an upload. Generated files stay outside the checkout. |
| 5 | `session` | `eas simulator:start`; the session ID is written to `<side>-session`; the app is installed. |
| 6 | route capture | Mode-specific (§5). `agent-device` drives the simulator and records a screenshot plus the accessibility tree. A capture is accepted only when the observer's reported destination matches the requested route. |
| 7 | `export` / `cleanup` | Validate the map, write `<side>-export/` (`bundle.json`, `execution.json`, PNGs, `capture-diagnostics/`), stop the session. |

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
