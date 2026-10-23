import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { redactSecrets, type CiError } from "./ci-errors.js";
import type { Progress } from "./progress.js";

/**
 * Where a capture job's time goes, appended as JSON lines to `explore-diagnostics/timings.jsonl` as the job runs, so a
 * job killed partway still leaves what it did up to then, and rendered as a table in the job summary at the end.
 *
 * What is written is closed by construction: a phase from this list, ids, counts, durations and outcome codes. Strings
 * pass through `safeText`, which redacts secrets and drops anything shaped like a link; links are built only by
 * `githubRunLink` and `easPageLink`. The diagnostics artifact is uploaded from public repositories.
 */
export const TIMING_PHASES = [
  "controllers", "plan", "preflight", "appearance-config", "baseline-wait", "baseline-blocked", "baseline-restore",
  "configuration", "fingerprint", "build-lookup", "native-build", "repack", "repack-share-wait", "build-download",
  "session-start", "session-verify", "install", "launch", "route", "pass", "export", "session-stop",
  "capture", "compare", "notes", "report",
] as const;
export type TimingPhase = typeof TIMING_PHASES[number];
export type TimingOutcome = "ok" | "failed" | "cancelled" | "skipped";
export type TimingAttributes = Readonly<Record<string, string | number | boolean | undefined>>;
/** Which capture an event belongs to: a side of a review (or the baseline), and the appearance pass of a split side. */
export type TimingLabels = { side?: string | undefined; pass?: string | undefined };

/** What a recorder writes besides spans: the run it belongs to, how it finished, and a step of the baseline job it waited for. */
export type RecordedEvent =
  | { type: "run"; workflow?: string; target?: string; release?: string; run?: string; attempt?: string }
  | { type: "baseline-step"; name: string; ms: number; conclusion: string }
  | { type: "finish"; outcome: TimingOutcome; code?: string };
export type TimingEvent = (
  | RecordedEvent
  | { type: "start"; id: string; phase: TimingPhase; attributes?: TimingAttributes }
  | { type: "end"; id: string; phase: TimingPhase; ms: number; outcome: TimingOutcome; attributes?: TimingAttributes }
) & { at: number; side?: string; pass?: string };

export type SpanEnd = (outcome?: TimingOutcome, attributes?: TimingAttributes) => void;

export type Timings = {
  /** Opens a span; the function it returns closes it, once. */
  span(phase: TimingPhase, attributes?: TimingAttributes): SpanEnd;
  /** Runs `run` in a span that ends `ok` when it returns (or its promise resolves) and `failed` or `cancelled` when it throws. */
  measure<T>(phase: TimingPhase, run: () => T, attributes?: TimingAttributes): T;
  /** A run header, a finish line or a step of the baseline job. */
  record(event: RecordedEvent): void;
  /** The same file, with these labels on every event. */
  labelled(labels: TimingLabels): Timings;
};

/**
 * Says that the calling thread is about to block in a synchronous subprocess for up to `boundMs`, and returns the
 * function that says it is done. A capture on a worker thread passes one that tells the parent, whose thread is free
 * to print a line while the worker is blocked (runCiMapOnWorker); on the main thread nothing can run meanwhile.
 */
export type BlockingNotice = (phase: TimingPhase, boundMs: number) => () => void;

export const silentTimings: Timings = {
  span: () => () => {},
  measure: (_phase, run) => run(),
  record: () => {},
  labelled: () => silentTimings,
};

const SAFE_TEXT_LENGTH = 80;

/** Text from outside Explore (a workflow step's name), made safe to publish: redacted, without links, on one short line. */
export function safeText(value: string, secrets: readonly string[] = []): string {
  const text = redactSecrets(value, secrets).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]").replace(/\s+/g, " ").trim();
  return text.length > SAFE_TEXT_LENGTH ? `${text.slice(0, SAFE_TEXT_LENGTH - 1)}…` : text;
}

