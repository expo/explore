type UnknownRecord = Record<string, unknown>;

// A route id may carry a secondary-appearance suffix (`<id>@dark`): that capture is its own review surface.
const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*(@(light|dark))?$/;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const whitespacePattern = /\s/;
const credentialQueryKeys = new Set([
  "auth",
  "authorization",
  "code",
  "cookie",
  "credential",
  "credentials",
  "key",
  "oauthcode",
  "password",
  "passwd",
  "session",
  "sessionid",
]);

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertAllowedKeys(record: UnknownRecord, allowedKeys: readonly string[], name: string): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key)).sort(compareStrings);
  if (unknownKeys.length > 0) {
    throw new Error(`${name} has unsupported fields: ${unknownKeys.join(", ")}`);
  }
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function stableIdentifier(value: unknown, name: string): string {
  const parsed = requiredString(value, name);
  if (!stableIdentifierPattern.test(parsed)) throw new Error(`${name} is invalid: ${parsed}`);
  return parsed;
}

export function safeRepoPath(value: string, name: string): string {
  if (
    value.startsWith("/")
    || value.includes("\\")
    || controlCharacterPattern.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${name} must be a safe repository-relative POSIX path`);
  }
  return value;
}

function decodeQueryKey(value: string, name: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw new Error(`${name} has invalid percent encoding`);
  }
}

export function isCredentialQueryKey(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return credentialQueryKeys.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("apikey");
}

export function appRoute(value: string, name: string): string {
  if (
    value !== value.trim()
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
    || value.includes("#")
    || controlCharacterPattern.test(value)
    || whitespacePattern.test(value)
  ) {
    throw new Error(`${name} must be an absolute app route`);
  }
  const querySeparator = value.indexOf("?");
  const pathname = querySeparator === -1 ? value : value.slice(0, querySeparator);
  const query = querySeparator === -1 ? null : value.slice(querySeparator + 1);
  if (query === "" || (query !== null && query.includes("?"))) {
    throw new Error(`${name} has an invalid query string`);
  }
  if (
    pathname !== "/"
    && pathname.slice(1).split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${name} must not contain empty or relative path segments`);
  }
  if (query !== null) {
    const seenKeys = new Set<string>();
    for (const [index, field] of query.split("&").entries()) {
      if (!field) throw new Error(`${name} has an empty query field`);
      const equalsIndex = field.indexOf("=");
      const encodedKey = equalsIndex === -1 ? field : field.slice(0, equalsIndex);
      const encodedValue = equalsIndex === -1 ? null : field.slice(equalsIndex + 1);
      if (!encodedKey || encodedValue === "") {
        throw new Error(`${name} query field ${index} must have a key and a non-empty value`);
      }
      const key = decodeQueryKey(encodedKey, `${name} query field ${index}`);
      if (!key || whitespacePattern.test(key)) throw new Error(`${name} has an invalid query key`);
      if (isCredentialQueryKey(key)) {
        throw new Error(`${name} must not contain credential-like query key ${key}`);
      }
      if (seenKeys.has(key)) throw new Error(`${name} contains duplicate query key ${key}`);
      seenKeys.add(key);
    }
  }
  return value;
}

