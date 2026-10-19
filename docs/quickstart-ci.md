# CI quick start

Explore reads Expo Router or React Navigation source at the exact PR base/head commits, captures the configured device on each configured platform (iOS, Android, or both), and publishes a review. GitHub Actions stores the report artifact; reviewers download it and drop it on the central Viewer, which renders it in the browser.

## 1. Configure the app

Setup follows these numbered steps. `expo-explore setup`, `expo-explore doctor`, and the [explore-setup skill](../skills/explore-setup/SKILL.md) use the same numbers.

| Step | What | Who |
| --- | --- | --- |
| 1. Accounts and access | Expo account and EAS project, EAS Simulator access, GitHub admin access; agent mode: a provider API key | You |
| 2. App readiness | Supported Expo and navigation versions, a URL scheme, a capture EAS profile per platform (iOS simulator, Android APK) | `doctor` checks; you or your agent fix |
| 3. Capture mode | Deterministic or agent | You |
| 4. Base config | App identity, navigation, device, scope | `expo-explore setup` |
| 5. Screen entry | Route parameters, and the app state each screen needs | Your coding agent, from your source (or you) |
| 6. CI files | Both workflows, pinned to an exact `@expo/explore` version | `expo-explore setup` (or `setup --workflows` later) |
| 7. Repository settings | `EXPO_TOKEN`, provider key, app-test secrets; workflows on the default branch | You, with commands from `doctor` |
| 8. Capture check | Capture the committed app on EAS, then run the baseline workflow | `expo-explore doctor --capture`, then Actions |

Step 5 decides whether the full map works. Explore finds every screen and the redirects (guards) in front of it. Only your app's code says what a guard needs, such as a signed-in account. Without that, Explore captures the screen it redirects to, or fails.

The recommended path is to give the skill to your coding agent: it starts from Explore's route analysis, reads the app's source for the state each screen needs, and repeats `doctor` until nothing fails. Required inputs depend on the app; there is no fixed account or persona schema.

To run the wizard yourself, from the app directory:

```sh
expo-explore setup
# In a monorepo, from its root:
expo-explore setup --project apps/mobile
```

Choose a menu number or type a value, then press Enter. Enter accepts a displayed default. The wizard analyzes the app's committed routes, then asks for the app identity, the capture mode, device and scope, a real value for each dynamic route, and how to prepare screens behind source redirects (deterministic) or the provider, model and a first draft of the instructions (agent). It previews and validates `.expo-explore/config.yaml` before writing it, can install both workflows, and ends with the remaining steps as commands. It preserves existing configs; `expo-explore setup --workflows` adds or updates only the CI files for an existing config. Device choices are suggestions; availability is checked when capture runs. Dynamic Expo config requires the app's dependencies and any environment variables used by that config.

Config evaluation uses your current shell environment; the wizard does not load an EAS profile's environment or remote secrets. If a build profile changes the bundle identifier or scheme, evaluate setup with the matching environment or supply `--bundle-id` and `--scheme` explicitly.

For scripts or agents, supply the choices explicitly:

```sh
expo-explore setup --non-interactive --device 'iPhone 17' --scope changes --profile explore \
  --mode deterministic --param '/items/[id].id=item-1' --workflows
expo-explore setup --non-interactive --device 'iPhone 17' --scope changes --profile explore \
  --mode agent --provider anthropic --model <model id>
```

Use `--project` for another app directory. `--platform ios|android` selects the platform (default `ios`). `--device` and `--scope` default to the wizard's defaults (`iPhone 17` on iOS, `pixel_7` on Android, `changes`) when omitted. Optional overrides are `--bundle-id` (required when the app config has no `ios.bundleIdentifier`, or no `android.package` on Android), `--scheme`, and `--navigation auto|expo-router|react-navigation`; `--json` also selects non-interactive mode. If several simulator profiles exist, pass `--profile`. `--param ROUTE.NAME=VALUE` repeats for each value; `--app-state` answers the redirect question; `--workflows` installs the CI files. `setup --check` validates only an existing config's schema and referenced instructions file; use `doctor` for everything else.

### Check the setup with doctor

```sh
expo-explore doctor               # every setup step; exits 1 until ready
expo-explore doctor --json        # the same, for agents, including the route analysis
expo-explore doctor --check-model # agent mode: one small request with the exported provider key
expo-explore doctor --capture     # capture the committed HEAD on EAS with your eas login
```

`doctor` groups its checks by setup step and prints, for each problem, the error code CI would report and the next action. It runs the bundled EAS CLI read-only (`whoami`, `project:info`, `simulator:availability`, `config`, `env:list`) and, when the GitHub CLI is signed in, reads repository variable and secret **names**, never values. `--offline` skips EAS and GitHub; `--no-github` skips only GitHub.

Its route analysis reads the committed source at HEAD, as CI does for a pushed commit. For each route it reports whether the app link is complete, which parameters are missing, whether the screen has no link, and the source redirects (guards) that can send it elsewhere, with the file that declares each.

`doctor --capture` runs only after the checks for steps 1 to 5 pass and you confirm (`--yes` in scripts). It needs a clean checkout, so commit first; a local commit is enough. It captures the full inventory the way the baseline workflow does and lists each route as captured, not captured (with its code and next action), or not reached, with the screenshots and diagnostics directory. `CAPTURE_LANDING_UNVERIFIED` means the screen was not on its route when captured, usually a redirect: prepare the state it needs. Open the screenshots of guarded screens to confirm each shows the state you meant to review.

