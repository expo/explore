import type { SourceChangeSummary } from "../source/change-summary.js";

/** What a reviewer asks first: did this screen change, or did something it depends on? */
export const SOURCE_IMPACT_KINDS = ["own", "imported", "shared"] as const;
export type SourceImpactKind = (typeof SOURCE_IMPACT_KINDS)[number];
const IMPACT_SENTENCE: Record<SourceImpactKind, string> = {
  own: "Its own source changed.",
  imported: "Something it imports changed.",
  shared: "Shared app source changed.",
};

export function sourceImpactSentences(kinds: readonly SourceImpactKind[] | undefined): string | undefined {
  const ordered = SOURCE_IMPACT_KINDS.filter(kind => kinds?.includes(kind));
  return ordered.length ? ordered.map(kind => IMPACT_SENTENCE[kind]).join(" ") : undefined;
}

export function sourceImpactKinds(relations: readonly string[]): SourceImpactKind[] {
  return [
    ...(relations.some(relation => relation === "route" || relation === "declared-source") ? ["own" as const] : []),
    ...(relations.includes("dependency") ? ["imported" as const] : []),
    ...(relations.includes("global") ? ["shared" as const] : []),
  ];
}

const sha = /^[a-f0-9]{40}$/;
const impacts = new Set(["direct", "dependency", "global", "route", "none"]);
const relations = new Set(["route", "declared-source", "dependency", "global"]);
const statuses = new Set(["added", "modified", "removed", "renamed", "copied", "type-changed"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source change evidence");
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error("Invalid source change evidence text");
  }
}

function path(value: unknown): void {
  boundedText(value, 2048);
  if (value.startsWith("/") || value.includes("\\") || /[\r\n\t]/.test(value)
    || value.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid source change evidence path");
  }
}

/** Shared by publication and the browser; source facts must belong to these exact commits. */
export function validateSourceChangeSummary(value: unknown, baseSha: string, headSha: string): SourceChangeSummary {
  const summary = object(value);
  if (summary.contract !== "expo.explore.source-change-summary.v1"
    || !sha.test(baseSha) || !sha.test(headSha) || baseSha === headSha
    || summary.baseSha !== baseSha || summary.headSha !== headSha
    || !impacts.has(String(summary.impact)) || typeof summary.truncated !== "boolean"
    || !Array.isArray(summary.files) || summary.files.length > 256) {
    throw new Error("Source change evidence does not match the reviewed commits");
  }
  boundedText(summary.summary, 8192);
  const seen = new Set<string>();
  for (const candidate of summary.files) {
    const file = object(candidate);
    path(file.path);
    if (seen.has(file.path as string)) throw new Error("Duplicate source change evidence path");
    seen.add(file.path as string);
    if (file.previousPath !== undefined) path(file.previousPath);
    if (file.patch !== undefined) {
      boundedText(file.patch, 256 * 1024, true);
      if (new TextEncoder().encode(file.patch).byteLength > 256 * 1024) throw new Error("Source diff exceeds its byte limit");
    }
    if (file.patchTruncated !== undefined && typeof file.patchTruncated !== "boolean") {
      throw new Error("Invalid source diff truncation state");
    }
    if (!statuses.has(String(file.status)) || !relations.has(String(file.relation))
      || typeof file.truncated !== "boolean"
      || !Array.isArray(file.hunks) || file.hunks.length > 256
      || !Array.isArray(file.facts) || file.facts.length > 256) {
      throw new Error("Invalid source change evidence file");
    }
    for (const key of ["baseBlobSha", "headBlobSha"]) {
      if (file[key] !== undefined && (typeof file[key] !== "string" || !sha.test(file[key] as string))) {
        throw new Error("Invalid source change Git blob identity");
      }
    }
    for (const candidateHunk of file.hunks) {
      const hunk = object(candidateHunk);
      for (const key of ["baseStart", "baseLines", "headStart", "headLines"]) {
        if (!Number.isSafeInteger(hunk[key]) || Number(hunk[key]) < 0) throw new Error("Invalid source diff hunk");
      }
    }
    for (const candidateFact of file.facts) {
      const fact = object(candidateFact);
      boundedText(fact.kind, 100);
      boundedText(fact.summary, 8192);
      for (const key of ["before", "after"]) {
        if (fact[key] !== undefined) boundedText(fact[key], 8192, true);
      }
      for (const key of ["baseLines", "headLines"]) {
        if (fact[key] === undefined) continue;
        const lines = object(fact[key]);
        if (!Number.isSafeInteger(lines.start) || Number(lines.start) < 1
          || !Number.isSafeInteger(lines.end) || Number(lines.end) < Number(lines.start)) {
          throw new Error("Invalid source change line range");
        }
      }
    }
  }
  return summary as unknown as SourceChangeSummary;
}
