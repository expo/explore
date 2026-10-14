import { readFileSync } from "node:fs";
import { canonicalPlan, createSourceCapturePlan } from "./capture-plan.js";
import { serializeCiError, toCiError } from "../shared/ci-errors.js";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const plan = createSourceCapturePlan({ ...input, baseFiles: new Map(input.baseFiles), headFiles: new Map(input.headFiles) });
  process.stdout.write(JSON.stringify({ plan, canonical: canonicalPlan(plan) }));
} catch (error) {
  const diagnostic = serializeCiError(toCiError(error, {
    code: "SOURCE_ANALYSIS_FAILED", stage: "plan",
    nextAction: "Check the navigation provider and entry in config.yaml, and inspect the source analysis diagnostic.",
  }));
  process.stderr.write(JSON.stringify(diagnostic));
  process.exitCode = 1;
}
