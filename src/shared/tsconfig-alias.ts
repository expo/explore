import ts from "typescript";

/** The import aliases a tsconfig maps to project directories, such as `@/*` to `src/` and `@/assets/*` to `assets/`. */
export type TsconfigAlias = {
  /** Each alias prefix (`@/`, `@/assets/`) and the directory prefix that replaces it, longest prefix first. */
  prefixes: readonly { prefix: string; target: string }[];
  /** Set when the tsconfig asks for module resolution the static analysis cannot follow. */
  unsupported?: string;
};

const SINGLE_DIRECTORY_TARGET = /^(?:\.\/)?((?:[\w.-]+\/)*)\*$/;
const PREFIX_KEY = /^([^*]+\/)\*$/;
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
  const entries = Object.entries(options.paths ?? {}) as [string, unknown][];
  if (entries.length === 0) return DEFAULT;
  const prefixes: { prefix: string; target: string }[] = [];
  for (const [key, targets] of entries) {
    const prefix = PREFIX_KEY.exec(key)?.[1];
    if (!prefix || !Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== "string") return unsupported;
    const match = SINGLE_DIRECTORY_TARGET.exec(targets[0]);
    if (!match || match[1]!.split("/").includes("..")) return unsupported;
    prefixes.push({ prefix, target: match[1]! });
  }
  // TypeScript picks the pattern with the longest prefix, so `@/assets/x` goes to `assets/`, not `src/assets/`.
  return { prefixes: prefixes.sort((a, b) => b.prefix.length - a.prefix.length) };
}

/** The project path an aliased specifier names, before extensions, or undefined when no alias matches it. */
export function resolveTsconfigAlias(alias: TsconfigAlias, specifier: string): string | undefined {
  const entry = alias.prefixes.find(({ prefix }) => specifier.startsWith(prefix));
  return entry ? `${entry.target}${specifier.slice(entry.prefix.length)}` : undefined;
}
