---
name: explore-setup
description: Set up Expo Explore CI reviews in deterministic or agent mode. Start from Explore's static route analysis, read the app's source for the flows and state each screen needs, author route parameters and setup actions or app-specific agent instructions, install the CI files, and repeat expo-explore doctor until the setup is complete. Use for CI onboarding or capture configuration changes, not Live sessions or interactive app mapping.
---

# Set up Expo Explore

Make the app ready for CI capture in the user's chosen mode, using its real configuration and source. This is the shared **local authoring skill** for both modes. Android capture is not available yet.

Explore's tools are app-agnostic: `expo-explore setup` and `expo-explore doctor` know routes, parameters, links and source redirects, but not what the app means by them. **Your job is the app-specific part**: read this app's source to learn which flows (sign-in, onboarding, a subscription, a feature flag, a permission, a record that must exist, …) each screen needs, and write that into this app's `config.yaml` or instructions. Look for what the app actually has; do not assume the flows of another app, and do not impose an account or persona schema.

## The setup steps

The [CI quick start](../../docs/quickstart-ci.md), `expo-explore setup`, `expo-explore doctor`, and this skill use the same steps. `doctor` groups its checks by these numbers.

| Step | What | Who |
| --- | --- | --- |
| 1. Accounts and access | Expo account and EAS project, EAS Simulator access (waitlist), GitHub admin access; agent mode: a provider API key and model | The user; you check and explain |
| 2. App readiness | Node 24.12+, Expo SDK 57 or newer with Expo Router or React Navigation 6 or newer, a URL scheme, an `ios.simulator` EAS profile whose environment has no secret-visibility or file variables | `doctor` checks; you fix what the repository controls |
| 3. Capture mode | Deterministic (recommended to start: no model key, no AI charges) or agent (provider key, billed usage) | The user decides; you recommend from the source |
| 4. Base config | App identity, navigation provider, device, scope | `expo-explore setup` |
| 5. Screen entry | Route parameters; deterministic `setup` actions or agent instructions for the state each screen needs | **You, from the source** |
| 6. CI files | Both workflows, pinned to an exact `@expo/explore` version, with every `{{secret:NAME}}` forwarded | `expo-explore setup --workflows` |
| 7. Repository settings | `EXPO_TOKEN`, provider key, app-test secrets; workflows on the default branch | The user; `doctor` prints the exact commands |
| 8. Capture check | `expo-explore doctor --capture` on the committed HEAD, then the baseline workflow | You, with the user's approval (EAS usage) |

## Locate the app and tools

Locate the Expo app directory, package manager and lockfile/install root, Expo config, EAS profiles, navigation source, existing Explore config, and workflows. Find the installed Explore package if you need its files (`skills/explore-setup/SKILL.md` sits next to its `dist/cli.js`; `npm root -g` shows where a global install is). In a monorepo the app and install directories can differ. Preserve existing configuration and unrelated edits.

If Explore is not installed, run `npm install -g @expo/explore`, or use `npx @expo/explore` in place of `expo-explore`.

## Steps 1–2: check prerequisites with doctor

Run `expo-explore doctor --json` from the app directory (before a config exists it reports only that; run it again after step 4). Treat each `fail` as a task with its `code` and `nextAction`; do not infer readiness from a config file or declared dependency alone.

