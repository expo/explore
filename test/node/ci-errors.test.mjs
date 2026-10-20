import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { CiError, toCiError, ciErrorForCommand, serializeCiError, renderCiErrorAnnotation, renderCiErrorSummary, reportCiError } =
  await tsImport("../../src/shared/ci-errors.ts", import.meta.url);
const { executeCaptureSetup } = await tsImport("../../src/capture/setup-actions.ts", import.meta.url);
const { createExplorationInputs } = await tsImport("../../src/config/exploration-inputs.ts", import.meta.url);

test("structured failures preserve action and retry intent across normalization", () => {
  const error = new CiError({ code: "CAPTURE_TIMEOUT", stage: "capture", message: "Profile did not become ready.", nextAction: "Inspect the Profile entry route.", retryable: true, details: { routeId: "Profile" } });
  assert.equal(toCiError(error), error);
  assert.deepEqual(serializeCiError(error), {
    code: "CAPTURE_TIMEOUT", stage: "capture", message: "Profile did not become ready.", nextAction: "Inspect the Profile entry route.", retryable: true, details: { routeId: "Profile" },
  });
  const unknown = toCiError(new Error("build rejected"), { code: "APP_BUILD_FAILED", stage: "build", nextAction: "Fix the app build." });
  assert.equal(unknown.code, "APP_BUILD_FAILED");
  assert.equal(unknown.message, "build rejected");
  assert.equal(unknown.retryable, false);
});

test("CI boundary fallbacks distinguish planning, capture, export, and publication without replacing precise errors", () => {
  for (const [command, code, stage] of [
    ["source:verify", "PLAN_VERIFICATION_FAILED", "verify"],
    ["capture:review", "REVIEW_CAPTURE_FAILED", "capture"],
    ["capture:baseline", "BASELINE_CAPTURE_FAILED", "capture"],
    ["ci:report", "REPORT_EXPORT_FAILED", "export"],
    ["ci:publish", "REPORT_PUBLICATION_FAILED", "publication"],
  ]) {
    const failure = ciErrorForCommand(new Error("Operation failed"), command);
    assert.equal(failure.code, code);
    assert.equal(failure.stage, stage);
    assert.ok(failure.nextAction.length > 20);
  }
  const precise = new CiError({ code: "AGENT_API_KEY_MISSING", stage: "preflight", message: "Key missing", nextAction: "Add the key." });
  assert.equal(ciErrorForCommand(precise, "capture:review"), precise);
});

test("GitHub annotations escape injected properties, workflow commands, percent, and line breaks", () => {
  const error = new CiError({ code: "BAD,FILE:x", stage: "check", message: "bad 100%\r\n::warning::injected", nextAction: "Correct config." });
  const annotation = renderCiErrorAnnotation(error);
  assert.match(annotation, /BAD%2CFILE%3Ax/);
  assert.match(annotation, /100%25%0D%0A::warning::injected/);
  assert.equal(annotation.includes("\n"), false);
});

test("diagnostics redact explicit secrets, credential fields, bearer tokens, signed URLs, and causes", () => {
  const error = new CiError({
    code: "SERVICE_FAILED", stage: "download",
    message: "custom-secret Bearer bearer-secret https://user:password@host/path?token=signed-value&sig=signature sk-test_abcdefghijklmnop",
    nextAction: "Replace custom-secret.",
    details: { authorization: "header", password: "password", nested: { apiKey: "value", url: "https://blob/path?signature=secret" }, secretName: "GITHUB_TOKEN" },
    cause: new Error("private-stack-and-cause"),
  });
  const rendered = JSON.stringify(serializeCiError(error, { secrets: ["custom-secret"] }));
  for (const value of ["custom-secret", "bearer-secret", "user:password", "signed-value", "=signature", "sk-test_abcdefghijklmnop", "private-stack-and-cause"]) {
    assert.equal(rendered.includes(value), false, value);
  }
  assert.match(rendered, /GITHUB_TOKEN/);
  assert.match(rendered, /\[REDACTED\]/);
  assert.equal("stack" in serializeCiError(error), false);
});

