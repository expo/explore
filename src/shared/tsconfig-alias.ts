import ts from "typescript";

/** The `@/*` import alias a tsconfig maps to one project directory, such as `src/` or the root. */
export type TsconfigAlias = {
  /** Directory prefix that replaces `@/`, with a trailing slash or empty for the project root. */
  target: string;
  /** Set when the tsconfig asks for module resolution the static analysis cannot follow. */
  unsupported?: string;
};

const SINGLE_DIRECTORY_TARGET = /^(?:\.\/)?((?:[\w.-]+\/)*)\*$/;

/**
 * Static analysis follows one alias, `@/*`, pointing at a single directory (`./*`, `src/*`, `./src/*`),
 * which is what create-expo-app and the Expo docs set up. Anything else is reported, not guessed.
 */
export function readTsconfigAlias(configText: string | undefined): TsconfigAlias {
  if (configText === undefined) return { target: "src/" };
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", configText);
  const options = parsed.config?.compilerOptions ?? {};
  const unsupported = { target: "src/", unsupported: "custom module resolution is not statically supported" };
  if (parsed.error) return unsupported;
  if (options.baseUrl && ![".", "./"].includes(options.baseUrl)) return unsupported;
  if (parsed.config?.extends && parsed.config.extends !== "expo/tsconfig.base") return unsupported;
  const entries = Object.entries(options.paths ?? {}) as [string, unknown][];
  if (entries.length === 0) return { target: "src/" };
  if (entries.length > 1 || entries[0]![0] !== "@/*") return unsupported;
  const targets = entries[0]![1];
  if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== "string") return unsupported;
  const match = SINGLE_DIRECTORY_TARGET.exec(targets[0]);
  if (!match || match[1]!.split("/").includes("..")) return unsupported;
  return { target: match[1]! };
}