function safeAttributes(attributes: TimingAttributes | undefined, secrets: readonly string[]): TimingAttributes | undefined {
  if (!attributes) return undefined;
  const entries = Object.entries(attributes).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === "string" ? safeText(value, secrets) : value] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A failure's closed code, never its message: a CiError's code (read by shape, as one rebuilt from a worker is), or none. */
function failure(error: unknown): { outcome: TimingOutcome; code?: string } {
  const code = error instanceof Error && typeof (error as Partial<CiError>).code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test((error as CiError).code)
    ? (error as CiError).code : undefined;
  if (code === "CAPTURE_CANCELLED" || error instanceof Error && error.name === "AbortError") return { outcome: "cancelled", ...(code ? { code } : {}) };
  return { outcome: "failed", ...(code ? { code } : {}) };
}

/**
 * A recorder appending to `path`, or one that records nothing without a path. Each event is one synchronous append,
 * small enough that two threads appending to the same file never interleave within a line. A failed write is
 * dropped: timing a capture must never fail it.
 */
export function createTimings(options: { path?: string | undefined; labels?: TimingLabels; secrets?: readonly string[]; now?: () => number }): Timings {
  if (!options.path) return silentTimings;
  const path = options.path;
  const now = options.now ?? Date.now;
  const secrets = options.secrets ?? [];
  const prefix = randomUUID().slice(0, 8);
  let next = 0;
  let ready = false;
  const write = (event: TimingEvent) => {
    try {
      if (!ready) { mkdirSync(dirname(path), { recursive: true }); ready = true; }
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    } catch { /* Best effort. */ }
  };
  const build = (labels: TimingLabels): Timings => {
    const tagged = { ...(labels.side ? { side: labels.side } : {}), ...(labels.pass ? { pass: labels.pass } : {}) };
    const span = (phase: TimingPhase, attributes?: TimingAttributes): SpanEnd => {
      const id = `${prefix}-${next++}`;
      const started = now();
      const opened = safeAttributes(attributes, secrets);
      write({ type: "start", id, phase, at: started, ...tagged, ...(opened ? { attributes: opened } : {}) });
      let ended = false;
      return (outcome = "ok", more) => {
        if (ended) return;
        ended = true;
        // The end repeats what the span opened with, so each line reads on its own.
        const closed = safeAttributes(more ? { ...attributes, ...more } : attributes, secrets);
        write({ type: "end", id, phase, at: now(), ms: Math.max(0, now() - started), outcome, ...tagged, ...(closed ? { attributes: closed } : {}) });
      };
    };
    return {
      span,
      measure: (phase, run, attributes) => {
        const end = span(phase, attributes);
        const fail = (error: unknown) => {
          const { outcome, code } = failure(error);
          end(outcome, code ? { code } : undefined);
        };
        let result;
        try { result = run(); } catch (error) { fail(error); throw error; }
        if (result instanceof Promise) return result.then(value => { end(); return value; }, (error: unknown) => { fail(error); throw error; }) as typeof result;
        end();
        return result;
      },
      record: event => {
        const cleaned = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "string" && key !== "type" ? safeText(value, secrets) : value]));
        write({ ...cleaned as RecordedEvent, at: now(), ...tagged });
      },
      labelled: more => build({ ...labels, ...Object.fromEntries(Object.entries(more).filter(([, value]) => value !== undefined)) }),
    };
  };
  return build(options.labels ?? {});
}

/**
 * Consecutive phases of one flow (plan, preflight, capture, compare, report): entering a phase ends the one before it
 * as `ok`; `end` closes the current one with how the flow ended.
 */
export function phaseSequence(timings: Timings): { enter(phase: TimingPhase): void; end(outcome?: TimingOutcome, code?: string): void } {
  let current: SpanEnd | undefined;
  return {
    enter: phase => { current?.(); current = timings.span(phase); },
    end: (outcome = "ok", code) => { current?.(outcome, code ? { code } : undefined); current = undefined; },
  };
}