test("diagnostics redact raw, JSON-escaped, and URL-encoded secret values throughout structured errors", () => {
  const secret = 'review"P\\ass/word+9';
  const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  const error = new CiError({ code: "SETUP_FAILED", stage: "setup",
    message: variants.join(" | "), nextAction: `Replace input ${variants[1]}.`,
    details: { nested: { output: variants, response: JSON.stringify({ input: secret }) } } });
  const diagnostic = serializeCiError(error, { secrets: [secret] });
  assert.equal(diagnostic.message, "[REDACTED] | [REDACTED] | [REDACTED]");
  assert.equal(diagnostic.nextAction, "Replace input [REDACTED].");
  assert.deepEqual(diagnostic.details.nested.output, ["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
  assert.equal(diagnostic.details.nested.response, '{"input":"[REDACTED]"}');
  // A malformed explicit secret must not replace the original failure with URIError.
  assert.doesNotThrow(() => serializeCiError(error, { secrets: ["\ud800"] }));
});

test("a resolved fill failure cannot publish encoded application credentials to CI diagnostics", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-fill-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const password = 'agent"P\\ass/phrase+9';
  const environment = { APP_REVIEW_PASSWORD: password, GITHUB_STEP_SUMMARY: join(root, "summary.md") };
  const inputs = createExplorationInputs({ instructions: "Fill {{secret:APP_REVIEW_PASSWORD}}.", environment });
  let fillFailure;
  try {
    await executeCaptureSetup([{ action: "fill", identifier: "auth-password", text: inputs.resolve("{{secret:APP_REVIEW_PASSWORD}}") }], {
      snapshot: () => ({ refsGeneration: 1, nodes: [{ identifier: "auth-password", type: "SecureTextField", ref: "e1" }] }),
      open: () => { throw new Error("Unexpected navigation"); },
      command: args => {
        assert.equal(args[0], "fill");
        assert.equal(args[2], password);
        // Mirrors controller JSON output included in the runner's failure message.
        throw new Error(`Controller fill failed: ${JSON.stringify({ input: args[2] })}; encoded input ${encodeURIComponent(args[2])}`);
      },
    });
  } catch (error) { fillFailure = error; }
  assert.ok(fillFailure);
  const perTarget = serializeCiError(toCiError(fillFailure, { code: "SETUP_FAILED", stage: "setup" }), { secrets: inputs.values });
  assert.equal(perTarget.message, 'Controller fill failed: {"input":"[REDACTED]"}; encoded input [REDACTED]');
  const output = [];
  const diagnosticsPath = join(root, "error.json");
  const diagnostic = await reportCiError(ciErrorForCommand(fillFailure, "capture:review"), {
    env: environment, diagnosticsPath, write: line => output.push(line),
  });
  assert.equal(diagnostic.message, perTarget.message);
  assert.deepEqual(JSON.parse(await readFile(diagnosticsPath, "utf8")), diagnostic);
  const summary = await readFile(environment.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, /REDACTED/);
  assert.match(output[0], /REDACTED/);
  for (const text of [diagnostic.message, summary, output[0]]) {
    for (const value of [password, JSON.stringify(password).slice(1, -1), encodeURIComponent(password)]) assert.equal(text.includes(value), false);
  }
});

test("summary escapes untrusted Markdown and includes the next action", () => {
  const error = new CiError({ code: "CONFIG_INVALID", stage: "preflight", message: "[download](https://bad) <script>", nextAction: "Correct the device.name field." });
  const summary = renderCiErrorSummary(error);
  assert.match(summary, /\\\[download\\\]/);
  assert.match(summary, /&lt;script&gt;/);
  assert.match(summary, /Next action/);
  assert.match(summary, /correct the cause first/);
});

test("CI reporting emits consistent sanitized annotations, summary, and JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const summaryPath = join(root, "summary.md");
  const diagnosticPath = join(root, "diagnostics/error.json");
  const output = [];
  const diagnostic = await reportCiError(new CiError({ code: "EXPO_AUTH_FAILED", stage: "preflight", message: "EXPO_TOKEN value sensitive-value was rejected.", nextAction: "Replace EXPO_TOKEN in GitHub Secrets." }), {
    env: { EXPO_TOKEN: "sensitive-value", GITHUB_STEP_SUMMARY: summaryPath },
    diagnosticsPath: diagnosticPath,
    write: (line) => output.push(line),
  });
  assert.equal(output.length, 1);
  const summary = await readFile(summaryPath, "utf8");
  const saved = await readFile(diagnosticPath, "utf8");
  for (const value of [summary, saved, output[0]]) {
    assert.equal(value.includes("sensitive-value"), false);
    assert.match(value, /Next action|nextAction/);
  }
  assert.deepEqual(JSON.parse(saved), diagnostic);
});