The following examples document the generated fields and optional additions.

### EAS profile reference

Link the app to its EAS project and use a capture profile in its existing `eas.json`: `ios.simulator: true` for iOS, `android.buildType: apk` for Android (one profile can set both):

```json
{
  "build": {
    "explore": { "ios": { "simulator": true }, "android": { "buildType": "apk" } }
  }
}
```

Android captures need an APK profile (EAS Android Emulators install APKs, not AABs):

```json
{
  "build": {
    "explore": { "android": { "buildType": "apk" } }
  }
}
```

The capture profile can be a release build; a development client is not supported. An existing valid profile can be reused. Run `setup --platform android` to generate an Android config. With a `platforms:` map, `doctor` checks the profile of every configured platform.

### Config reference

The generated `.expo-explore/config.yaml` lives in the application directory. Commit it with the app:

```yaml
mode: deterministic
app:
  platform: ios # ios | android
  bundleId: com.example.myapp # Android: the application id (android.package)
  easProfile: explore
  scheme: myapp
navigation:
  provider: auto # auto | expo-router | react-navigation
  # entry: src/navigation/RootNavigator.tsx
device:
  name: iPhone 17 # Android: an AVD profile id such as pixel_7
  # pose: open # a foldable (iPhone Duo): closed (the outer display, how a session starts) | half-open | open (the inner display)
exploration:
  scope: changes # changes | all
capture:
  # controller: agent-device # agent-device (default) | argent (one appearance per capture on Android EAS Simulator until Argent can switch it; --controller overrides it for one run)
  # simulator: eas # eas (EAS Simulator, default) | local (a simulator or emulator Explore starts on this machine with Xcode or the Android SDK; --simulator overrides it for one run)
  maxMinutes: 30
  maxActions: 500
  # maxSessions: 16 # the most EAS Simulator sessions one review runs at once, across all its targets and sides (default: two per target, head and base; at least one per target). Each target's job gets its share, and a side spreads its light and dark passes over separate sessions only when that saves it at least a minute, so the ceiling is a limit, not a target: a 3-route target stays on two sessions. euxy's four targets: 8 is today's behaviour, 16 captures each appearance in its own session (measured: an iPhone side 6:12 → 4:26, one repack shared by its sessions, ~3.5 session-minutes more per side).
  repack: eas # eas (hosted EAS workflow job, the default on EAS Simulator) | local (repack-app on the runner, the default with simulator: local; --repack overrides it for one run)
  appearance: auto # auto (follow the app's userInterfaceStyle: automatic captures light and dark) | dark | light | [dark, light]
  launch: screenshot # screenshot (relaunch the app per appearance and keep its splash and first settled frame, default) | video (also keep a launch recording in the report) | off
  reset: root-link # root-link (open the app's root link and let it settle before every route link, default) | none (each link opens from whatever the previous route left on screen)
  unattributed: publish # publish (a frame of the screen the app showed instead of a planned route is kept in the report, marked unattributed and never compared, default) | discard (the route is reported as failed with no frame)
  # readinessSeconds: 8 # how long a route link gets to show its destination after it opens (default 8 on iOS, 10 on Android; extended while the screen is still changing, up to twice this)
```

### Several platforms

`app.platform` is the primary platform (`ios` or `android`); `app.bundleId`, `app.easProfile`, and `device.name` describe it. A `platforms` map adds the other platform with its own `device`, `bundleId` (the Android package), and `easProfile`:

```yaml
platforms:
  ios: {}
  android:
    device: pixel_7            # default for Android
    bundleId: com.example.myapp
    easProfile: explore-android
```

Commands that capture or publish (`source:verify`, `capture:review`, `capture:baseline`, `ci:report`, `ci:publish`) take `--platform ios|android`; with one configured platform it is optional, with two it is required (`PLATFORM_REQUIRED`). `expo-explore config:platforms` prints the configured list as JSON, which the workflows use as their matrix. Artifacts carry the platform (`explore-capture-<run>-<attempt>-android`, `explore-baseline-<sha>-ios`); an iOS job still reuses an older unsuffixed baseline. The PR comment has one section per platform, and a hosted preview serves both reports from one link.

### Several devices (targets)

`targets` names each capture instead of `platforms`, so one platform can have several devices or poses. Each target is captured, published and commented on as its own report, in config order:

```yaml
targets:
  iphone: { platform: ios, device: iPhone 17 }
  duo-closed: { platform: ios, device: iPhone Duo, pose: closed }
  duo-open: { platform: ios, device: iPhone Duo, pose: open, label: "iPhone Duo (open)" }
  android: { platform: android, device: pixel_7, bundleId: com.example.myapp, easProfile: explore-android }
```

A target's id (up to 32 lowercase letters, digits and dashes, starting with a letter; not `base`, `head`, `report` or `install-…`; at most 8 per config) takes the place of the platform everywhere a capture is named: `--target duo-open`, `explore-capture-<run>-<attempt>-duo-open`, `explore-baseline-<sha>-duo-open`. `expo-explore config:targets` prints the list the workflows use as their matrix. Fields a target leaves out come from `app` and `device`; a target of another platform than `app.platform` sets its own `bundleId` and `easProfile`. A config with `platforms` has one target per platform, named `ios` and `android`, so its names do not change. `--platform` still selects a target when only one has that platform.

