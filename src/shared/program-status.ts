import { environmentSecrets, redactSecrets } from "./ci-errors.js";

/**
 * Tells the terminal what a long command is doing with OSC 7501
 * (https://superlogical.com/rex/docs/build/program-status), so a tab left in the background can show that a review is
 * working, waiting on an answer, done or failed. Only an interactive stderr gets the sequence; a terminal that does not
 * know it ignores it, as it does any unknown OSC (ECMA-48 §8.3.89). The spec's feature query is not sent: reading its
 * reply would put stdin in raw mode under the command's own prompts.
 *
 * The terminal drops a `working` or `blocked` record when the process exits and keeps `done` and `error`, so an exit
 * without a final report (a second Ctrl+C) leaves nothing behind.
 */
export type ProgramState = "working" | "blocked" | "done" | "error" | "clear";
export type BlockedKind = "permission" | "question" | "auth";

const APP = "expo-explore";
/** The spec allows 2048 bytes of decoded `msg`; 512 code points stay under it in any script. */
const MESSAGE_LIMIT = 512;

let write: ((text: string) => void) | undefined;
let last: ProgramState | undefined;

/**
 * A message is redacted as stderr's diagnostics are, since a kept record outlives the process. Redacting comes first,
 * so truncation cannot leave a partial secret the patterns no longer match.
 */
export function programStatusSequence(state: ProgramState, details: { message?: string; kind?: BlockedKind } = {}, environment: NodeJS.ProcessEnv = process.env): string {
  const pairs = [`state=${state}`, `app=${APP}`];
  if (state === "blocked" && details.kind) pairs.push(`kind=${details.kind}`);
  const redacted = details.message === undefined ? undefined : redactSecrets(details.message, environmentSecrets(environment));
  // The terminal discards a report whose message holds control characters, and shows one line.
  const message = redacted?.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
  // By code points, so an emoji is not split; the first cut keeps Array.from off a long git stderr.
  const shown = message && Array.from(message.slice(0, MESSAGE_LIMIT * 2)).slice(0, MESSAGE_LIMIT).join("");
  if (shown) pairs.push(`msg=${Buffer.from(shown, "utf8").toString("base64")}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

/** CI is left out even under a pseudo-terminal (Buildkite, `docker run -t`), whose log would keep the raw sequences. */
export function terminalReportsStatus(stream: { isTTY?: boolean } = process.stderr, environment: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && environment.TERM !== "dumb" && !environment.CI;
}

/** Turns reports on for this process when stderr is a terminal; until then `reportStatus` writes nothing. */
export function enableProgramStatus(options: { write?: (text: string) => void } = {}): void {
  if (options.write) write = options.write;
  else if (terminalReportsStatus()) write = text => { process.stderr.write(text); };
}

export function reportStatus(state: ProgramState, details: { message?: string; kind?: BlockedKind } = {}): void {
  last = state;
  write?.(programStatusSequence(state, details));
}

/** `done`, or `error` when the command has already set a failing exit code (a review with a failed target). */
export function reportFinished(message?: string): void {
  reportStatus(process.exitCode ? "error" : "done", message ? { message } : {});
}

/** The last state reported, so the command's end reports `done` only when nothing more specific came before it. */
export function lastReportedStatus(): ProgramState | undefined {
  return last;
}