test("CI argument failures preserve JSON output, annotation, summary, and diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-cli-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL("../../src/cli.ts", import.meta.url);
  const summary = join(root, "summary.md");
  for (const [args, action] of [
    [["ci:report", "--obsolete"], /Remove --obsolete/],
    [["ci:report", "--input"], /Provide a value after --input/],
    [["ci:report"], /Add --input/],
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli.pathname, ...args, "--json"], {
      encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root },
    });
    assert.equal(result.status, 1, result.stderr);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.contract, "explore.result");
    assert.equal(failure.ok, false);
    assert.equal(failure.diagnostic.code, "CLI_ARGUMENT_INVALID");
    assert.equal(failure.diagnostic.stage, "preflight");
    assert.match(failure.diagnostic.nextAction, action);
    assert.match(result.stdout, /^::error title=Explore CLI_ARGUMENT_INVALID/);
    assert.deepEqual(JSON.parse(await readFile(join(root, "explore-diagnostics/error.json"), "utf8")), failure.diagnostic);
  }
  assert.match(await readFile(summary, "utf8"), /Next action/);
});

test("a failed command's diagnostics file names the matrix target it ran for, so the failure comment can", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-cli-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = new URL("../../src/cli.ts", import.meta.url);
  const run = target => {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli.pathname, "ci:report", "--input", join(root, "missing.json"), "--output", join(root, "out"), "--target", target],
      { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_TEMP: root } });
    assert.equal(result.status, 1, result.stderr);
    return readFile(join(root, "explore-diagnostics/error.json"), "utf8").then(JSON.parse);
  };
  const written = await run("duo-closed");
  assert.equal(written.target, "duo-closed");
  assert.equal(written.code, "REPORT_INPUT_INVALID");
  assert.equal((await run("../ios")).target, undefined, "only a valid target id is written");
});

test("source worker failures emit a structured diagnostic without a raw stack", () => {
  const worker = new URL("../../src/source/plan-worker.ts", import.meta.url);
  const result = spawnSync(process.execPath, ["--import", "tsx", worker.pathname], { input: "{", encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const diagnostic = JSON.parse(result.stderr);
  assert.equal(diagnostic.code, "SOURCE_ANALYSIS_FAILED");
  assert.equal(diagnostic.stage, "plan");
  assert.equal(diagnostic.retryable, false);
  assert.match(diagnostic.nextAction, /navigation provider/);
  assert.equal("stack" in diagnostic, false);
});

test("a failed diagnostic write never masks the original error or blocks other outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-errors-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = [];
  const failure = new CiError({ code: "APP_BUILD_FAILED", stage: "build", message: "The app did not build.", nextAction: "Fix the build." });
  const result = await reportCiError(failure, {
    env: { GITHUB_STEP_SUMMARY: root }, diagnosticsPath: join(root, "error.json"), write: line => output.push(line),
  });
  assert.equal(result.code, "APP_BUILD_FAILED");
  assert.equal(JSON.parse(await readFile(join(root, "error.json"), "utf8")).code, "APP_BUILD_FAILED");
  assert.match(output[0], /APP_BUILD_FAILED/);
  assert.match(output[1], /Could not write the job summary/);
});