/** Runs a synchronous call that can block for minutes in a span, telling `notice` (when there is one) while it runs. */
export function blockingCall<T>(timings: Timings, notice: BlockingNotice | undefined, phase: TimingPhase, boundMs: number, run: () => T): T {
  const done = notice?.(phase, boundMs);
  try { return timings.measure(phase, run, { boundMs }); }
  finally { done?.(); }
}

/** Prints the first line at once, then at most one every `intervalMs`: a wait's heartbeat, driven by its own poll loop. */
export function throttledProgress(progress: Progress, options: { now?: () => number; intervalMs?: number } = {}): Progress {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 60_000;
  let last: number | undefined;
  return message => {
    const at = now();
    if (last !== undefined && at - last < interval) return;
    last = at;
    progress(message);
  };
}

/** The Actions run's page, from the server and repository the runner names and a numeric run id. */
export function githubRunLink(environment: NodeJS.ProcessEnv, run: number | string): string | undefined {
  const server = environment.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = environment.GITHUB_REPOSITORY ?? "";
  if (!/^\d{1,20}$/.test(String(run)) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^https:\/\/[\w.-]+(?::\d+)?$/.test(server)) return undefined;
  return `${server}/${repository}/actions/runs/${run}`;
}

const EAS_PAGE = /^\/accounts\/([\w.-]{1,100})\/projects\/([\w.-]{1,100})\/(workflows|builds)\/([A-Za-z0-9-]{1,128})\/?$/;

/**
 * An expo.dev workflow-run or build page, rebuilt from the parts of `value` that name it, or nothing. eas-cli prints
 * these links; this keeps a query or a fragment it might carry from ever being written out.
 */
export function easPageLink(value: string | undefined, kind: "workflows" | "builds"): string | undefined {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  const match = EAS_PAGE.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "expo.dev" || url.port || url.username || url.password || !match || match[3] !== kind) return undefined;
  return `https://expo.dev/accounts/${match[1]}/projects/${match[2]}/${kind}/${match[4]}`;
}

/** "850 ms", "42 s", "2 min 14 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
}

function readEvents(jsonl: string): TimingEvent[] {
  return jsonl.split("\n").flatMap(line => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as TimingEvent;
      return value && typeof value === "object" && typeof value.type === "string" && typeof value.at === "number" ? [value] : [];
    } catch { return []; }
  });
}

const markdownCell = (value: string) => value.replace(/[|\\`*_[\]<>]/g, character => `\\${character}`);
const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;

/** Rows each section of the summary keeps, so a long run cannot crowd out another section. */
const SUMMARY_ROWS = { phases: 24, slowest: 3, steps: 12, unfinished: 8 };

/**
 * The job summary's table: what each phase took per side and pass (spans overlap, so their sum exceeds the job's
 * wall time), the routes, what the baseline job spent its time on, and spans that never ended.
 */
