import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CiErrorData = {
  code: string;
  stage: string;
  message: string;
  nextAction: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

/** An actionable failure shared by the CLI, job annotations, and report diagnostics. */
export class CiError extends Error implements CiErrorData {
  readonly code: string;
  readonly stage: string;
  readonly nextAction: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(input: Omit<CiErrorData, "retryable"> & { retryable?: boolean; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "CiError";
    this.code = input.code;
    this.stage = input.stage;
    this.nextAction = input.nextAction;
    this.retryable = input.retryable ?? false;
    if (input.details !== undefined) this.details = input.details;
  }
}

export function toCiError(error: unknown, fallback: Partial<Omit<CiErrorData, "details">> = {}): CiError {
  if (error instanceof CiError) return error;
  return new CiError({
    code: fallback.code ?? "EXPLORE_FAILED",
    stage: fallback.stage ?? "execution",
    message: fallback.message ?? (error instanceof Error ? error.message : String(error)),
    nextAction: fallback.nextAction ?? "Inspect the failing operation in the job logs and rerun Explore after correcting it.",
    retryable: fallback.retryable ?? false,
    cause: error,
  });
}

/** Preserve precise subsystem failures, and contextualize otherwise unclassified command errors. */
export function ciErrorForCommand(error: unknown, command: string): CiError {
  const fallback: Record<string, Pick<CiErrorData, "code" | "stage" | "nextAction">> = {
    "source:verify": { code: "PLAN_VERIFICATION_FAILED", stage: "verify", nextAction: "Inspect the planning diagnostic and attached plan files. Correct the navigation configuration or Git revisions; report an analyzer defect if identical inputs produced different plans." },
    "capture:review": { code: "REVIEW_CAPTURE_FAILED", stage: "capture", nextAction: "Inspect the capture diagnostics for the failed revision and operation, correct that prerequisite, and rerun the review." },
    "capture:baseline": { code: "BASELINE_CAPTURE_FAILED", stage: "capture", nextAction: "Inspect the baseline capture diagnostics, correct the failed build or device prerequisite, and rerun the baseline workflow." },
    "ci:report": { code: "REPORT_EXPORT_FAILED", stage: "export", nextAction: "Use report-input.json from the capture job and a new output directory. Rerun capture if its referenced image files are missing or corrupt." },
    "ci:publish": { code: "REPORT_PUBLICATION_FAILED", stage: "publication", nextAction: "Check the GitHub artifact and comment permissions, and publish an artifact from the current workflow attempt and PR head." },
  };
  return toCiError(error, fallback[command]);
}

export type CiErrorRenderOptions = { secrets?: readonly string[] };

/** The values of every variable that names a secret (a token, secret, password or API key), to redact from what Explore writes. */
export function environmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment).filter(([key]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)).flatMap(([, value]) => value ? [value] : []);
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  // Controller failures may embed JSON or URLs inside their message rather than
  // returning the original input as a separate structured field.
  const variants = secrets.filter(Boolean).flatMap(secret => {
    const values = [secret, JSON.stringify(secret).slice(1, -1)];
    try { values.push(encodeURIComponent(secret)); }
    catch { /* Ill-formed Unicode has no encodeURIComponent representation. */ }
    return values;
  });
  // Longest first prevents a shorter token from exposing the suffix of a longer token.
  for (const secret of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:ant-)?[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/([?&](?:access_token|token|api_key|key|signature|sig)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function clean(value: unknown, secrets: readonly string[], seen = new Set<object>()): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((entry) => clean(entry, secrets, seen));
  } else {
    result = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /^(?:authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)
        ? "[REDACTED]" : clean(entry, secrets, seen),
    ]));
  }
  seen.delete(value);
  return result;
}

/** Does not serialize causes or stacks, which may include command arguments and credentials. */
export function serializeCiError(error: unknown, options: CiErrorRenderOptions = {}): CiErrorData {
  const failure = toCiError(error);
  return clean({
    code: failure.code,
    stage: failure.stage,
    message: failure.message,
    nextAction: failure.nextAction,
    retryable: failure.retryable,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  }, options.secrets ?? []) as CiErrorData;
}

function annotationData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function annotationProperty(value: string): string {
  return annotationData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function renderCiErrorAnnotation(error: unknown, options: CiErrorRenderOptions = {}): string {
  const failure = serializeCiError(error, options);
  const title = annotationProperty(`Explore ${failure.code} (${failure.stage})`);
  return `::error title=${title}::${annotationData(`${failure.message}\nNext action: ${failure.nextAction}`)}`;
}

function markdown(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1").replace(/\r?\n/g, " ");
}

export function renderCiErrorSummary(error: unknown, options: CiErrorRenderOptions = {}): string {
  const failure = serializeCiError(error, options);
  return [
    "### Explore failed",
    "",
    `**${markdown(failure.code)}** · ${markdown(failure.stage)}`,
    "",
    markdown(failure.message),
    "",
    `**Next action:** ${markdown(failure.nextAction)}`,
    "",
    `Automatic retry: ${failure.retryable ? "permitted for this temporary failure" : "disabled; correct the cause first"}.`,
    "",
  ].join("\n");
}

/** Emit the same sanitized diagnostic to every CI surface, never logging the raw cause. */
export async function reportCiError(error: unknown, options: {
  env?: NodeJS.ProcessEnv;
  secrets?: readonly string[];
  diagnosticsPath?: string;
  /**
   * The matrix target the failed command ran for, written into the diagnostics file. actions/download-artifact puts an
   * artifact in a directory named after it only when a pattern matches several, so the failure job cannot always read
   * the target from where the file lands.
   */
  target?: string;
  write?: (value: string) => void;
} = {}): Promise<CiErrorData> {
  const env = options.env ?? process.env;
  const secrets = [
    ...Object.entries(env).filter(([key]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key))
      .map(([, value]) => value).filter((value): value is string => Boolean(value)),
    ...options.secrets ?? [],
  ];
  const renderOptions = { secrets };
  const diagnostic = serializeCiError(error, renderOptions);
  const write = options.write ?? ((value: string) => process.stderr.write(`${value}\n`));
  // An annotation in Actions; in a terminal (a local capture:review) the same redacted text, readable.
  write(env.GITHUB_ACTIONS === "true" || env.GITHUB_STEP_SUMMARY ? renderCiErrorAnnotation(error, renderOptions)
    : `Error [${diagnostic.code}]: ${diagnostic.message}\nNext action: ${diagnostic.nextAction}`);
  const outputs: Array<{ label: string; operation: Promise<unknown> }> = [];
  if (env.GITHUB_STEP_SUMMARY) outputs.push({ label: "job summary", operation: appendFile(env.GITHUB_STEP_SUMMARY, `${renderCiErrorSummary(error, renderOptions)}\n`) });
  if (options.diagnosticsPath) outputs.push({ label: "diagnostics file", operation: (async () => {
    await mkdir(dirname(options.diagnosticsPath!), { recursive: true });
    await writeFile(options.diagnosticsPath!, `${JSON.stringify(options.target ? { ...diagnostic, target: options.target } : diagnostic, null, 2)}\n`);
  })() });
  const results = await Promise.allSettled(outputs.map(output => output.operation));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const code = (result.reason as NodeJS.ErrnoException | undefined)?.code;
      const reason = typeof code === "string" ? ` (${redact(code, secrets)})` : "";
      write(`::warning title=Explore diagnostics::${annotationData(`Could not write the ${outputs[index]!.label}${reason}. Check runner output permissions. The original failure above still applies.`)}`);
    }
  }
  return diagnostic;
}
