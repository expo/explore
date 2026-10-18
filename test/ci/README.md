# Local CI tests

Run the production planner, EAS build/repack, EAS Simulator, agent-device capture,
evidence validation, comparison, notes, and report export from a terminal.
Claude Code or Codex owns its model/tool loop using your CLI subscription login.
No Orca, editor integration, GitHub PR, or external app checkout is required.
Production GitHub CI retains its API-key authentication and publication rules.

## Layout

- `apps/<app>/`: one tracked example app. It is the base of every scenario.
- `scenarios/<app>/<scenario>/`: a fixed change to that app. `scenario.json` has a
  `description` and an optional `removed` list of app-relative paths; `overlay/` holds files
  that replace or add to the app; `expected.json` declares the review each surface should get.
  Head is the app without `removed` and with `overlay/` on top, so a scenario stores only
  what it changes.
- `scenarios/<app>/deterministic.yaml`, `agent.yaml`, `instructions.md`: the Explore configs
  shared by that app's scenarios. A shared config can leave named setup slots
  (`- include: signed-out`); a scenario's `setup.yaml` maps a slot to the steps it inserts
  there, for example setup for a route only its head has. An unfilled slot disappears, and a
  slot the config does not have fails the run. The shared config cannot name that route
  itself: `requiresRoute` naming a route that exists on neither revision is rejected. A
  scenario can also carry its own `<mode>.yaml` instead of the shared one.
- `runs/<run-id>/inputs/`: the scenario (with its setup slots), its config, effective config
  (slots filled, scope applied), instructions, expectations, and source file digests frozen
  for that execution.
- `runs/<run-id>/`: `request.json`, `run.json`, `README.md`, `PR-comment.md`,
  `agent-mode-cost.md`, and `issues.md` are small, reviewable run records.
- `runs/<run-id>/artifacts/`: ignored local report ZIP, screenshots, bundles,
  navigation traces, usage receipts, logs, tool sources, and disposable worktrees.

The harness code has no app knowledge. Node, browser, and end-to-end harness tests live in
`test/node`, `test/browser`, and `test/e2e`; shared helpers and parser fixtures have their own
directories.

## Prerequisites

Use Node >=24.12 and run `npm ci` in this repository. Apps need an npm lockfile; the harness
runs `npm ci --ignore-scripts` independently in each frozen checkout, as the review workflow
template does. When the app has a `typecheck` script, the harness then runs it in both
checkouts (`logs/typecheck-<side>.log`), so a scenario head that does not compile fails before
any EAS work; overlay files are compiled nowhere else.
The app must be configured for EAS, with a simulator build profile and an account
that can use EAS Simulator. Run `eas login` or supply `EXPO_TOKEN`. Availability is
checked before creating a remote session. EAS compute still uses that account.
The wallet app uses the EAS project `@expo/explore-example-app`.

For Anthropic, install Claude Code and use `claude auth login` with a subscription.
For OpenAI, install Codex and use `codex login` with ChatGPT. The runner records
CLI versions and ignores npm-injected project CLI shims when resolving model
executables, so the terminal-installed subscription CLI is used. Provider API keys are excluded from local model subprocesses;
there is no paid API fallback. Missing login, model access, or quota fails the run.
If your Codex config adds MCP servers or plugins, the harness fails closed. Use
an isolated login/config directory for the local test:

```sh
CODEX_HOME="$HOME/.local/share/explore-ci-codex" codex login
CODEX_HOME="$HOME/.local/share/explore-ci-codex" npm run ci:local -- --app APP --scenario SCENARIO --mode agent
```

Codex protocol tests do not establish real Codex device acceptance.

App install/build code runs with the host's build environment, as it does in CI.
Use trusted app sources. Put test credentials in environment variables referenced
by `{{secret:NAME}}` in instructions, never literal secrets in tracked YAML or prose.

## Run

```sh
npm run ci:local -- \
  --app test/ci/apps/wallet \
  --scenario test/ci/scenarios/wallet/release \
  --mode deterministic \
  --scope all
```

`--mode` (default `deterministic`) selects `deterministic.yaml`, `agent.yaml` or `flows.yaml`; `--scope`
overrides the config's `exploration.scope`. `--run-id NAME` selects a readable ID and refuses
overwrite. `--plan-only` runs the production planner, checks the expectations at plan level, and
validates each setup step's `requiresRoute` against both revisions, without installation,
model calls, or EAS; use it before spending a device run on a new
scenario. Both sides use fresh app sandboxes; capture cache reuse is disabled for this harness.
Ctrl+C requests cancellation and lets the owned capture/session cleanup finish.

Sources are frozen from tracked and nonignored files (including local edits). The harness
builds a disposable two-commit Git history (base, then head) so the production planner computes
the diff itself, exactly as it does for a pull request. Generated dependencies and symlinks are
excluded/rejected. An overlay file identical to the app, or a removal of a file the app does not
have, fails the run before planning. Overlay files replace whole files: when the app changes,
update the scenario overlays that copy that file. Tool source, CLI versions, config, source digests,
timestamps, and final report digest remain with the run.