Use the actual bundle identifier, scheme, profile, and available simulator device name. `scheme` is optional when static app configuration supplies it. `navigation.entry` resolves ambiguous entry modules; it does not list screens.

Do not add a surface inventory, required fixture routes, runtime probe, configuration version, or Viewer URL. The analyzer discovers screens from source. Application data, time, and network remain live.

### Entry links and runtime gaps

Expo Router supplies file-derived paths. React Navigation discovery reads screen registrations independently of linking. Deterministic capture uses the app's linking configuration; a registered screen without a usable link remains uncovered. Agent mode can reach a screen through the UI, but the runtime observer must still identify exactly one matching source route.

For a dynamic route, provide a real non-secret parameter value rather than a made-up identifier:

```yaml
parameters:
  /products/[id]:
    id: example-product
```

Parameter keys identify discovered routes. They cannot add routes to the inventory. A name that is not a path segment becomes a query parameter of the app link, for a screen that reads search parameters (`/checkout` with `plan: annual` opens `myapp://checkout?plan=annual`); `doctor` warns about search parameters a screen reads that config leaves unset. Optional `setup` actions are structured device operations:

```yaml
setup:
  - action: open
    url: myapp://welcome
    ready: { label: Continue, enabled: true }
  - action: tap
    label: Continue
    ready: { identifier: home-content }
  - action: wait
    milliseconds: 500
```

#### When the config needs setup steps

Setup runs from the start whenever a revision has screens to capture, for each compared revision and whatever the scope. A screen that a step lands on is captured there only when it is selected for the review.

A screen needs setup when the app must be in some state before it shows it: a guard redirects signed-out users, onboarding must be finished first, a plan or feature flag changes the screen, or a record must exist. `doctor` lists the source redirects it finds; the app's code says what each needs. Screens without such a state need no setup.

A route that a setup step lands on is captured right there, in that state. Every other selected route is opened afterwards by its app link, in the state that setup left. Order the steps so each screen is reached in the state it should be reviewed in: for example, first the screens that need the signed-out state, then the step that signs in, then the screens that need that state, ending in the state most other screens need.

Use actual labels and identifiers from the app. Supported actions are `open`, `tap`, `fill`, `type`, `scroll`, and `wait`; `tap` and `fill` identify a control with exactly one `label` or `identifier`. `fill` takes `text`; waits are bounded to 30 seconds. Every action may have `ready` with a label or identifier and optional `enabled` value. Every action may also have `requiresRoute`, naming a route as the source plan shows it: its id, route (`/account`, `/cats/[catId]`), React Navigation logical path, or link path. A revision whose source inventory lacks that route skips the action, so a PR can prepare a screen that only its head defines (or that it removes); the other revision skips those steps. The decision comes from source, not from the screen. A route that exists at neither compared revision fails before the build with `SETUP_ROUTE_UNKNOWN`. It cannot express a prerequisite that changes on a route both revisions define, such as a new required field in an existing form; use agent mode for that. The executor reads fresh snapshots to resolve controls. An action with `ready` becomes eligible for capture after that condition succeeds; without `ready`, a reached route can be captured immediately to preserve transient screens. A transient capture failure on a reached route is retried once from a fresh snapshot, and `ready` must still hold; the action itself is not repeated. If that capture still fails, the route stays failed with its original error. Explore does not replace it with the route's default app link, because that link does not recreate the prepared state.

In either mode, `fill` and `type` can use `text: "{{secret:ENV_NAME}}"` for an app-test input. Store the value in a GitHub secret and forward that name only to the capture steps in both workflows. The coordinator resolves the reference when entering text. Do not place raw credentials in config, route parameters, URLs, or logs.

Use explicit `tap` followed immediately by `type` when a fresh secure input needs native typing. `type` takes only `text` and optional `ready`; it appends once after verifying the same input and route, a visible keyboard, and no alert. It waits briefly for keyboard readiness while the input and route remain unchanged. An intervening action invalidates the focus attempt. It never clears or automatically retries the field, and does not verify its contents. An absent or masked accessibility value does not prove that a secure field is empty; establish a known form state and verify the application's result after submission.

```yaml
  - action: tap
    identifier: auth-password
  - action: type
    text: "{{secret:APP_TEST_PASSWORD}}"
  - action: tap
    identifier: auth-submit
    ready: { identifier: account-session }
```

Setup is optional, sequential, and does not freeze app state. The authoring skill can verify a replay on an available device; `setup --check` alone cannot. A setup failure stops deterministic capture. Agent mode can use an existing setup as an initial replay and recover when it fails. Apart from `requiresRoute`, there is no conditional action language, and there is no automatic model fallback in deterministic mode.

Missing parameters needed for deterministic entry links and unverified destinations remain capture failures. A recorded tap path alone does not prove a destination. Agent mode can use supplied or observed runtime route data, subject to source identity and configured parameter checks; it cannot invent a valid fixture. Supply real route data and check the reported coverage. Both modes capture one representative state per selected route; additional state variants are deferred.

#### Exclude a route that has no screen

Some routes render nothing of their own: a link handler that applies a setting and navigates away on its first frame, or a debug-only screen. Their landing can never be verified, so capture fails with `ROUTE_LANDING_MISMATCH`. List them under `exploration.exclude`, by any name `requiresRoute` accepts:

