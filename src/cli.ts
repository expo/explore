#!/usr/bin/env node

import { CiError, ciErrorForCommand, reportCiError } from "./shared/ci-errors.js";
import { resolve } from "node:path";
import { ExploreStore } from "./map/store.js";
import { QUERY_CONTRACT } from "./types.js";
import { EXPLORE_VERSION } from "./shared/package-paths.js";
import { isTargetId } from "./config/explore-config.js";
import { command, resultContract, argumentError, validateCommandArguments, flag, has, setStore } from "./cli/args.js";
import { help } from "./cli/help.js";
import { listScreens, getScreen, listElements, listObservations, getObservation, nextFrontier, listAttempts, getAttempt, listTransitions, getTransition, neighbors, pathQuery, listJourneys, getJourney, listFrontier, listGaps, summary, search, status, validate, exportArtifacts } from "./cli/map-commands.js";
import { compareCommand, exportWeb, view } from "./cli/catalog-commands.js";
import { ciReport, ciPublish, ciFailure, ciDeploy, ciPullRequest, ciFindBaseline, ciCompareRefs, ciAfterCapture, setup, doctor, sourceVerify, captureReview, captureBaseline, configPlatforms, configTargetList } from "./cli/ci-commands.js";
import { exploreBinary, exploreSession } from "./cli/binary-commands.js";
import { reports, reportUpload } from "./cli/report-commands.js";

const handlers: Record<string, () => Promise<void> | void> = {
  setup,
  "screen:list": listScreens,
  "screen:get": getScreen,
  "element:list": listElements,
  "observation:list": listObservations,
  "observation:get": getObservation,
  "frontier:next": nextFrontier,
  "frontier:list": listFrontier,
  "attempt:list": listAttempts,
  "attempt:get": getAttempt,
  "transition:list": listTransitions,
  "transition:get": getTransition,
  neighbors,
  path: pathQuery,
  "journey:list": listJourneys,
  "journey:get": getJourney,
  "gap:list": listGaps,
  summary,
  search,
  status,
  validate,
  export: exportArtifacts,
  "export:web": exportWeb,
  "explore:binary": exploreBinary,
  "explore:session": exploreSession,
  "report:upload": reportUpload,
  reports,
  "ci:report": ciReport,
  "ci:publish": ciPublish,
  "ci:failure": ciFailure,
  "ci:deploy": ciDeploy,
  "ci:pr": ciPullRequest,
  "ci:find-baseline": ciFindBaseline,
  "ci:compare-refs": ciCompareRefs,
  "ci:after-capture": ciAfterCapture,
  "capture:review": captureReview,
  "capture:baseline": captureBaseline,
  "source:verify": sourceVerify,
  "config:platforms": configPlatforms,
  "config:targets": configTargetList,
  doctor,
  compare: compareCommand,
  view,
  help,
  "--help": help,
  "-h": help,
  version,
  "--version": version,
  "-v": version,
};

/** Commands people type at a terminal; everything else answers agents and scripts in JSON. */
const HUMAN_COMMANDS = new Set(["setup", "doctor", "view", "help", "explore:binary", "explore:session", "report:upload", "reports"]);

function version(): void {
  console.log(EXPLORE_VERSION);
}

try {
  const handler = handlers[command];
  if (!handler) argumentError(`Unknown command: ${command}`, undefined, "Run expo-explore help and choose a supported command.");
  validateCommandArguments();
  const workspace = resolve(process.cwd(), flag("dir") ?? ".explore");
  setStore(new ExploreStore(workspace));
  await handler();
} catch (error) {
  if (command.startsWith("capture:") || command.startsWith("source:") || command.startsWith("ci:") || command.startsWith("config:")) {
    // The failure comment names the target from this: a capture, report or publication of one matrix target.
    const target = (() => { try { return flag("target"); } catch { return undefined; } })();
    const diagnostic = await reportCiError(ciErrorForCommand(error, command), {
      ...(process.env.RUNNER_TEMP ? { diagnosticsPath: resolve(process.env.RUNNER_TEMP, "explore-diagnostics", "error.json") } : {}),
      ...(isTargetId(target) ? { target } : {}),
      ...(has("json") ? { write: (line: string) => { if (process.env.GITHUB_ACTIONS === "true") console.log(line); } } : {}),
    });
    if (has("json")) console.error(JSON.stringify({ contract: resultContract, command, ok: false, error: diagnostic.message, diagnostic }));
  } else if ((HUMAN_COMMANDS.has(command) || !handlers[command]) && !has("json")) {
    // People run these at a terminal; JSON stays available with --json for agents and scripts.
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof CiError && error.nextAction) console.error(`→ ${error.nextAction}`);
  } else console.error(JSON.stringify({ contract: QUERY_CONTRACT, command, ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