- Resolve what the repository controls: install the app's dependencies from its lockfile, add or merge an `ios.simulator: true` capture profile into `eas.json` (preserving other profiles and `extends`), add a URL scheme when deterministic capture needs one. Do not silently upgrade the Expo SDK or replace the toolchain; report `CAPTURE_OBSERVER_UNSUPPORTED` versions instead.
- Leave to the user what only they can do, with the exact next action: `eas login` or `eas init` (never choose or create an organization/project for them), EAS Simulator access (`SIMULATOR_UNAVAILABLE`: join the waitlist at https://expo.dev/services/simulators with the account `EXPO_TOKEN` will use), and changing EAS variables with secret visibility (`CAPTURE_OBSERVER_BUILD_UNSUPPORTED`). Never ask for a token or key in chat.

If `doctor` is unavailable (an older Explore), run the equivalent checks by hand with Explore's bundled `node_modules/.bin/eas`: `whoami`, `project:info`, `simulator:availability --json`, and `config --platform ios --profile <profile> --json`.

## Step 3: recommend a mode

Recommend **deterministic** unless the source shows it cannot represent the app, and say why in one or two sentences. Before a config exists, `expo-explore doctor --json` still runs the route analysis; its step 3 `routes` check summarizes how many screens open by link, need parameters, have no link, sit behind source redirects, or read search parameters. Deterministic replays fixed steps and app links with no model: no API key and no AI charges, and a failed step stops capture with diagnostics. Agent mode runs Claude Code (Anthropic) or Codex (OpenAI) with the user's API key, billed by the provider; it navigates through the UI and recovers from unexpected states.

Signals for agent mode: many screens without an app link (`CAPTURE_LINK_UNSUPPORTED`), prerequisites whose path branches at runtime (different forms or prompts depending on data or time), or UI that changes too often for fixed selectors. A provider key alone does not select agent mode; the user decides.

## Step 4: generate the config

Use the verified `expo-explore` command or `node /absolute/path/to/explore/dist/cli.js`. For an agent, pass every choice without opening a prompt:

```sh
expo-explore setup --project apps/mobile --non-interactive \
  --device 'iPhone 17' --scope changes --profile explore --mode deterministic
# Agent mode also needs:
#   --mode agent --provider anthropic --model <model id>
```

`--app-state` (how to prepare screens behind source redirects) only changes the printed next steps, so an agent can omit it. The wizard reads the bundle identifier, scheme, navigation dependencies and simulator profiles; `--bundle-id`, `--scheme` and `--navigation` resolve what it cannot infer. `--param ROUTE.NAME=VALUE` (repeatable) supplies route parameters you already know. An existing config is preserved: read it and make targeted edits instead of deleting it. Ask the user only for unresolved choices: which app, device (the wizard's suggestions are not a live catalog), scope (`changes`, the default, or `all`), which simulator profile when several fit, and the mode.

## Step 5: map the app from the static analysis, then read the source

This step decides whether a full map works. Do it from the source, not from guesses.

1. **Start from the analysis.** Run `expo-explore doctor --json --offline`. `routes.routes[]` lists every source route (next to `routes.diagnostics`, `unusedParameterKeys`, and `unknownSetupRoutes`). Each has:
   - `status`, which describes only the app link: `ready` (complete), `needs-parameters`, `no-link`, or `redirect` (a forwarding route with no screenshot of its own). A guarded screen can still be `ready`;
   - `parameterKey` and `missingParameters`: the key to use under `parameters` and the path segments without a value;
   - `guards`: source redirects that can send the screen elsewhere (`to`, and the `sourceFile` that declares it, such as a layout's `<Redirect>`);
   - `searchParameters`: search parameters the screen reads that config does not set (`unset`), and `opaque` when it also reads names hidden in a parameter type or rest binding;
   - `openedBySetup`: a setup `open` step opens it or a `requiresRoute` names it. Screens that setup reaches by taps are not tracked here;
   - `excluded`: `exploration.exclude` names it, so capture never opens it.

   `diagnostics` lists source the analysis could not read fully; a "History-dependent navigation" entry only loses a flow edge and needs no action.
2. **Read each guard and screen.** For each guard file and each route, read the layout, guard condition, screen component, its data loading, and the app's seed data, fixtures, test helpers and README. Record:
   - the state the screen needs and where the app establishes it: sign-in or sign-up, onboarding, a plan or entitlement, a feature flag, a permission, a record that must exist, a time or locale. Record only what this app has;
   - real parameter values and their source (seed data, fixtures, a test account), for path segments and for the search parameters the screen reads (a record ID, a mode, a recipient). A fixture name in source is evidence to investigate, not proof the record exists in the test environment. Never invent IDs;
   - screens that move on by themselves (a splash, a progress screen, a timer or effect that navigates away): find an app-supported way to hold them, such as a parameter the app honors, or capture them from a setup step without `ready`. A route with no screen of its own, such as a link handler that navigates away on its first frame, goes under `exploration.exclude` instead;
   - routes whose link has a side effect (switching an update channel, importing or deleting data): choose parameter values the app rejects or that are harmless, and check what later screens see after the link runs;
   - the representative state to capture on both revisions;
   - the controls a flow uses: prefer stable accessibility identifiers (`testID`), otherwise exact visible labels. If a needed control has neither, propose adding a `testID` and let the user approve the app change.
3. **Design the order (deterministic).** A route that a setup step lands on is captured right there, in that state; every other selected route is opened by its app link afterwards, in the state setup left. Group screens by the state they need and order the steps so each is reached in its intended state, for example: screens that need the signed-out state first, then the step that establishes the next state, then its screens, and finally the state most other screens need. Mark steps for a screen that only one compared revision defines with `requiresRoute`. If a prerequisite cannot be expressed as one fixed sequence, recommend agent mode instead of inventing conditions.
4. **Ask only for what the repository cannot answer.** Examples: a test account or tenant, a record that exists in the test backend, a file to import, a server environment. Ask for sensitive values to be stored as GitHub secrets (and local environment variables for testing); never in chat or committed files.

## Step 5 (deterministic): write parameters and setup

Keep `mode: deterministic`. Add `parameters` under each route's `parameterKey`: path segments for `needs-parameters` routes, and the search parameters a screen needs to show its representative state. A name that is not a path segment becomes a query parameter of the app link (`/send/amount` with `to: alex` opens `…/send/amount?to=alex`).

```yaml
parameters:
  /items/[id]:
    id: <real value from the test data>
  /checkout:
    plan: annual
```

Setup runs from the start whenever a revision has screens to capture, for each compared revision and whatever the scope. A screen that a step lands on is captured there only when it is selected; the other selected screens open by link afterwards. Because a failed step stops the whole capture, prefer `parameters` over extra `open` steps when a link alone reaches the screen.

Write only the `setup` actions the app needs. Supported actions are `open`, `tap`, `fill`, `type`, `scroll`, and `wait` (bounded to 30 seconds); `tap` and `fill` take exactly one `label` or `identifier`. Every action may have `ready` (a label or identifier, optionally `enabled`) and `requiresRoute`. Use the current config reference in the Explore checkout's `docs/quickstart-ci.md`; do not invent other conditional syntax, per-route hooks, or actions.

```yaml
setup:
  - action: open
    url: myapp://welcome
    ready: { identifier: welcome-continue, enabled: true }
  - action: tap
    identifier: welcome-continue
    ready: { identifier: sign-in-email }
  - action: fill
    identifier: sign-in-email
    text: "{{secret:APP_TEST_LOGIN}}"
```

The executor resolves fresh references, waits for controls, and attempts native keyboard dismissal when a keyboard covers a target; that operation may be unsupported. When source and diagnostics show a usable interaction, encode it explicitly (tap an inert heading that dismisses the keyboard, or scroll to an unobscured control) and let scrolling and keyboard transitions settle. An action with `ready` is offered for capture only after its condition holds; one without `ready` can expose a transient screen immediately. Use explicit `tap` followed by `type` when a fresh secure input needs native typing. Capture declines the iOS Save Password prompt itself; do not script it. Include other required system-alert handling; Explore does not grant app permissions.

Use `{{secret:ENV_NAME}}` for sensitive `fill`/`type` text. Do not put raw credentials in config, parameters, URLs, or logs. Literal values are fine for public, synthetic data that setup itself creates in a sandbox (for example the sign-up form of an app without a backend); anything that grants access to a real account or environment is a secret. Provider keys, `EXPO_TOKEN` and CI credentials are not app-test inputs.

## Step 5 (agent): write the instructions

Set `mode: agent`, `agent.provider` (`openai` or `anthropic`), `agent.model` (a model ID the user's account can use; see the provider's model documentation), and `agent.instructions`, normally `.expo-explore/instructions.md`. The wizard may leave a draft that starts with an `expo-explore: generated draft` comment; rewrite it from your source reading and remove that line.

Write nonempty **English prose** for the runtime agent, not a copy of this skill: how to reach the app's screens, the representative state to use on both revisions, the prerequisites and test inputs (from your step 5 reading, including each guard and how to satisfy it), readiness signals, and actions to avoid. Describe what a correct frame visibly contains and how to recognize redirects, missing data, loading, keyboards, and blocking dialogs; the runtime agent inspects each candidate screenshot, and visual readiness is its assessment. Verify appearance requirements against the app before asking the agent to change them. For flows that become inaccessible after completion, name each capture checkpoint and the completion boundary. Say whether each suggested selector is a label or an identifier.

```text
Complete the welcome screen before navigating. When a selected screen requires
sign-in, use {{secret:EXPLORE_TEST_LOGIN}} and {{secret:EXPLORE_TEST_PASSWORD}}.
Sign out when needed to reach the authentication screens. Use the same test
data and representative state on both revisions. Wait for content to finish
loading before capture. Do not make purchases or delete application data.
```

Adapt this to the app; do not copy sign-in guidance into an app without sign-in. Let the agent choose individual taps and recovery. Preserve a useful existing `setup` as an initial replay; agent mode can recover when it fails. Keep secrets, ephemeral element references and generated record IDs out of the instructions.

**Provider setup is part of agent mode.** Make sure the user has: a provider API key (Anthropic: https://platform.claude.com/settings/keys, OpenAI: https://platform.openai.com/api-keys), the repository secret `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and, for an Anthropic key that is not workspace-scoped, the optional `ANTHROPIC_WORKSPACE_ID` repository variable (set it only when needed or when the provider reports `AGENT_WORKSPACE_REQUIRED`). With the user's approval, verify key and model with `expo-explore doctor --check-model` (one small request with the key exported locally). Explain that model usage covers navigation and recovery on each uncached revision, not only notes, and that Explore imposes no dollar cap.

## Step 6: install the CI files

Run `expo-explore setup --workflows` from the app directory. It installs `explore-review.yml`, `explore-baseline.yml` and `explore-compare.yml` at the repository root with the app and install directories and the package manager's install command, pins them to this CLI's `@expo/explore` version, and forwards every `{{secret:NAME}}` from the config and instructions to each capture step. Existing workflows keep their edits; setup only updates the version and adds missing secret lines. Rerun it after adding a new secret reference. Replace a superseded Explore workflow only after identifying it, to avoid duplicate captures and comments.

The review workflow runs on `pull_request_target`, so GitHub runs the default branch's copy of the workflow and its `EXPLORE_VERSION`; a pull request cannot replace the tools that capture and publish its own review. This does not sandbox the app's build. If an app still has `.github/vendor/expo-explore` or an `EXPLORE_TOOLS_COMMIT` workflow from an older setup, `doctor` reports it: delete them and rerun `setup --workflows`.

## Step 7: repository settings

`doctor` lists what is missing as commands, for example `gh secret set EXPO_TOKEN -R owner/repo`. The user creates the Expo token at https://expo.dev/settings/access-tokens; a local `eas login` does not authenticate CI. With GitHub CLI access you may list secret **names** (`gh secret list`); never read or print values. Follow existing authorization for commits, pushes, repository settings and CI runs; without it, leave the exact list of remaining actions. Reports need no Expo-side enablement: reviewers download the artifact from the PR comment and open it at https://explore-preview.expo.app/. Do not add an `EXPLORE_VIEWER_ORIGIN` setting.

The templates capture open, non-draft, same-repository PRs whose authors have write access. For private apps, explain that only people who can download the artifact (GitHub sign-in with repository read access) can open a report.

## Step 8: repeat doctor, then verify on a device

Repeat `expo-explore doctor --json` and fix each `fail` until none remain, collecting the items only the user can do. A check marked `skip` did not run (for example `--offline`, or no GitHub remote yet); the setup is complete only when a run without skips passes. Listing repository variables and secrets needs GitHub admin access. Review each `warn`: a `ROUTE_GUARD_UNPREPARED` warning means guarded screens start in the app's initial state.

`setup --check` validates only the config schema and instruction file; it is not runtime verification. When the static checks pass and the user approves the EAS usage (and model usage in agent mode), commit locally and run `expo-explore doctor --capture --yes`. It captures the committed HEAD like the baseline workflow with the local EAS login and reports each route. `CAPTURE_LANDING_UNVERIFIED` means the screen redirected: fix the state that setup or the instructions establish. Open the screenshots of guarded screens and confirm each shows the intended state, not just the right route. Do not start paid builds or simulators merely to validate YAML, and do not weaken capture checks to make a replay pass. A setup that was not run on a device is **authored but not runtime-verified**; say so.

## Review a change on this machine

The same review CI runs works locally, between any two commits. It reads `.expo-explore/config.yaml` from the head commit, else from the checkout when setup wrote it but it is not committed, else uses the defaults `setup --non-interactive` would write (with several simulator profiles, the one named `explore`), so it works before setup:

```sh
npx @expo/explore capture               # HEAD and the uncommitted changes, against where HEAD left the default branch
npx @expo/explore capture --committed   # HEAD alone
npx @expo/explore capture --base v1.3.0 --head v1.4.0 --scope all
```

- It prints which commits it compares. Each is checked out as a detached worktree in a temporary directory, its dependencies installed (frozen lockfile, no scripts, no Explore credentials in the environment), and removed afterwards; the user's checkout, index and branches are never touched.
- It runs both commits' code as the user (dependency installs, the app config, bundling). Before reviewing a branch the user did not write, say so and ask; credential-free installs are not a sandbox.
- Logins: `EXPO_TOKEN` and the provider's API key when they are set; otherwise the user's `eas login` and their local `claude` or `codex` login for the configured provider. If `eas whoami` fails, tell them to run `eas login`.
- Without `--head`, the head is HEAD plus the working tree's changes, untracked non-ignored files included, which is what `eas build` uploads. It lists them; check that list for secrets the user would not want built. `--committed` reviews HEAD alone, and an `eas.json` with `cli.requireCommit: true` leaves the changes out unless `--uncommitted` is passed.
- Every configured platform is reviewed unless `--platform` picks one. It opens the report in a local Viewer; `--upload` hosts it instead and prints the link, `--no-open` or `--json` only prints the report paths.
- Every run is kept on this machine for 30 days: `npx @expo/explore reports list` (or `--json`) shows them, `reports open <id|latest>` reopens one in the local Viewer, and `reports upload <id>` hosts it without capturing again. Run bare in a terminal, `reports` is an arrow-key picker for the user.
- To host a report after the fact, run `npx @expo/explore report:upload <report.zip>...` with the paths it printed (or the `--output` directory's `<platform>/report.zip`), one per platform. It uses the same project as `--upload` and does not capture again.
- Captures are cached in `~/.cache/expo-explore`, so a second review of the same base does not capture it again (`--no-cache` skips the cache). Ctrl+C stops the EAS Simulator sessions the review started.
- It builds on EAS and runs simulator sessions, like a CI review: expect several minutes and EAS usage per run.

## Compare any two commits

`explore-compare.yml` (installed by `setup --workflows` from 0.19.0; run `npx @expo/explore@latest setup --workflows` to add it to an existing setup) reviews a `head` against a `base`, each a branch, tag or commit SHA, with no pull request. It captures, compares and reports like a PR review and links the report from the run's summary. Its inputs are `base`, `head`, and the optional `scope` (`changes` or `all`) and `expires-in` (such as `30d`, or `never`).

- **Releases.** Unless the user asks otherwise, compare each release with the last stable release, with `scope: all` (every screen, so the report shows the whole release with what changed marked) and, when hosted previews are on, `expires-in: never` (the link outlives the 30-day artifact). For every tag as it is pushed, add the `release-review.yml` from the README's "Compare any two commits" section: it finds the newest earlier tag without a `-` (so a release candidate is compared with the last stable release) and calls `explore-compare.yml` with `secrets: inherit` and `permissions: { contents: read, actions: read }`. A nightly compares with yesterday's tag; a release branch with `main`.
- **Once, on demand.** The workflow must be on the default branch to be dispatched: `gh workflow run explore-compare.yml -f base=<ref> -f head=<ref> -f scope=all -f expires-in=never`, or **Run workflow** under Actions → Expo Explore compare.
- **Without CI.** `npx @expo/explore capture --base <ref> --head <ref> --scope all --upload` runs the same comparison on this machine (see the previous section).
- Call the workflow once per workflow run (a second call in the same run reuses the first one's artifact names). A `base` the baseline workflow captured in the last 30 days is reused, so only `head` is captured.
- To verify, run it once on the latest tag and open the run's summary: it lists each platform's result and links the report.

## Learn from observed failures

When revising an existing setup, read the previous run's diagnostics, navigation trace and screenshots together. Separate an app prerequisite or defect from a controller failure and a provider or configuration failure. A successful tool response alone does not prove recovery: check the field value, destination, or visible content. For agent mode, inspect `agent-usage.jsonl` before proposing another paid run; missing accounting is unknown, not zero, and dollar fields are estimates. Respect exhausted credit and requests to stop paid calls.

Fold validated app-specific lessons into the committed config or instructions: the triggering condition, a supported action, its observable postcondition, and the evidence run with app and tool versions. Remove advice made obsolete by fixes. Use the same instructions and inputs on both comparison sides; apply revisions to a later run. Record unverified ideas as pending validation.

## Keep it working

Tell the user what maintaining the setup involves: a pull request that adds a screen behind a guard or a new dynamic route should update `config.yaml` in the same pull request (`requiresRoute` for a screen only its head defines); renamed identifiers or labels break deterministic setup steps; a new `{{secret:NAME}}` needs `setup --workflows` and a repository secret; adopting a newer Explore means running `npx @expo/explore@latest setup --workflows` and committing the version change.

## Finish with evidence

Report, by setup step: what was checked and its result, files created or updated, the chosen mode/device/scope/profile, route coverage (routes found; open by link; prepared by setup or instructions; unresolved and why), and everything left for the user, including in agent mode whether the provider key and model are set and verified. Distinguish "config validated", "doctor passes", "capture check passed on a device", "workflows prepared", and "CI captured successfully". Claim the last only after an actual eligible run passes its capture and comparison checks and publishes a report with **Open Explore** and **Download report**.