export function renderTimingsSummary(jsonl: string): string {
  const events = readEvents(jsonl);
  if (!events.length) return "";
  const header = events.find(event => event.type === "run") as Extract<TimingEvent, { type: "run" }> | undefined;
  const finish = [...events].reverse().find(event => event.type === "finish") as Extract<TimingEvent, { type: "finish" }> | undefined;
  const ends = events.filter((event): event is Extract<TimingEvent, { type: "end" }> => event.type === "end");
  const ended = new Set(ends.map(event => event.id));
  const unfinished = events.filter((event): event is Extract<TimingEvent, { type: "start" }> => event.type === "start" && !ended.has(event.id));
  const first = Math.min(...events.map(event => event.at));
  const last = Math.max(...events.map(event => event.at));
  const label = (event: { side?: string; pass?: string }) => [event.side, event.pass].filter(Boolean).join(" · ") || "—";

  const lines = [`### Explore capture timings${header?.target ? ` · ${markdownCell(header.target)}` : ""}`, ""];
  lines.push(`${formatDuration(last - first)} from the first event to the last${finish ? `; ${finish.outcome}${finish.code ? ` (${markdownCell(finish.code)})` : ""}` : "; no finish recorded"}. Phases overlap, so they add up to more.`, "");

  const groups = new Map<string, { phase: TimingPhase; who: string; count: number; total: number; longest: number; failed: number }>();
  for (const event of ends) {
    if (event.phase === "route") continue;
    const key = `${event.phase}\0${label(event)}`;
    const group = groups.get(key) ?? { phase: event.phase, who: label(event), count: 0, total: 0, longest: 0, failed: 0 };
    group.count += 1; group.total += event.ms; group.longest = Math.max(group.longest, event.ms);
    if (event.outcome !== "ok") group.failed += 1;
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort((a, b) => b.total - a.total);
  if (rows.length) {
    lines.push("| Phase | Side | Count | Total | Longest | Not ok |", "| --- | --- | --: | --: | --: | --: |");
    for (const row of rows.slice(0, SUMMARY_ROWS.phases)) {
      lines.push(`| ${row.phase} | ${markdownCell(row.who)} | ${row.count} | ${formatDuration(row.total)} | ${formatDuration(row.longest)} | ${row.failed || ""} |`);
    }
    if (rows.length > SUMMARY_ROWS.phases) lines.push(`| … ${rows.length - SUMMARY_ROWS.phases} more in timings.jsonl | | | | | |`);
    lines.push("");
  }

  const routes = ends.filter(event => event.phase === "route");
  if (routes.length) {
    const sorted = routes.map(event => event.ms).sort((a, b) => a - b);
    const slowest = [...routes].sort((a, b) => b.ms - a.ms).slice(0, SUMMARY_ROWS.slowest)
      .map(event => `${markdownCell(String(event.attributes?.route ?? "?"))} ${formatDuration(event.ms)}`);
    lines.push(`**Routes:** ${routes.length}, median ${formatDuration(percentile(sorted, 0.5))}, p90 ${formatDuration(percentile(sorted, 0.9))}; slowest ${slowest.join(", ")}.`, "");
  }

  const steps = events.filter((event): event is Extract<TimingEvent, { type: "baseline-step" }> => event.type === "baseline-step");
  if (steps.length) {
    lines.push("**The baseline job's steps while this review waited for it:**", "");
    for (const step of steps.slice(0, SUMMARY_ROWS.steps)) lines.push(`- ${markdownCell(step.name)}: ${formatDuration(step.ms)} (${markdownCell(step.conclusion)})`);
    lines.push("");
  }

  if (unfinished.length) {
    lines.push(`**Never finished** (the job ended first): ${unfinished.slice(0, SUMMARY_ROWS.unfinished)
      .map(event => `${event.phase}${event.side ? ` (${markdownCell(label(event))})` : ""}, ${formatDuration(last - event.at)}+`).join("; ")}.`, "");
  }
  return `${lines.join("\n")}\n`;
}

/** Where a CI job's timings go: the diagnostics folder every capture job uploads `if: always()`. None outside Actions. */
export function timingsPathFor(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.GITHUB_ACTIONS === "true" && environment.RUNNER_TEMP ? resolve(environment.RUNNER_TEMP, "explore-diagnostics", "timings.jsonl") : undefined;
}

/**
 * Appends the job's timings table to its summary, once per job: the capture command does when it ends, and
 * `ci:after-capture` does for a capture that was stopped before it could (a second signal ends it at once).
 */
export async function appendTimingsSummary(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = timingsPathFor(environment);
  if (!path || !environment.GITHUB_STEP_SUMMARY) return false;
  const mark = `${path}.summarized`;
  if (await readFile(mark).then(() => true, () => false)) return false;
  const summary = renderTimingsSummary(await readFile(path, "utf8").catch(() => ""));
  if (!summary) return false;
  await appendFile(environment.GITHUB_STEP_SUMMARY, `${summary}\n`);
  await writeFile(mark, "");
  return true;
}
