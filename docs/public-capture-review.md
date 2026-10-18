# Source-driven capture reviews

The same workflow supports Expo Router and React Navigation applications on iOS. It reads the exact source revisions, verifies plan consistency, captures selected routes, and uploads a report bundle to GitHub Actions. Reviewers download that bundle and drop it on the central hosted Viewer. Start with the [CI quick start](quickstart-ci.md).

## Source plan and consistency

`plan.json` contains source-derived route identities, dependencies, navigation edges, impact reasons, and capture order. No authored surface inventory or model response determines those values.

Expo Router inventory comes from route files and layouts. React Navigation inventory comes from statically readable JSX or object screen registrations and navigator hierarchies. Linking determines entry paths independently of route discovery. Unsupported computed declarations and unresolved paths remain diagnostics; analysis does not execute the app to guess their values.

`changes` starts with the exact two-dot Git diff and dependency impact (a JavaScript or TypeScript file whose two revisions parse to the same syntax tree, differing only in comments or in whitespace the compiler and JSX transform drop, reaches no screen; a comment a compiler reads, such as `@jsx` or `#__PURE__`, still counts), then adds, independently on each revision, the routes one navigation step before or after an affected route. Layout or screen guards do not count as steps. Forwarding routes have no screenshot of their own, so their redirect chains are followed to the first screen. `all` selects the full inventory. Source context does not imply a visible modification.

Before app build or simulator allocation, CI regenerates the canonical plan in fresh processes and compares bytes. A mismatch fails with diagnostic plans and their diff. Run identities, timestamps, absolute checkout paths, screenshots, and cache hits are excluded from planning data. Tests also vary enumeration order and checkout location.

## Commands

These commands are wired into the checked-in workflow templates:

```sh
expo-explore source:verify \
  --base-project /path/to/base \
  --head-project /path/to/head \
  --base-sha '<full-base-sha>' \
  --head-sha '<full-head-sha>' \
  --config .expo-explore/config.yaml \
  --output /path/to/consistency-output
```

```sh
expo-explore capture:review \
  --base-project /path/to/base \
  --head-project /path/to/head \
  --pull-request /path/to/pr.json \
  --config .expo-explore/config.yaml \
  --output /path/to/capture-output
```

`pr.json` comes from trusted live GitHub metadata: repository identity, number, title, URL, and actual base/head refs and SHAs. The head application's config controls the comparison. Outputs stay outside both checkouts.

A standalone baseline captures one commit and the complete route inventory:

```sh
expo-explore capture:baseline \
  --project /path/to/default-branch-checkout \
  --sha '<full-commit-sha>' \
  --config .expo-explore/config.yaml \
  --output /path/to/baseline-output
```

Package a review in the separate report job, which receives no Expo or provider credentials:

```sh
expo-explore ci:report \
  --input /path/to/capture-output/report-input.json \
  --output /path/to/report-directory
```

Upload that directory through normal `actions/upload-artifact` ZIP packaging as `explore-review-<run-id>-<attempt>`, then publish:

```sh
expo-explore ci:publish \
  --input /path/to/capture-output/report-input.json \
  --artifact-url '<artifact-url-returned-by-upload-action>'
```

