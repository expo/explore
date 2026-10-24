# Architecture

This file describes the source layout and the rules that keep it in order.

## Repository parts

`src/` is the Node CLI, `expo-explore`. TypeScript compiles it to `dist/`.
`viewer/` is the browser Viewer. It uses React and Vite, and builds to `dist/viewer`.
`viewer-host/` hosts the central Viewer (see [viewer-host/README.md](viewer-host/README.md)).
`action.yml`, `templates/` and `skills/` are the CI and setup integration.
`test/` holds the tests: `node/`, `browser/`, `e2e/` (Playwright) and `ci/` (local CI runs), with shared `fixtures/` and `helpers/`.

## Entry points

- `src/cli.ts` is the bin. It maps each command to a handler in `src/cli/`.
- `src/types.ts` holds the public types. The package exports it as `@expo/explore/types`.
- `src/source/plan-worker.ts` is a process entry point. `src/ci/verified-plan.ts` starts it by path to generate the plan again in a fresh process.
- `src/capture/agent/mcp-bridge-worker.ts` is a stdio MCP bridge. The local Claude CLI starts it (see `src/capture/agent/session-local.ts`).

## Folders in src

| Folder | What it does | Main files |
| --- | --- | --- |
| `config` | Reads and validates `.expo-explore/config.yaml`, the exploration inputs, and the `setup` command. | `explore-config.ts`, `exploration-inputs.ts`, `setup.ts` |
| `source` | Source analysis: the route inventory, navigation extraction, git diff and dependency impact, and the deterministic capture plan. | `route-inventory.ts`, `navigation.ts`, `git-diff.ts`, `impact.ts`, `capture-plan.ts` |
| `source/route-providers` | Route discovery for Expo Router and React Navigation. | `expo-router.ts`, `react-navigation.ts` |
| `capture` | Runs the capture on EAS Simulator. | `run.ts` (entry), `eas-build.ts`, `simulator.ts`, `controller.ts`, `route-capture.ts`, `setup-actions.ts`, `observer.ts`, `health.ts` |
| `capture/agent` | Agent mode: Claude or Codex sessions, the pinned runtimes, the navigation runtime, readiness checks and change notes. | `session.ts`, `codex-config.ts`, `claude-runtime.ts`, `runtime.ts`, `readiness.ts`, `change-notes.ts` |
| `review` | Compares base and head evidence, and prepares the local report assets. `ci` calls `evidence-assessment.ts` and `capture-review.ts`. | `evidence-assessment.ts`, `capture-review.ts`, `visual-evidence.ts`, `runtime-evidence.ts`, `evidence-comparator.ts`, `reviewer-changes.ts` |
| `report` | The report artifact, the pull-request comment, and the Viewer links. | `artifact.ts`, `pr-comment*.ts`, `viewer-links.ts` |
| `ci` | The pipeline behind `source:verify`, `capture:review` and `capture:baseline`. | `pipeline.ts`, `verified-plan.ts`, `artifact-cache.ts` |
| `binary` | Explores an app with no source (`explore:binary`, `explore:session`): the archive, the device session, the explorer, and the strategies that drive it. | `run.ts` (entry), `explorer.ts`, `strategy.ts`, `replay.ts`, `flows.ts`, `archive.ts`, `report.ts` |
| `cli` | Argument parsing, help, and the command handlers. | `args.ts`, `help.ts`, `*-commands.ts` |
| `map` | The local map store, build catalogs and comparisons, and the server for `expo-explore view`. | `store.ts`, `build-workspace.ts`, `compare.ts`, `viewer-server.ts` |
| `contracts` | The modules that `viewer/src` imports from `src/`, by value or by type: data shapes, validators and projections that the CLI and the Viewer share. `capture.ts` also defines the review types that the Viewer reads, such as `PublicReview`, and `review-validation.ts` validates them. | `capture.ts`, `review.ts`, `review-validation.ts`, `source-validation.ts` |
| `shared` | Small Node utilities that several folders use, and the pinned `agent-device` version that capture and review both check. | `ci-errors.ts`, `canonical-json.ts`, `bounded-bytes.ts`, `png-evidence.ts`, `archive-entries.ts` (tar.gz and zip readers), `agent-device-version.ts`, `timings.ts` (a capture job's timings and its summary, CI-FLOW §4.0) |

## Dependency rule

The list below shows the value imports between folders. Type-only imports are not in it, because TypeScript erases them.
Each layer imports only from the layers below it.

1. `contracts/` and `src/types.ts` import nothing else in `src/`; `shared/` imports only `contracts/`.
2. `config` and `report` import only `contracts/` and `shared/`. `source/route-providers` imports nothing else in `src/`.
3. `source` imports `source/route-providers`.
4. `capture` imports `capture/agent`, `config` and `map`. `capture/agent` imports `capture` and `config`.
5. `review` imports `capture` and `map`.
6. `ci` imports `config`, `source`, `capture`, `capture/agent`, `review` and `report`. `binary` imports `config`, `capture`, `capture/agent`, `map` and `report`.
7. `cli` imports `ci`, `binary`, `map`, `config` and `report`. `src/cli.ts` imports `cli`, `map` and `shared`.

Every folder may import `contracts/`, `shared/` and `src/types.ts`.
The exception is `contracts/`: its value imports stay inside `contracts/` or go to `src/types.ts`.
The only cycle is `capture` and `capture/agent`, which are one feature.
Do not add a new import that points up a layer.

## Capture strategies

A capture decides three things: what to look at, how to get there, and what to record.

- **What to look at.** For a review, `source` plans the routes from the app's source (`capture-plan.ts`). An exploration has no source; its strategy decides as it goes.
- **How to get there.** In a review, `capture/route-capture.ts` opens each planned route by deep link, or, in agent mode, a model navigates to it (`capture/agent/runtime.ts`). In an exploration, a strategy drives the explorer's tools: a model exploring on its own, a replay plan (`binary/replay.ts`), or named flows (`binary/flows.ts`).
- **What to record.** The host records the evidence, never the strategy: `capture/route-capture.ts` in a review, `binary/explorer.ts` in an exploration. The host also owns the device, the budgets, refusing destructive and app-leaving actions, and redacting secrets. Both write an `ExploreMap` (`src/types.ts`, `schema/screen-map.v1.schema.json`). A review adds the capture bundle (`contracts/capture.ts`); an exploration adds the report in `contracts/standalone-report.ts`.

To add an exploration strategy, add a case to `StrategyChoice` in `binary/strategy.ts`: what it checks before any device starts, and the session it runs. The session is given the explorer's tools and calls them, as the model sessions, `createReplaySession` and `createFlowSession` do. Reviews have no such seam yet: the deep-link loop and agent mode are two branches of `capturePlannedRoutes`.

## The contracts boundary

`viewer/src` imports `src/` only through `src/contracts/` and `src/types.ts`.
The Viewer may bundle any file in `src/contracts/`, so each file must stay browser-safe. They follow these rules:

- No `node:` imports, also not type-only ones.
- No `require`, no `createRequire` and no `process.getBuiltinModule`.
- Value imports only from `src/contracts/` or `src/types.ts`.

Other type-only imports may point anywhere, because TypeScript erases them.
`test/node/src-layout.test.mjs` enforces the boundary.
To share a new module with the Viewer, move it into `src/contracts/` and keep it free of Node APIs.

## Naming

- A file name says what the file does. It does not repeat its folder or a parent folder: `src/config/setup.ts`, not `src/config/config-setup.ts` or `src/config/config.ts`. `test/node/src-layout.test.mjs` enforces this.
- A `*-worker.ts` file is a process entry point that other code starts by path. When you move one, update the code that starts it.
- Files in `src/contracts` keep a feature prefix (`source-validation.ts`, `review-validation.ts`), because the folder spans features.
- `src/` holds only `.ts` files, so documentation stays outside `src/`.
