import { createHash } from "node:crypto";
import type { SourceRoute } from "../../contracts/source-route.js";

export function sourceRouteId(provider: SourceRoute["provider"], identity: string): string {
  const slug = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "index";
  return `${provider === "expo-router" ? "expo" : "rn"}-${slug}-${createHash("sha256").update(`${provider}:${identity}`).digest("hex").slice(0, 12)}`;
}
