export type UnattributedSetting = "publish" | "discard";

export const UNATTRIBUTED_SETTINGS: readonly UnattributedSetting[] = ["publish", "discard"];

export function parseUnattributedSetting(value: unknown, path: string): UnattributedSetting {
  if (value === undefined) return "publish";
  if (typeof value === "string" && (UNATTRIBUTED_SETTINGS as readonly string[]).includes(value)) return value as UnattributedSetting;
  throw new Error(`${path} must be "publish" or "discard".`);
}