### Scenarios

| Scenario | Head change | Expected review |
| --- | --- | --- |
| `wallet/identical` | none | nothing selected with `changes`; every screen unchanged with `all` |
| `wallet/app-wide` | `package.json` description | every screen unchanged; the comment names the app-wide change once |
| `wallet/release` | adds `/auth/forgot-password` and its link on sign-in, removes `/onboarding/features`, shows the annual saving on the paywall, refactors the transaction detail | added, removed, two modified, two needs-review, the rest unchanged |

### Expectations

`expected.json` maps a route pattern (`/transactions/[id]`), a logical path, or a surface id to
`added`, `removed`, `modified`, `needs-review`, `unchanged`, or `variant`; `others` applies to
every surface not listed. After export the harness compares them with `report/review.json` and
records the result in `run.json` (`expectations`), the run README, and `issues.md`; a mismatch
makes the command exit 1 even when the CI run passed. A surface without compared evidence
never satisfies an expectation, except that an unselected surface satisfies `unchanged`.
`--plan-only` checks the same file against the plan, where `needs-review` and `modified` are
not yet distinguishable.

### Matrix

```sh
npm run ci:local:matrix -- --app test/ci/apps/wallet \
  --cells identical:deterministic:changes,app-wide:deterministic:all,release:deterministic:all,release:deterministic:changes,release:agent:all,release:agent:changes \
  --parallel 4 --prefix wallet-20260927
```

Each cell is an ordinary run (`runs/<prefix>-<scenario>-<det|agent>-<scope>`) in its own
process; `--scenarios a,b --modes … --scopes …` expands a product instead of listing cells.
The matrix builds the CLI once, prefixes each cell's output, and writes
`runs/<prefix>-matrix/README.md` with status, expectations, captures, duration, and estimated
agent cost per cell. A cell passes only when its process exits 0 and its own record passed.
The matrix refuses to start when any of its run directories already exists, so rerun with a new
`--prefix`. Ctrl+C cancels every cell; a second Ctrl+C stops them. Run one cell alone
first after a native change: parallel cells that find no EAS build for a new fingerprint each
start their own.

Agent capture now excludes revision-specific source literals from shared
readiness landmarks. Before accepting a frame, a separate bounded model session
inspects that exact image against the intended state and app guidance. Its image
and assessment are retained under `capture-diagnostics/readiness/`; rejected
frames do not enter the accepted bundle. These additional sessions contribute to
the usage receipts. The navigation agent can use `stop_blocked` to fail promptly
with partial evidence when bounded recovery cannot restore a prerequisite.

## Revisit a result

```sh
npm run ci:local:view -- --run test/ci/runs/<run-id>
# Or explicitly open a retained archive:
npm run ci:local:view -- --zip /path/to/report.zip
```

Open the printed localhost URL. Viewing reads the original ZIP; it makes no model,
build, or simulator request. To judge retained evidence again after a comparison or
classification change, `npm run ci:local:recompare -- --run test/ci/runs/<run-id>` re-runs
comparison, agent notes (agent mode, local subscription CLI), and export from the run's captures
into `artifacts/recompare-<n>/report.zip` and re-checks the run's `expected.json` into `expectations.json` beside it; it never builds, captures, or edits the original report. The Viewer still supports dropping another ZIP.
`--run` checks the ZIP digest. Missing artifacts produce an explicit error, never
a rerun or fabricated screenshots. Keep/copy the ignored `artifacts/report.zip`
when moving machines; tracked summaries alone cannot reconstruct runtime evidence.
Open different runs to compare their source, coverage, costs, and screenshots.

A failed run retains partial evidence when a source plan exists. No-image failures
remain uncovered, and failure reports cannot be interpreted as a successful CI run.
Failure before planning still writes status, comment, issues, and usage records.
Cost figures are CLI estimates, not subscription invoices; unknown usage is not
zero. EAS charges are not included.

## Wallet fixture

`apps/wallet` is a backend-free Expo Router wallet app: splash, onboarding, sign up/in/out and
account deletion, a Free and a Premium plan with a paywall, send money with processing,
success and failure screens, a top-up modal with inline states, sheets, alerts and toasts, native
tabs and bottom toolbars, and features behind the location, camera, contacts and notification
permissions. It follows the iPhone's appearance, accessibility settings, text size, window width
and memory warnings. Its
[README](apps/wallet/README.md) documents the synthetic account, every client-side outcome
rule, which iPhone setting each feature follows, what the `explore` build profile fixes (clock,
final animation frames, held transient screens). The wallet scenarios never grant a permission or change the
appearance. It is only an example input; nothing in the CI flow or its checks names it.

Record observations in each run's `issues.md`, and file confirmed CI defects as GitHub issues.