The publisher verifies artifact and PR identity and builds stable links: **Open** on [explore-preview.expo.app](https://explore-preview.expo.app/) for that run and **zip** for GitHub's artifact download. The CI viewer origin is fixed; application repositories do not configure it. Do not publish GitHub's short-lived storage redirect.

## Evidence and classifications

Capture uses the configured device and bounded screenshot/accessibility collection. Deterministic mode follows concrete entry links and optional structured UI setup; agent mode uses Claude Code or Codex to navigate and recover from the current screen. App data, time, and network are not frozen. Source-plan consistency does not promise identical pixels across separate executions.

Every selected target on both revisions must have a screenshot of its verified destination, bound to the recorded screenshot hash and source commit. A missing screenshot, unresolved required parameter, unrecovered prerequisite, unverified destination, or exhausted capture budget fails CI. The workflow retains diagnostic evidence and posts a failed PR comment; capture failures are not **Needs review** findings. Visual and accessibility comparisons run only for pairs with verified destinations on both sides. Required comparison failures also fail CI.

### Automatic destination verification

CI repacks both Base and Head with the same read-only navigation observer, including when EAS creates a fresh native build. By default the repack is a hosted EAS `repack` workflow job: the tracked files of the clean checkout are staged in a temporary copy together with the generated observer, Metro override and a one-job workflow, and run with `eas workflow:run --wait`; the repacked app is downloaded and installed into the simulator session, which started while the job ran. `capture.repack: local` runs `@expo/repack-app` on the runner instead, and its app is installed without being uploaded. With `capture.simulator: local` the repack runs on that machine unless `capture.repack: eas` says otherwise. Generated files never land in the source checkout. The application does not need to import a marker or maintain a screen manifest.

The observer adapter requires **Expo SDK 57 or newer** and an installed Expo CLI with Metro configuration override support. It accepts **Expo Router 57 or newer**, or **React Navigation core 6 or newer**. Older packages fail instrumentation explicitly.

The observer reports the active navigation destination. Capture checks that destination before and after reading the screenshot. A redirect to onboarding or another screen cannot be accepted as evidence for the requested route.

In agent mode, the model inspects a candidate screenshot and accepts those exact PNG bytes. Explore verifies its source destination, representative context, and evidence integrity. Visual readiness and blocking overlays are assessed by the agent; the capture record does not certify native alert absence. See [agent mode setup](quickstart-ci.md#agent-mode).

### UI prerequisites

Use `setup` for ordinary app interactions needed to reach selected screens. The source analyzer still owns route discovery, selection, and identity; setup actions do not define a manual screen inventory. Dynamic route values can come from source or `parameters`, and must identify data that actually exists in the app.

For example, an app with a name field and an onboarding Continue button can use:

```yaml
mode: deterministic
app:
  platform: ios
  bundleId: com.example.app
  easProfile: simulator
  scheme: sample
navigation:
  provider: expo-router
device:
  name: iPhone 17 Pro
exploration:
  scope: all
capture:
  maxMinutes: 30
  maxActions: 500
  repack: eas # eas (hosted workflow job; the default on EAS Simulator) | local (repack-app on the runner; the default with simulator: local)
  appearance: auto # auto (follow the app's userInterfaceStyle: automatic captures light and dark) | dark | light | [dark, light]
  launch: screenshot # screenshot (relaunch the app per appearance and keep its splash and first settled frame, default) | video (also keep a launch recording in the report) | off
  reset: root-link # root-link (open the app's root link and let it settle before every route link, default) | none (each link opens from whatever the previous route left on screen)
  unattributed: publish # publish (a frame of the screen the app showed instead of a planned route is kept in the report, marked unattributed and never compared, default) | discard (the route is reported as failed with no frame)
  # readinessSeconds: 8 # how long a route link gets to show its destination after it opens (default 8 on iOS, 10 on Android; extended while the screen is still changing, up to twice this)
setup:
  - action: open
    url: sample://onboarding
    ready:
      identifier: name-field
  - action: fill
    identifier: name-field
    text: Mochi
  - action: scroll
    direction: bottom
    ready:
      identifier: onboarding-continue
      enabled: true
  - action: tap
    identifier: onboarding-continue
    ready:
      label: Home
```

Replace the example app settings, URL, input, and selectors with those exposed by your application. React Navigation applications use `navigation.provider: react-navigation` and may specify a repository-relative `navigation.entry`, such as `src/App.tsx`.

`tap`, `fill`, and each `ready` condition require exactly one `label` or `identifier`. Selectors match visible accessibility nodes exactly; taps and fills require an enabled, unambiguous control. `fill.text` is a nonempty single line of at most 4,096 characters. `scroll.direction` accepts `up`, `down`, `left`, `right`, `top`, or `bottom`. `open.url` must use the app's custom scheme. An explicit `wait` uses `milliseconds` from 1 to 30,000. The config accepts at most 100 setup actions.

`type` accepts `text` with the same bounds and optional `ready`, and must immediately follow an explicit input `tap`. A fresh snapshot must show the same input and route, a visible keyboard, and no alert. It uses the bounded readiness wait for keyboard appearance while checking that the input and route remain unchanged. It appends once with the native typing command and consumes the focus attempt even if that command fails. It does not clear the field, retry automatically, or verify contents. Use a known form state and a submission checkpoint; missing secure-field accessibility values are not proof of emptiness. `fill` and `type` both support `{{secret:ENV_NAME}}` references. See the [secure input example](quickstart-ci.md#entry-links-and-runtime-gaps).

An optional `ready` condition waits for its matching node after an action, with an optional `enabled` boolean. Readiness and control lookup are bounded to 20 snapshots with 250 ms polling between snapshots. All mutations and polling waits consume the shared action/time budget. Prefer a readiness condition over an arbitrary delay.

Setup and route capture share the same running app; opening the next route does not relaunch it. In deterministic mode, an action becomes eligible for capture after its declared `ready` condition succeeds, or immediately after an action without `ready`. This preserves intermediate screens before later interactions clear photo, scan, or other transient state. Already captured targets are not reopened. In agent mode, setup is an optional starting replay and the agent chooses when to inspect and accept each representative frame. CI does not fabricate app data or mutate private application state to bypass prerequisites.

### Capture failures and next actions

A target the run could not capture (setup did not complete, a route has no supported link or parameters, the capture budget ran out, or a secondary appearance did not render) does not fail the job. The report still publishes with that screen marked unavailable: the PR comment reads **Incomplete** and lists each unavailable screen, the job carries one `::warning` annotation per screen with its diagnostic and next action, and the Viewer shows the screen as *Unavailable* with the reason in place of its screenshot. When only a secondary appearance failed, the primary frame stays reported and `<route>@<scheme>` is the unavailable surface. Fix the underlying failure rather than excluding the target to make the report complete.

`CAPTURE_INCOMPLETE` remains fatal for evidence integrity: a screenshot bound to the wrong target, an unverified or duplicated selection, an invalid image binding or provenance. It aggregates per-target diagnostics from both revisions.

| Diagnostic | Next action |
| --- | --- |
| `CAPTURE_OBSERVER_UNSUPPORTED` | Check the installed Expo/navigation versions and Expo CLI support for the current observer adapter. |
| `CAPTURE_OBSERVER_MISSING` | Inspect instrumentation and runtime diagnostics; the capture build must expose its active destination. |
| `ROUTE_LANDING_MISMATCH` | Inspect expected and observed destinations, then complete the required UI navigation in the same app session. |
| `CAPTURE_MISSING_PARAMS` | Supply real route parameter values through source or `parameters` and ensure their data exists. |
| `SETUP_CONTROL_NOT_READY` / `SETUP_SELECTOR_AMBIGUOUS` | Correct the exact label or identifier and the steps needed to expose one enabled control. |
| `SETUP_READINESS_TIMEOUT` | Correct the prerequisite action or readiness condition; inspect the last observed screen. |
| `CAPTURE_BUDGET_EXHAUSTED` | Check the failed action, then increase `capture.maxActions` or `capture.maxMinutes` if the required flow needs more budget. |

### Review classifications

The source plan decides whether a screen is a review target; the evidence decides what it shows.
`sourceScope` on each report surface records the source side: `screen` (its route, declaration, or
imported source changed), `app-wide` (only app-wide inputs such as dependencies, app config, or
`eas.json` changed, or the plan is conservative), or `none`.

| Source \ Evidence | Differs | No visible difference | Inconclusive |
| --- | --- | --- | --- |
| Added / removed route | Added / Removed | Added / Removed | Added / Removed |
| Screen source changed | Modified | Unchanged (not counted as a change) | Needs review |
| Only app-wide inputs changed | Modified | Unchanged (the PR comment names the app-wide change once) | Needs review |
| Source unchanged | Screen variant | Unchanged | Unchanged |

| Result | Meaning |
| --- | --- |
| Added / Removed | Route presence differs between source inventories |
| Modified | The screen's source changed and comparable evidence differs |
| Accessibility only | Modified, but the screenshots match: only the accessibility tree (what screen readers and voice control read) differs. Counted as a change and listed apart from the visual ones |
| Needs review | The screen's source changed and the comparison could not tell whether it looks different; a review target |
| Screen variant | No source change reaches the screen, but its captures differ in runtime UI state (balances, timestamps, loaded content). Listed apart from changes |
| Unchanged | No visible difference, whether or not the screen's source changed. Explore reports visual changes; reports before 0.19.1 called a source change with no visible difference Needs review |
| Not compared | No comparison was performed, including for a screen whose source changed. Not counted as a change: Explore reports what the captures show, not what the code might do. Earlier versions listed these as Source-affected |

A difference that rounds to 0.00% of pixels is rendering noise and counts as no difference.
A changed region whose content only moved (a layout that grew by a device pixel, a sheet that is taller) carries
`shift`, how far it moved in screenshot pixels, and `allRegionsMoved: true` says every region CI found moved (it
publishes the largest eight); the Viewer labels each outline with its move. A shift does not change the verdict: a
moved screen is still Modified.
Accessibility only is how readers present a `modified` verdict whose visual verdict is `unchanged`; the contract has no
separate status for it, so reports from earlier versions show it too. The accessibility tree can include content outside
the screenshot (rows below the fold, elements under a sheet), so such a change may still be visible on a device.
A runtime difference is not proof that the code change caused it. Deterministic mode uses template notes and evidence facts. Agent mode adds AI explanations from the captured evidence and source changes through a separate CLI session; those explanations cannot override fixed verdicts. Structural flows describe possible source navigation; semantic business grouping remains deferred.

## Artifacts and cache

Reports contain the plan, capture/review data, execution metadata, and referenced assets. They do not contain credentials or require a separate data-storage service. The reviewer downloads the artifact from GitHub and drops it on the Viewer; the browser extracts images on demand.

Baselines come from the default-branch `explore-baseline.yml` workflow. Restore checks the repository, workflow, exact commit, branch, completed run, and evidence compatibility. Compatibility includes source/capture inputs, setup order, configured device/build profile, tools, the observer implementation hash, and evidence integrity. Only verified screenshots with matching outcome hashes can be restored. A partial cache may supply its verified subset; missing targets are captured again. A baseline run that could not reach a screen still caches the rest (the job warns and names the screen); the review captures that screen itself. Unverified cached observations are discarded before recapture. Corrupt, expired, or incompatible evidence is a cache miss. A baseline warm-up is not required, and the baseline job itself fails if any selected target remains incomplete.

Reports and baselines are retained for 30 days, intermediate evidence and diagnostics for 7 days. GitHub's artifact download decides who can open a report; see [report access](private-review.md).

## Review

The PR comment retains its existing grouping and ordering with **Modified** terminology. Screen variants and app-wide source changes are stated in one line each instead of per screen. **zip** fetches the ZIP from GitHub; **Open**, status links, and individual screen links open the appropriate state of the dropped report.

Opening a report does not allocate a simulator.
