import { has } from "./args.js";

const GET_STARTED = `Get started (run these in the Expo app's directory):
  setup [--project DIRECTORY]
       (asks about the app and its routes, writes .expo-explore/config.yaml, and installs the
        GitHub workflows pinned to this version)
       Flags, all optional: --platform ios|android --device NAME --scope changes|all --profile NAME --bundle-id ID
        --scheme SCHEME --navigation auto|expo-router|react-navigation
        --mode deterministic|agent --provider anthropic|openai --model ID
        --param ROUTE.NAME=VALUE --app-state "coding agent"|"setup template"|skip
        --workflows|--no-workflows --non-interactive
  setup --workflows [--force] [--project DIRECTORY]
       (with an existing config: add or update the workflows and pin them to this version)
  setup --check [--project DIRECTORY]
  doctor [--project DIRECTORY] [--offline] [--no-github] [--check-model] [--json]
       (checks every setup step and prints the next action for each problem; exits 1 until ready)
       (--offline skips EAS and GitHub; --check-model sends one small request with the local provider key)
  doctor --capture [--project DIRECTORY] [--output DIRECTORY] [--target ID | --platform ios|android] [--controller agent-device|argent] [--simulator eas|local] [--repack eas|local] [--yes]
       (captures the committed HEAD like the baseline workflow, with your eas login, and reports each route)
  capture [--base REF] [--head REF | --committed] [--target ID | --platform ios|android] [--parallel N] [--scope all|changes]
       [--controller agent-device|argent] [--simulator eas|local] [--repack eas|local] [--upload [--expires-in 7d|30d|never]] [--no-open] [--no-cache] [--output DIRECTORY] [--project DIRECTORY]
       (on this machine: checks out both commits in temporary worktrees, captures them with your eas login and your
        local claude or codex login, and opens the report; the head is HEAD with your uncommitted changes, as eas build
        uploads them (--committed, or cli.requireCommit in eas.json, leaves them out); the base defaults to where HEAD
        left the default branch;
        without .expo-explore/config.yaml it uses the defaults setup would write;
        it runs both commits' code as you, so review only commits you would run; capture:review is the same command;
        --controller argent drives the simulator with Argent instead of agent-device, the default (or set
        capture.controller in config.yaml); on EAS Simulator Argent captures one appearance, since it cannot switch it yet;
        --simulator local runs each commit on a simulator (Xcode) or emulator (Android SDK) Explore starts on this
        machine, instead of EAS Simulator, and removes it afterwards (or set capture.simulator in config.yaml); builds
        still run on EAS, and the host switches appearance for either controller; the app is repacked with the route
        observer on this machine too (--repack eas, or capture.repack, keeps the hosted EAS job);
        with targets in config.yaml it reviews them at once (--parallel N at most N at a time; the targets of a platform
        share each commit's build), --target ID one of them, --platform those of a platform)
  view [--catalog FILE] [--port N] [--no-open]
       (opens a report in the Viewer)
  reports [list | open ID | add REPORT... | upload ID | rm ID | prune] [--all] [--json]
       (the runs kept on this machine: local reviews, explorations and uploaded reports, for 30 days or up to 2 GB;
        in a terminal, an arrow-key picker: Enter opens a run in the local Viewer, u hosts it, d deletes it;
        ID is a run's id from reports list, or latest; EXPLORE_INTRO=off skips the title animation)
  report:upload <report.zip | report directory>... [--owner ACCOUNT] [--project SLUG] [--expires-in 7d|30d|never] [--config FILE] [--json]
       (hosts reports already on this machine on EAS Hosting behind one link, with your eas login: one per platform
        of the same review, from capture:review --output or a downloaded explore-review artifact, or one explore:binary report)`;

const BINARY = `Prebuilt apps (no source needed; runs on EAS Simulator with your local claude or codex login):
  explore:binary <app.apk | app.app | app.tar.gz | simulator .ipa> [--output DIRECTORY] [--no-upload] [--json]
       (installs the archive in a fresh EAS Simulator session, lets the model explore it, writes a map
        and report under --output, hosts the report on EAS Hosting, and prints the link)
       Flags, all optional: --device NAME --bundle-id ID --launch-url URL --hints "what to focus on"
        --controller agent-device|argent (the session's device controller; agent-device by default)
        (a sign-in in --hints is written as {{secret:NAME}}: Explore types the value of the environment variable NAME,
        and the model and the report only see the reference)
        --max-duration-minutes N --max-screens N --max-actions N --provider anthropic|openai --model ID
        --owner ACCOUNT --project SLUG --expires-in 7d|30d|never --allow-destructive "Label,Other label"
        --alias NAME (one EAS Hosting host per app that always serves the newest run; with EXPLORE_PREVIEW_TOKEN
        set to a fixed 32-character token, the hosted link is the same every run)
       (iOS needs a simulator build; a device .ipa and Android .aab are rejected before any session starts)
  explore:session [SESSION_ID] [--bundle-id ID] [--output DIRECTORY] [--upload] [--json]
       (explores an app that is already installed on an EAS Simulator session you started — run it where
        "eas simulator:start --type agent-device --out-config-type dotenv" (or --type argent) wrote .env.eas-simulator,
        or pass --env-file FILE, or export EAS_SIMULATOR_SESSION_ID with AGENT_DEVICE_DAEMON_BASE_URL and
        AGENT_DEVICE_DAEMON_AUTH_TOKEN, or with ARGENT_TOOLS_URL and ARGENT_AUTH_TOKEN; writes the map and report, then opens them in the local Viewer;
        --upload hosts the report instead, --no-open skips the Viewer; the session is left running;
        the app is the one in the foreground, else the only installed one; --bundle-id picks it otherwise;
        the controller follows the session's type, and --controller must match it)
       Extra flags: --app-name NAME --app-version X.Y --port N, plus the explore:binary budget/model flags
       Afterwards: view --dir DIRECTORY, screen:list --dir DIRECTORY, gap:list --dir DIRECTORY`;