```yaml
exploration:
  scope: changes
  exclude:
    - /c/[channel]
```

An excluded route stays in its neighbors' navigation context (a screen that links to it is still captured when it changes), but neither revision captures it, it is left off the map and the screen counts, and a change to it gets no before/after comparison. A name that matches no route at either compared revision fails the plan with `EXCLUDE_ROUTE_UNKNOWN`; `doctor` warns about it first. Prefer `parameters` or `setup` when a route does show a screen.

Capture handles iOS's confirmation to open a link in the expected app. After a form submits a password, iOS may offer to save or update it depending on the simulator's AutoFill state; capture declines that prompt with Not Now in both modes, never stores the credential, and records each decision in `capture-diagnostics/system-prompts.jsonl`. Do not script that tap in setup. Include required system-alert handling in setup or app instructions; Explore does not automatically grant application permissions.

### Stable captures (optional)

Screenshots are compared pixel by pixel, so anything that changes between runs shows up as a Screen variant or noise: the current time and relative dates, animations and loading indicators that can be caught mid-frame, screens that move on by themselves, and permission prompts that depend on earlier runs. When both builds capture light and dark, text that differs between each build's own two captures (a clock, a relative date, a random name) is reported as runtime state, never as the change that makes a screen Modified; text that only follows the appearance, or a word beside it that changed, is still a change. If your app has these, consider making the capture profile's build fix them, for example with an environment variable in that EAS profile that the app reads. What to fix depends on your app; your coding agent can find candidates in the source, and each change is an app change for you to approve. The [example app's `explore` profile](../test/ci/apps/wallet/README.md#explore-build-profile) is one example.

### Agent usage and reuse

An agent run uses the model for navigation, prerequisite handling, recovery, and
capture decisions on each uncached revision. It is not a notes-only API call.
Keep the required capture scope: `all` still means the complete selected app map.
Explore does not impose a dollar cap or silently skip screens to reduce usage.

The runtime returns fresh accessibility evidence with compact progress after UI
actions and reads source files on demand. Request an image when visual inspection is needed; every
accepted representative capture still requires an inspected image. Capture
consumes that frame but leaves its accessibility selectors available for the next
action, which resolves fresh controls on the device. Full progress and established
contexts remain available through `get_progress`. Fixed "No visible change."
notes are written locally from unchanged comparison verdicts; other notes use
the validated paired evidence.

For Claude, the always-uploaded diagnostic artifact contains
`explore-review/agent-usage.jsonl` (or `explore-baseline/agent-usage.jsonl`). Each
record names its phase and retains reported input/output, cache, thinking, and
estimated cost counters. Thinking tokens are part of output tokens, not an
additional amount to add. Missing or partial accounting is identified explicitly;
an absent total is not zero. Tool-call counts are not model-request counts.
The [SDK's cost fields are estimates](https://code.claude.com/docs/en/agent-sdk/cost-tracking);
use the provider's billing records for actual charges. Usage stays out of the
public report and PR comment.

Inspect a downloaded diagnostic artifact locally:

```sh
cat explore-review/agent-usage.jsonl
```

Compatible exact-base captures avoid a second simulator and agent session when
they cover all selected base screens. A changed tools revision, instructions,
runtime, or capture context can invalidate that cache. Sequential `setup` can
prepare known prerequisites, but it is not automatic per-screen flow learning.
Recording successful agent paths as reviewed reusable flows and repairing only
drifted flows remains follow-up work.
Do not assume a failed full run is cheap to repeat: inspect its diagnostic and
correct the specific failure first. Respect a user's request to stop paid runs;
offline tests do not establish live cost or complete capture acceptance.

### Agent mode

Keep the app, navigation, device, scope, and capture settings above, then explicitly select agent mode:

```yaml
mode: agent
agent:
  provider: openai # openai | anthropic
  model: your-model
  instructions: .expo-explore/instructions.md
```

Choose a model available to your provider account; `agent.model` is a model ID, not a fixed list maintained by Explore. See the [OpenAI model documentation](https://developers.openai.com/api/docs/models) or [Anthropic model documentation](https://platform.claude.com/docs/en/about-claude/models/overview). Credentials do not enable agent mode automatically.

The provider selects the runtime that owns the navigation loop:

| `agent.provider` | Pinned runtime | Credential |
| --- | --- | --- |
| `anthropic` | Claude Code through `@anthropic-ai/claude-agent-sdk` 0.3.285 and its platform-native package | `ANTHROPIC_API_KEY` |
| `openai` | Codex app-server from `@openai/codex` 0.159.2 and its platform-native package | `OPENAI_API_KEY` |

Both runtimes use Explore's device tools to operate the existing EAS Simulator through official `agent-device` 0.21.29-nightly.20261018.74. The runtime and native binaries come from the pinned tools installation. CI does not use the development-only `node_modules/.bin/claude` executable or an interactive subscription login.

Create and commit the nonempty English prose file named by `agent.instructions`. The shared setup skill authors it from source and asks for missing test data or environment inputs. Describe how to reach the app's screens, necessary prerequisites, the representative state to use on both revisions, readiness signals, and actions to avoid. This file guides the runtime agent; it is not a list of mandatory YAML steps or a second screen inventory.

For an app that needs test sign-in, `.expo-explore/instructions.md` might contain:

```text
Complete the welcome screen before navigating. When a selected screen requires
sign-in, use {{secret:EXPLORE_TEST_LOGIN}} and {{secret:EXPLORE_TEST_PASSWORD}}.
Sign out when needed to reach the authentication screens. Use the same test
data and representative state on both revisions. Wait for content to finish
loading before capture. Do not make purchases or delete application data.
```

Adapt the instructions to the app. An import flow may need a fixture file, a workspace may need a tenant, and a public app may need no secret inputs at all. There are no required account or persona fields.

Store sensitive test inputs as GitHub secrets and reference them with `{{secret:ENV_NAME}}`. Add the same names to the capture step's `env` in both workflows, alongside the selected provider key:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  ANTHROPIC_WORKSPACE_ID: ${{ vars.ANTHROPIC_WORKSPACE_ID }} # Optional; see below.
  EXPLORE_TEST_LOGIN: ${{ secrets.EXPLORE_TEST_LOGIN }}
  EXPLORE_TEST_PASSWORD: ${{ secrets.EXPLORE_TEST_PASSWORD }}
```

Use `OPENAI_API_KEY` instead for OpenAI. Preserve the other environment entries from the templates. Static source verification and report jobs need neither provider keys nor test-input secrets. Never put secret values in instructions, `parameters`, literal setup `text`, or URLs. Provider, Expo, GitHub, and controller credentials cannot be used as app-test input references.

For Anthropic, prefer an API key scoped to the intended workspace. If an unscoped key requires explicit workspace selection (`AGENT_WORKSPACE_REQUIRED`), use a workspace-scoped key or set the optional repository variable `ANTHROPIC_WORKSPACE_ID` to the intended Anthropic workspace ID. Both templates forward it only to capture steps. For a local capture, set the same environment variable; when using the composite action directly, pass its optional `anthropic_workspace_id` input. Leave it unset when it is not needed. This provider setting is separate from app-test inputs and does not add a field to `.expo-explore/config.yaml` or the app instructions.

The model sees secret references, and the coordinator supplies their values only to the fill operation. Text evidence is redacted; screenshots are refused when the accessibility snapshot exposes a secret. This cannot detect secrets drawn without accessibility text, so use dedicated test data and avoid displaying sensitive values in the app.

The agent controls navigation and recovery throughout capture, including login/logout when the instructions require them. It inspects the exact candidate screenshot before accepting that frame as a selected route's representative capture. Explore checks the source destination, configured parameters, representative context, and PNG/provenance integrity. Loading, visible content, keyboard overlap, and blocking dialogs require the agent's visual judgment. The record distinguishes structural verification from that visual assessment; it does not certify native alert absence. A rejected frame remains unfinished work for the agent to recover from.

The static plan still determines every required route; missing targets fail CI. AI explanations are added to the report after fixed comparison verdicts are computed, and cannot change those verdicts. Agent mode uses the existing PR comment and report interface. Extra captures for themes, personas, or modal/sheet states are not part of this version.

`source:verify` performs static validation without provider credentials. Capture commands check the installed runtime and referenced test-input secrets before building, then make a small tool-free model request with the selected runtime, key, and model. This exercises real provider access and incurs API usage; it does not prove navigation or image/tool behavior. Instructions are shared across the base and head runs, and their content affects capture-cache compatibility. Model requests share the capture time budget; mutating device actions also count toward the action limit. Provider errors fail CI with an actionable code. API usage is billed by the selected provider separately from EAS and GitHub Actions usage.

## 2. Pin the Explore version

Both workflows install one exact `@expo/explore` release, named by `EXPLORE_VERSION` at the top of each file. `expo-explore setup --workflows` sets it to the version of the CLI that runs it. To adopt a newer release, run `npx @expo/explore@latest setup --workflows` and commit the change. A workflow that setup generated and nobody edited is replaced with the new release's template (its first line records a fingerprint of the generated content); an edited workflow keeps its edits and only gets the new version and any missing secret lines, with a note when the template changed. `setup --workflows --force` replaces both files with the templates regardless.

CI downloads that release with `npm pack`, then runs `npm ci` against its `npm-shrinkwrap.json`, so every run installs the same dependency tree.

### Why can't a pull request change the tools?

The capture and publishing jobs use Expo and GitHub credentials. The review workflow runs on `pull_request_target`, so GitHub runs the default branch's copy of the workflow, with its `EXPLORE_VERSION`, for every pull request. A pull request can change its own copy, but that copy does not run until it is merged. npm versions are immutable, so the pinned version always installs the same files. Application builds still run the authorized app's code, so the pin is not a sandbox for that code.

Older setups committed a copy of the tools to `.github/vendor/expo-explore` and pinned it with an `EXPLORE_TOOLS_COMMIT` repository variable. `expo-explore doctor` reports these: delete the directory and both workflows, rerun `expo-explore setup --workflows`, and delete the variable.

## 3. Install the workflows

```sh
expo-explore setup --workflows
```

This writes `explore-review.yml` (pull requests), `explore-baseline.yml` (the default branch) and `explore-compare.yml` (any two commits, from the Actions tab or another workflow; see [Review any two commits](../README.md#compare)). Install these on the default branch. Remove superseded Explore workflows to prevent duplicate captures and comments.

Both templates use `APP_PROJECT_DIR` and `APP_INSTALL_DIR`, defaulting to `.`. For a monorepo, the project directory might be `apps/mobile` while the lockfile/install directory remains `.`. Keep config paths relative to the app. `expo-explore setup --workflows` replaces `npm ci --ignore-scripts` with the frozen-lockfile install of the package manager whose lockfile it finds: pnpm, Yarn, or bun. For bun it also adds an `oven-sh/setup-bun` step, because the runner does not have bun.

The Explore tools install with `npm ci --omit=dev --include=optional --ignore-scripts`. Preserve `--include=optional`: Claude Code and Codex require their platform-native production packages, including when npm is configured to omit optional dependencies. These packages need no postinstall script. Keep lifecycle scripts disabled and install from the release's shrinkwrap; a development CLI or global installation is not a substitute.

| Setting | Location | Purpose |
| --- | --- | --- |
| `EXPO_TOKEN` | Repository secret | EAS Build and Simulator access; create it in [Expo Access tokens](https://expo.dev/settings/access-tokens). With `report.preview` enabled it also deploys the hosted preview, so it must be a [robot user](https://docs.expo.dev/accounts/programmatic-access/) token that can create projects |
| `GITHUB_TOKEN` | Automatic job token | Templates pass `${{ github.token }}` explicitly; do not create a repository secret |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Repository secret; agent mode only | Selected provider's API credential, forwarded to capture steps |
| `ANTHROPIC_WORKSPACE_ID` | Optional repository variable | Anthropic workspace selection when the API key is not workspace-scoped; capture steps only |
| App-test secret names from setup or instructions | Repository secrets; when referenced | Inputs such as fixture credentials, forwarded to capture steps only |

Create an Expo access token for an account with access to the app's EAS project. In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**, name it `EXPO_TOKEN`, and paste the token there. Local `eas login` does not authenticate GitHub Actions. See [Expo's token authentication guide](https://docs.expo.dev/accounts/programmatic-access/).

Capture uses the automatic GitHub token with `pull-requests: write`, so it can keep the sticky comment current while the run works; publication rewrites that comment from a separate job. `GITHUB_TOKEN_MISSING` means the workflow environment is missing the automatic token mapping.

The sticky comment is one comment for the whole run: a heading with what changed (**17 screens changed · Review in Explore**), a line naming every target with a link to its report plus the compared commits and when the comment was last updated, one line for any target that is still working, failed, or finished with captures missing, then the changed screens as a short list (the first ten, each linking its Before/After in the report, with a link to the rest). Capture problems, when there are any, sit in a collapsed **Capture issues** block; the footer links the workflow run and the config. Each target's job updates only its own hidden record in the comment, so iOS and Android jobs never overwrite each other. When a new run starts (a push, or a rerun's new attempt), the comment keeps the last review under a **New run in progress** line until the new run has a ready target of its own; a target of the new run that fails is named on that line, which reads **New run failed** once nothing is still working. A push also moves the earlier run to a collapsed **Previous runs** list that keeps its head commit, result, report and run links; the last five runs are kept. A run that finishes after the PR moved on is still published, under previous runs, instead of failing. The failure job posts through the same renderer (`ci:failure`), so a crash before the pipeline's own comment still lands in that target's line.

The comment can also draw a map of the change: the added, removed and visually changed screens, the screens one step before them, and the transitions among them, as a collapsed Mermaid flowchart that GitHub draws in place. It is off by default; turn it on with:

```yaml
report:
  comment:
    map: true   # default false
```

The map leaves out screens whose source changed but whose captures match, and it is skipped when more than 30 routes changed or when the comment would be over GitHub's size limit.

PR review links always use [explore-preview.expo.app](https://explore-preview.expo.app/); no viewer-origin variable is needed or accepted by the CI publisher. Reports stay in GitHub Actions: the comment's **zip** link fetches the `explore-review-<run>-<attempt>.zip` artifact (GitHub asks for sign-in and repository read access), and the page that **Open** opens takes that ZIP by drag-and-drop or **Choose file**. Nothing is enabled per repository on Expo's side. See [report access](private-review.md).

Credentialed capture accepts open, non-draft, same-repository PRs whose authors have current write access, or are listed under `ci.trustedAuthors` in the default branch's `.expo-explore/config.yaml` (for bots such as `devin-ai-integration[bot]`). Fork PRs cannot receive capture credentials. Tools are loaded from the pinned reviewed commit, not the PR checkout. Build execution still runs the authorized application's code.

## 4. Verify and capture

The review workflow resolves the current PR through GitHub, checks out its exact base/head, and performs these stages:

| Stage | What to check |
| --- | --- |
| Source planning | Routes and dependencies come from the selected source provider |
| **Verify deterministic source planning** | Two fresh-process plans match before app installation/build/simulator work |
| Baseline lookup | Compatible exact-base evidence is reused; a miss triggers capture |
| Capture | The configured device is used; every selected target needs a screenshot of its verified destination |
| Review packaging | The bundle contains metadata and assets, not a standalone HTML page |
| Publication | The artifact is uploaded before current-PR identity is checked again and the **Open** and **zip** links are posted |

The baseline workflow runs on default-branch pushes or manual default-branch dispatch. It captures one complete commit without needing a PR. Reports and baselines are retained for 30 days; intermediate evidence and diagnostics for 7 days.

`exploration.scope: changes` includes source-affected routes and the routes one navigation step before or after them, so a reviewer sees how each change is reached and where it leads. The context is not transitive: in most apps tabs, guards and Home connect every screen, so all ancestors and descendants would be the whole app. A layout or screen guard that sends every signed-out screen to sign-in is not a step. Forwarding routes have no screenshot of their own, so their redirect chains are followed to the first screen. Unresolved navigation still selects every route. `all` captures the full inventory.

Consistency applies to the source plan and comparison of fixed evidence. Screenshots can change with live application data, time, and network. On a screen no source change reaches, such a difference is reported as a Screen variant, not a change.

## 5. Open the report

Click **Open** in the PR comment. The page names the run's report, `explore-review-<run>-<attempt>.zip`. Download it with **zip** in the same comment, then drop the ZIP anywhere on the page or use **Choose file**. The Viewer opens it in the browser and keeps a copy there for seven days, so a reload or a per-screen link from the comment opens without another drop. Screen and category links open the corresponding review state once the report is open. A file from another run is refused with the expected file name; an expired artifact needs a rerun.

GitHub decides who can open a report: only people who can download the artifact — signed in, with read access to the repository — can open it. The Viewer keeps no server credential and stores nothing outside the reviewer's browser. See [report access](private-review.md).

Changes, Map, Screens, inspectors, and downloads share the existing Viewer. Agent mode adds AI explanations to the same review; it does not infer business journeys. Additional capture variants are deferred.

## Diagnose a failed run

Capture and baseline jobs always retry cleanup for retained, verified session IDs. Cleanup never lists or stops unrelated sessions. A hard runner termination can still prevent cleanup; the configured EAS session duration bounds that case.

Read the error annotation and job summary for a stable code, affected stage, explanation, and next action. Determinism failures include both plans and a focused diff. A screen the run could not capture is reported as unavailable (`::warning` annotation, **Incomplete** PR comment, *Unavailable* in the Viewer) and the report still publishes; evidence-integrity failures fail the job with `CAPTURE_INCOMPLETE`; unfinished required comparisons fail with `COMPARISON_INCOMPLETE`. Per-target evidence and diagnostics remain available in the failure artifacts. Configuration/build/package failures also fail the job. The same applies to a screenshot pair whose comparison failed and to a baseline run that could not reach a screen: the baseline is still cached, and a review that reuses it captures that screen itself.

| Code or condition | Next action |
| --- | --- |
| `CONFIG_INVALID` | Correct the named field in config.yaml |
| `CONFIG_READ_FAILED` | Check that the config and referenced instructions file are readable inside the repository |
| `EXPLORATION_SECRET_REFERENCE_INVALID` / `EXPLORATION_SECRET_UNDECLARED` | Declare a supported app-test environment reference; provider and CI credentials are not allowed |
| `EXPLORATION_SECRET_MISSING` / `EXPLORATION_SECRET_INVALID` | Supply the named nonempty, single-line app-test secret to capture steps |
| `CAPTURE_SENSITIVE_INPUT` | Clear or submit the sensitive input, then reach a reviewable screen before capture |
| `SIMULATOR_UNAVAILABLE` | Join the EAS Simulator waitlist at [expo.dev/services/simulators](https://expo.dev/services/simulators) with the Expo account that `EXPO_TOKEN` uses |
| `CAPTURE_OBSERVER_UNSUPPORTED` | Use a supported Expo SDK and navigation version; see the README requirements |
| `CAPTURE_OBSERVER_BUILD_UNSUPPORTED` | Remove secret-visibility variables from the capture profile's EAS environment, or use a profile without them |
| `AGENT_API_KEY_MISSING` | Add and pass the provider secret, or select deterministic mode |
| `AGENT_API_KEY_INVALID` | Replace the rejected provider API key |
| `AGENT_WORKSPACE_REQUIRED` | Use an Anthropic workspace-scoped key or set the optional `ANTHROPIC_WORKSPACE_ID` repository variable |
| `AGENT_PERMISSION_DENIED` / `AGENT_MODEL_NOT_FOUND` | Check model access and the configured model identifier |
| `AGENT_QUOTA_EXHAUSTED` | Restore the provider account's quota or billing credit |
| `AGENT_RATE_LIMITED` / `AGENT_SERVICE_UNAVAILABLE` | Rerun after the provider or network recovers; transient failures receive bounded retries |
| `AGENT_REQUEST_INVALID` / `AGENT_OUTPUT_INVALID` | Inspect the diagnostic and check model image/tool support and request compatibility |
| `AGENT_CANCELLED` / `AGENT_BUDGET_EXCEEDED` | Check cancellation or simplify the instructions/increase the capture budget |
| `EXPLORE_VERSION_INVALID` | Run `expo-explore setup --workflows` to pin an exact `@expo/explore` version |
| `SOURCE_NOT_TRUSTED` | Use an eligible reviewed same-repository PR; for a bot author, add its login to `ci.trustedAuthors` in `config.yaml` on the default branch |
| Missing route parameter/link | Supply a real parameter or supported app linking mapping |
| `CAPTURE_BLOCKED_BY_ALERT` | Resolve the blocking alert with explicit setup steps; if the app name differs, check the resolved Expo app name against the installed app |
| Unavailable screen (`::warning`) | Read the per-screen annotation and the Inspector reason, fix the setup step, link, parameter, or appearance, and rerun |
| `CAPTURE_INCOMPLETE` | Inspect per-target evidence-integrity diagnostics for both revisions and rerun |
| `AGENT_NOTES_UNAVAILABLE` (warning) | The change-notes session failed (provider down, budget, malformed output): the report publishes with its deterministic verdicts and captures and without notes. Altered or unreadable image evidence (`AGENT_NOTES_EVIDENCE_INVALID`) still fails |
| `REVIEW_CONTRACT_GAP` (warning) | A part of the review failed Explore's own contract: the screen keeps its captures without a verdict, or the screen/section is omitted; the rest publishes. Report it with the diagnostics artifact |
| `COMPARISON_INCOMPLETE` | The comparator never ran: inspect comparison diagnostics, restore the required comparator, and rerun. A single pair whose comparison failed does not fail the job: it is a `::warning`, the comment counts it (`N comparisons failed`) and the screen reads *Needs review* |
| Source consistency mismatch | Inspect attached plan differences; report the analyzer defect |
| Stale PR publication | Run Explore for the current head |
| Expired report | Rerun Explore |
| "This file is the report for … run …" | The dropped ZIP belongs to another run or attempt; download the file the page names |
| "… is not a ZIP file" or "… is not an Explore report" | Drop the downloaded `explore-review-<run>-<attempt>.zip` itself, not an extracted folder or another artifact |
| **zip** asks for GitHub sign-in or shows 404 | Sign in to GitHub with an account that can read the repository; artifacts expire after 30 days, so rerun Explore if needed |

`expo-explore doctor` reports the codes above where CI would, plus these setup codes:

| Setup code | Next action |
| --- | --- |
| `CONFIG_MISSING` / `APP_NOT_EXPO` | Run `expo-explore setup` in the Expo app directory, or pass `--project` |
| `NODE_UNSUPPORTED` / `EXPLORE_TOOLS_MISSING` | Install Node.js 24.12 or newer; reinstall `@expo/explore` with optional dependencies |
| `APP_DEPENDENCIES_MISSING` | Install the app's dependencies from its lockfile |
| `EAS_NOT_AUTHENTICATED` / `EAS_PROJECT_UNAVAILABLE` / `EAS_CONFIG_FAILED` | Run `eas login`, link the app with `eas init` or get access, and make the app config evaluate |
| `APP_SCHEME_MISSING` / `APP_SCHEME_MISMATCH` | Add a scheme to the Expo config and set `app.scheme` to one the capture profile builds |
| `ROUTE_GUARD_UNPREPARED` | Screens behind source redirects start in the app's initial state: add setup steps that establish the state they need, or confirm the redirect is intended |
| `SOURCE_ANALYSIS_INCOMPLETE` / `CONFIG_PARAMETER_UNUSED` | Check the named files; use parameter keys as `doctor --json` lists them |
| `AGENT_INSTRUCTIONS_DRAFT` / `AGENT_PREFLIGHT_FAILED` | Rewrite the generated instructions from the app's source; check the provider key and model |
| `WORKFLOW_MISSING` / `EXPLORE_VERSION_UNPUBLISHED` | Run `expo-explore setup --workflows` with a published `@expo/explore` and commit the files |
| `WORKFLOW_OUTDATED` / `TOOLS_SNAPSHOT_UNUSED` | Delete `.github/vendor/expo-explore` and the old workflows, rerun `expo-explore setup --workflows`, and delete `EXPLORE_TOOLS_COMMIT` |
| `WORKFLOW_APP_DIR_MISMATCH` / `WORKFLOW_INSTALL_MISMATCH` | Set `APP_PROJECT_DIR`, `APP_INSTALL_DIR`, and the install command to the app's layout and package manager |
| `WORKFLOW_NOT_ON_DEFAULT_BRANCH` | Merge both workflows into the default branch |
| `EXPO_TOKEN_MISSING` | Create a token at [expo.dev/settings/access-tokens](https://expo.dev/settings/access-tokens) and `gh secret set EXPO_TOKEN` |
| `PREVIEW_PROJECT_FAILED` | `ci:deploy` could not create or link the preview EAS project: give `EXPO_TOKEN`'s robot user permission to create projects, or set `report.preview.project` to a project it can deploy to |
| `PREVIEW_DEPLOY_FAILED` / `PREVIEW_VERIFY_FAILED` | Rerun the deploy job; if a verified deployment answered without its token, delete it in the EAS Hosting dashboard and report the issue |
| `PREVIEW_EXPORT_MISSING` | The installed `@expo/explore` lacks `dist/hosting-preview`; reinstall the pinned release |
| `EAS_ENVIRONMENT_UNCHECKED` | Check manually that the profile's EAS environment has no secret-visibility or file variables |
| `CAPTURE_CHECK_UNCOMMITTED` | Commit the app and `.expo-explore` (locally is enough), then rerun `doctor --capture` |
| `CAPTURE_LANDING_UNVERIFIED` | The screen redirected before capture: prepare the state it needs with setup steps or instructions |

Before rolling out to all PRs, verify both navigation-provider examples, an exact-base cache miss/hit, an incomplete capture that fails with diagnostics, a hosted report opened from its real PR comment, and Local/Cloud reconnection. Record real CI/device results separately from mocked tests.
