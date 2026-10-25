import { reportStatus } from "./program-status.js";

/**
 * One line per capture step on stderr, so a CI log or a terminal shows what Explore is doing while
 * a build or a simulator session runs for minutes; the same line becomes the terminal's status
 * message (see program-status). Messages carry plan, route, and EAS identifiers only; never setup
 * text, which can hold app-test secrets.
 */
export type Progress = (message: string) => void;

export const silentProgress: Progress = () => {};

export function stderrProgress(options: { now?: () => number; write?: (text: string) => void } = {}): Progress {
  const now = options.now ?? Date.now;
  const write = options.write ?? (text => { process.stderr.write(text); });
  const started = now();
  return message => {
    reportStatus("working", { message });
    const seconds = Math.max(0, Math.floor((now() - started) / 1000));
    const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    write(`[explore ${elapsed}] ${message}\n`);
  };
}