const CI = `CI (the installed workflows run these; they manage remote EAS Simulator sessions):
  config:targets [--project DIRECTORY] [--config FILE]
       (lists the targets config.yaml captures, with their platforms and labels; the review workflow's matrix)
  config:platforms [--project DIRECTORY] [--config FILE]
       (lists the platforms config.yaml captures; the review workflow's matrix)
  capture:review --base-project DIRECTORY --head-project DIRECTORY (--pull-request FILE | --compare FILE)
       --output TEMP_DIRECTORY [--config .expo-explore/config.yaml] [--target ID | --platform ios|android] [--controller agent-device|argent] [--simulator eas|local] [--repack eas|local]
       (--compare reviews any two commits without a PR: {"origin":"compare","repositoryId","repository","base":{ref,sha},"head":{ref,sha}})
  capture:baseline --project DIRECTORY --sha COMMIT --output TEMP_DIRECTORY [--config FILE] [--target ID | --platform ios|android] [--controller agent-device|argent] [--simulator eas|local] [--repack eas|local]
  source:verify --base-project DIRECTORY --head-project DIRECTORY
       --base-sha COMMIT --head-sha COMMIT --output DIRECTORY [--config FILE] [--scope all|changes] [--target ID | --platform ios|android]
  compare --baseline DIRECTORY --current DIRECTORY --output FILE
       [--review-output FILE] [--catalog-output FILE] [--catalog-name NAME]
       [--base-surface-coverage FILE] [--head-surface-coverage FILE]
  export:web --catalog FILE --output DIRECTORY
  ci:report --input REPORT_INPUT --output DIRECTORY [--target ID | --platform ios|android]
  ci:publish --input REPORT_INPUT --artifact-url GITHUB_ARTIFACT_URL [--target ID | --platform ios|android]
  ci:publish --inputs DIRECTORY        (one <platform>/ subdirectory per captured platform)
  ci:deploy --input REPORT_INPUT --report REPORT_DIR --artifact-url GITHUB_ARTIFACT_URL [--target ID | --platform ios|android]
  ci:deploy --inputs DIRECTORY --reports DIRECTORY
  ci:pr --pr N [--output FILE] [--app-dir DIRECTORY]
       (resolves the live PR and refuses it unless it is open, from this repository, and by a trusted author)
  ci:compare-refs --project DIRECTORY --base REF --head REF [--output FILE]
  ci:find-baseline --sha COMMIT [--target ID | --platform ios|android]
  ci:after-capture --output TEMP_DIRECTORY --checkout DIRECTORY...
       (stops the capture's EAS Simulator sessions and checks capture left each checkout unchanged)
       (the ci:* commands write their results to $GITHUB_OUTPUT for the next steps)`;

const MAP_QUERIES = `Map queries (for coding agents reading a local exploration map; JSON output, never provision devices):
  summary
  status
  search --query TEXT [--limit N] [--cursor N]
  screen:list [--unexplored] [--limit N] [--cursor N]
  screen:get --id ID
  element:list [--screen ID] [--role ROLE] [--query TEXT] [--actionable]
  observation:list [--screen ID]
  observation:get --id ID
  attempt:list [--screen ID] [--outcome OUTCOME]
  attempt:get --id ID
  transition:list [--screen ID]
  transition:get --id ID
  neighbors --screen ID
  path --from ID --to ID
  journey:list
  journey:get --id ID
  frontier:list [--status STATUS]
  frontier:next
  gap:list [--status open|accepted|resolved]
  validate
  export --output DIRECTORY

Map queries, validate, and export accept --dir DIRECTORY (default .explore) and --json.`;

export function help(): void {
  const all = has("all");
  console.log([
    "Expo Explore — screenshots and change review for Expo apps, from CI",
    "",
    "Install:",
    "  npm install -g @expo/explore",
    "  expo-explore help [--all]",
    "  expo-explore version   (also --version)",
    "",
    GET_STARTED,
    "",
    BINARY,
    "",
    CI,
    "",
    all ? MAP_QUERIES : "Map queries for coding agents: expo-explore help --all",
  ].join("\n"));
}
