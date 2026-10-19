import { posix } from "node:path";
import ts from "typescript";

/** The import aliases a tsconfig maps to project directories, such as `@/*` to `src/` and `@/assets/*` to `assets/`. */
export type TsconfigAlias = {
  /** Each alias prefix (`@/`, `@/assets/`) and the directory prefix that replaces it, longest prefix first. */
  prefixes: readonly { prefix: string; target: string }[];
  /** `baseUrl` is the project root: a bare specifier no alias matches is looked up there before it is taken for a package. */
  baseUrl?: true;
  /** Set when the tsconfig asks for module resolution the static analysis cannot follow. */
  unsupported?: string;
};

const SINGLE_DIRECTORY_TARGET = /^(?:\.\/)?((?:[\w.-]+\/)*)\*$/;
// A relative-looking key (`./*`, `/*`) is never applied: TypeScript and Metro resolve relative specifiers directly.
const PREFIX_KEY = /^([^*./][^*]*\/)\*$/;
const DEFAULT: TsconfigAlias = { prefixes: [{ prefix: "@/", target: "src/" }] };

/**
 * Static analysis follows `paths` entries of the form `prefix/*` that each point at a single directory (`./*`, `src/*`,
 * `./assets/*`), which covers create-expo-app's `@/*` and the extra entries apps add beside it. Anything else is
 * reported, not guessed.
 */
export function readTsconfigAlias(configText: string | undefined): TsconfigAlias {
  if (configText === undefined) return DEFAULT;
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", configText);
  const options = parsed.config?.compilerOptions ?? {};
  const unsupported = { ...DEFAULT, unsupported: "custom module resolution is not statically supported" };
  if (parsed.error) return unsupported;
  if (options.baseUrl && ![".", "./"].includes(options.baseUrl)) return unsupported;
  if (parsed.config?.extends && parsed.config.extends !== "expo/tsconfig.base") return unsupported;
  const baseUrl = options.baseUrl ? { baseUrl: true as const } : {};
  const entries = Object.entries(options.paths ?? {}) as [string, unknown][];
  if (entries.length === 0) return { ...DEFAULT, ...baseUrl };
  const prefixes: { prefix: string; target: string }[] = [];
  for (const [key, targets] of entries) {
    const prefix = PREFIX_KEY.exec(key)?.[1];
    if (!prefix || !Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== "string") return unsupported;
    const match = SINGLE_DIRECTORY_TARGET.exec(targets[0]);
    if (!match || match[1]!.split("/").some(segment => segment === "." || segment === "..")) return unsupported;
    prefixes.push({ prefix, target: match[1]! });
  }
  // TypeScript picks the pattern with the longest prefix, so `@/assets/x` goes to `assets/`, not `src/assets/`.
  return { prefixes: prefixes.sort((a, b) => b.prefix.length - a.prefix.length), ...baseUrl };
}

/** The project path an aliased specifier names, before extensions, or undefined when no alias matches it. */
export function resolveTsconfigAlias(alias: TsconfigAlias, specifier: string): string | undefined {
  const entry = alias.prefixes.find(({ prefix }) => specifier.startsWith(prefix));
  // Normalized as Metro joins it: `@app/a/../b` is `src/b`, and a trailing slash still finds `index`.
  return entry ? posix.normalize(`${entry.target}${specifier.slice(entry.prefix.length)}`).replace(/\/$/, "") : undefined;
}

/** The project path a bare specifier names under a root `baseUrl`, or undefined; a miss there is a package, not a gap. */
export function resolveTsconfigBaseUrl(alias: TsconfigAlias, specifier: string): string | undefined {
  return alias.baseUrl && !/^[./]/.test(specifier) ? specifier : undefined;
}
