import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isSystemUiNode } from "../capture/controller-output.js";
import { keyboardNodes } from "../capture/keyboard.js";
import { validateNavigationGraph } from "../contracts/navigation-graph.js";
import {
  CONTRACT,
  type ActionAttempt,
  type ActionKind,
  type Artifact,
  type Coverage,
  type CoverageGap,
  type ExploreMap,
  type FrontierItem,
  type InputElement,
  type Observation,
  type ObservationFingerprints,
  type ObservedElement,
  type Screen,
  type ScreenElement,
  type ScreenVariant,
  type SurfaceScope,
  type Transition,
} from "../types.js";

export class ExploreError extends Error {}

export type PreparedArtifact = {
  artifact: Artifact;
  bytes: Uint8Array;
  destination: string;
};

export const now = (): string => new Date().toISOString();

export const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "item";

export const shortHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 12);

const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

export const normalizeSelector = (input?: string): string | undefined => {
  if (input === undefined) return undefined;
  if (/@e\d+/i.test(input)) {
    throw new ExploreError(
      `Temporary controller refs cannot be stored as selectors: ${input}`,
    );
  }
  return input.replace(/\s+/g, " ").trim() || undefined;
};

/** A ref names a node within one read; which field has the focus can change between two reads of one screen. */
const VOLATILE_SNAPSHOT_NODE_KEYS = new Set(["ref", "focused"]);

/**
 * The accessibility fingerprint's algorithm, written as its prefix. Version 2 leaves the system keyboard and the focus out
 * of the tree; a hash from before carries no prefix. Two fingerprints of different versions say nothing about whether the
 * trees differ, so a comparison treats them as not comparable rather than changed (see accessibilityFingerprintsComparable).
 */
const ACCESSIBILITY_FINGERPRINT_VERSION = "a2";

export function accessibilityFingerprintsComparable(left: string, right: string): boolean {
  const version = (hash: string) => /^(a\d+):/.exec(hash)?.[1] ?? "a1";
  return version(left) === version(right);
}

/** Canonical JSON of the node tree only: controller wrappers carry per-session diagnostics and
 * ref generations that would otherwise make identical screens fingerprint differently, and Android
 * system UI nodes (status bar clock and signal, keyboard) change between emulator sessions. The
 * system keyboard on either platform is left out as the elements leave it out, so a keyboard up on
 * one side only does not make two captures of one screen differ. */
function normalizeJsonSnapshotNodes(input: string): string | undefined {
  if (!/^\s*\{/.test(input)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return undefined;
  }
  const data = value && typeof value === "object" && "data" in value
    ? (value as { data?: unknown }).data
    : value;
  if (!data || typeof data !== "object" || !Array.isArray((data as { nodes?: unknown }).nodes)) {
    return undefined;
  }
  const nodes = (data as { nodes: unknown[] }).nodes;
  const keyboard: Set<unknown> = keyboardNodes(nodes.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)));
  const canonical = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node
        .filter((entry) => !(entry && typeof entry === "object" && (isSystemUiNode(entry as Record<string, unknown>) || keyboard.has(entry))))
        .map(canonical);
    }
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_SNAPSHOT_NODE_KEYS.has(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  };
  return `nodes\0${JSON.stringify(canonical(nodes))}`;
}

export const normalizeSnapshot = (input: string): string =>
  normalizeJsonSnapshotNodes(input) ?? input
    .replace(/@e\d+/g, "@e")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "TIME")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "UUID")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:items?|results?|notifications?)\b/gi, "COUNT")
    .replace(/\s+/g, " ")
    .trim();

export async function fingerprintState(options: {
  explicit?: string;
  screenshotPath?: string;
  snapshotText?: string;
}): Promise<ObservationFingerprints> {
  const accessibility = options.snapshotText
    ? `${ACCESSIBILITY_FINGERPRINT_VERSION}:${sha256(`snapshot\0${normalizeSnapshot(options.snapshotText)}`)}`
    : undefined;
  const screenshot = options.screenshotPath ? await readFile(options.screenshotPath) : undefined;
  const visual = screenshot ? sha256(Buffer.concat([Buffer.from("visual\0"), screenshot])) : undefined;
  if (!options.explicit && !accessibility && !visual) {
    throw new ExploreError("A screenshot, snapshot, or explicit fingerprint is required");
  }
  const combined = options.explicit
    ? sha256(`explicit\0${options.explicit}`)
    : sha256(`combined\0${accessibility ?? ""}\0${visual ?? ""}`);
  return {
    combined,
    ...(accessibility ? { accessibility } : {}),
    ...(visual ? { visual } : {}),
  };
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const schemaPath = fileURLToPath(new URL("../../schema/screen-map.v1.schema.json", import.meta.url));
let schemaValidator: ValidateFunction | undefined;

async function getSchemaValidator(): Promise<ValidateFunction> {
  if (schemaValidator) return schemaValidator;
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => Number.isFinite(Date.parse(value)),
  });
  schemaValidator = ajv.compile(schema);
  return schemaValidator!;
}

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
};

function lockProcessId(contents: string): number | undefined {
  try {
    const parsed = JSON.parse(contents) as { pid?: unknown };
    const pid = Number(parsed.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    const pid = Number(contents.trim().split(/\s+/, 1)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class ExploreStore {
  readonly root: string;
  readonly mapPath: string;
  readonly artifactsDir: string;
  readonly lockPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.mapPath = join(this.root, "screen-map.json");
    this.artifactsDir = join(this.root, "artifacts");
    this.lockPath = join(this.root, ".write.lock");
  }

  async exists(): Promise<boolean> {
    return pathExists(this.mapPath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const deadline = Date.now() + 5_000;
    const lockToken = randomUUID();
    const lockContents = `${JSON.stringify({ pid: process.pid, token: lockToken, createdAt: now() })}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        const candidate = await open(this.lockPath, "wx");
        try {
          await candidate.writeFile(lockContents);
          await candidate.sync();
          handle = candidate;
        } catch (error) {
          await candidate.close();
          await rm(this.lockPath, { force: true });
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const observedContents = await readFile(this.lockPath, "utf8");
          const lock = await stat(this.lockPath);
          const ownerPid = lockProcessId(observedContents);
          const abandoned = ownerPid ? !processIsAlive(ownerPid) : Date.now() - lock.mtimeMs > 30_000;
          if (abandoned && (await readFile(this.lockPath, "utf8")) === observedContents) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw new ExploreError(`Timed out waiting for exploration lock: ${this.lockPath}`);
        }
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      try {
        if ((await readFile(this.lockPath, "utf8")) === lockContents) {
          await rm(this.lockPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async readRaw(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.mapPath, "utf8")) as unknown;
    } catch (error) {
      throw new ExploreError(`Could not read ${this.mapPath}: ${String(error)}`);
    }
  }

  async initialize(map: ExploreMap, force: boolean): Promise<void> {
    const existed = await this.exists();
    if (existed && !force) {
      throw new ExploreError(`Map already exists at ${this.mapPath}; pass --force to replace it`);
    }
    if (force) {
      if (!existed) {
        const managedDirectories = [this.artifactsDir, join(this.root, "inbox")];
        const occupiedManagedDirectories: string[] = [];
        for (const path of managedDirectories) {
          if (await pathExists(path)) occupiedManagedDirectories.push(path);
        }
        if (occupiedManagedDirectories.length > 0) {
          throw new ExploreError(
            `Refusing --force because ${this.mapPath} is not an existing Explore map; preserved: ${occupiedManagedDirectories.join(", ")}`,
          );
        }
      } else {
        const existingMap = await this.readRaw();
        const validate = await getSchemaValidator();
        if (validate(existingMap) !== true) {
          throw new ExploreError(
            `Refusing --force because ${this.mapPath} is not a valid ${CONTRACT} map: ${schemaErrors(validate.errors).join("; ")}`,
          );
        }
      }
      await rm(this.artifactsDir, { recursive: true, force: true });
      await rm(join(this.root, "inbox"), { recursive: true, force: true });
      await rm(this.mapPath, { force: true });
    }
    await mkdir(join(this.artifactsDir, "screenshots"), { recursive: true });
    await mkdir(join(this.artifactsDir, "accessibility"), { recursive: true });
    await mkdir(join(this.root, "inbox"), { recursive: true });
    await this.write(map);
  }

  async read(options: { validateSchema?: boolean } = {}): Promise<ExploreMap> {
    if (!(await this.exists())) {
      throw new ExploreError(`No map found at ${this.mapPath}; pass --dir with a directory that contains screen-map.json`);
    }
    const value = await this.readRaw();
    if (!value || typeof value !== "object" || (value as { contract?: unknown }).contract !== CONTRACT) {
      throw new ExploreError(`Unsupported or missing map contract in ${this.mapPath}`);
    }
    if (options.validateSchema !== false) {
      const validate = await getSchemaValidator();
      if (!validate(value)) {
        throw new ExploreError(`Invalid map schema: ${schemaErrors(validate.errors).join("; ")}`);
      }
    }
    return value as ExploreMap;
  }

  async write(map: ExploreMap, preparedArtifacts: PreparedArtifact[] = []): Promise<void> {
    const expectedRevision = map.revision;
    await this.withLock(async () => {
      if (await this.exists()) {
        const current = await this.readRaw();
        const currentRevision =
          current && typeof current === "object"
            ? Number((current as { revision?: unknown }).revision)
            : Number.NaN;
        if (currentRevision !== expectedRevision) {
          throw new ExploreError(
            `Map changed concurrently (expected revision ${expectedRevision}, found ${currentRevision}); retry the command`,
          );
        }
      } else if (expectedRevision !== 0) {
        throw new ExploreError("Map disappeared before it could be updated");
      }
      map.revision = expectedRevision + 1;
      map.run.updatedAt = now();
      const validate = await getSchemaValidator();
      if (validate(map as unknown) !== true) {
        map.revision = expectedRevision;
        throw new ExploreError(`Refusing to write invalid map: ${schemaErrors(validate.errors).join("; ")}`);
      }
      const semanticErrors = await validateMap(map, this, { checkArtifacts: false });
      if (semanticErrors.length > 0) {
        map.revision = expectedRevision;
        throw new ExploreError(`Refusing to write invalid map: ${semanticErrors.join("; ")}`);
      }
      const temporaryPath = `${this.mapPath}.${process.pid}.${randomUUID()}.tmp`;
      const stagedArtifacts: Array<{ temporary: string; destination: string }> = [];
      const committedArtifacts: string[] = [];
      try {
        for (const prepared of preparedArtifacts) {
          const destination = resolve(prepared.destination);
          const expectedPath = resolve(this.root, prepared.artifact.path);
          if (destination !== expectedPath) {
            throw new ExploreError(`Prepared artifact path mismatch: ${prepared.artifact.id}`);
          }
          const artifactRelative = relative(this.artifactsDir, destination);
          if (
            !artifactRelative ||
            artifactRelative === ".." ||
            artifactRelative.startsWith(`..${sep}`) ||
            isAbsolute(artifactRelative)
          ) {
            throw new ExploreError(`Prepared artifact is outside the artifact directory: ${destination}`);
          }
          if (await pathExists(destination)) {
            throw new ExploreError(`Artifact destination already exists: ${destination}`);
          }
          await mkdir(dirname(destination), { recursive: true });
          const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
          await writeFile(temporary, prepared.bytes);
          stagedArtifacts.push({ temporary, destination });
        }
        await writeFile(temporaryPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
        for (const artifact of stagedArtifacts) {
          await rename(artifact.temporary, artifact.destination);
          committedArtifacts.push(artifact.destination);
        }
        await rename(temporaryPath, this.mapPath);
      } catch (error) {
        map.revision = expectedRevision;
        await rm(temporaryPath, { force: true });
        await Promise.all(
          stagedArtifacts.map((artifact) => rm(artifact.temporary, { force: true })),
        );
        await Promise.all(
          committedArtifacts.map((artifact) => rm(artifact, { force: true })),
        );
        throw error;
      }
    });
  }

  async prepareArtifact(
    sourcePath: string | undefined,
    kind: Artifact["kind"],
    observationId: string,
  ): Promise<PreparedArtifact | undefined> {
    if (!sourcePath) return undefined;
    const source = resolve(sourcePath);
    if (!(await pathExists(source))) throw new ExploreError(`Artifact not found: ${source}`);
    const bytes = await readFile(source);
    const extension = extname(source) || (kind === "screenshot" ? ".png" : ".txt");
    const category = kind === "screenshot" ? "screenshots" : "accessibility";
    const destination = join(this.artifactsDir, category, `${observationId}${extension}`);
    const dimensions =
      kind === "screenshot" &&
      bytes.length >= 24 &&
      bytes.subarray(1, 4).toString("ascii") === "PNG"
        ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
        : {};
    const mimeType =
      extension.toLowerCase() === ".png"
        ? "image/png"
        : extension.toLowerCase() === ".jpg" || extension.toLowerCase() === ".jpeg"
          ? "image/jpeg"
          : extension.toLowerCase() === ".json"
            ? "application/json"
            : "text/plain";
    return {
      artifact: {
        id: newId("artifact"),
        kind,
        path: relative(this.root, destination),
        sha256: sha256(bytes),
        bytes: bytes.length,
        mimeType,
        ...dimensions,
        createdAt: now(),
      },
      bytes,
      destination,
    };
  }

  async exportTo(outputPath: string, map: ExploreMap): Promise<void> {
    const output = resolve(outputPath);
    const withinRoot = relative(this.root, output);
    if (!withinRoot || (!withinRoot.startsWith(`..${sep}`) && withinRoot !== ".." && !isAbsolute(withinRoot))) {
      throw new ExploreError("Export destination must be outside the active exploration directory");
    }
    if (await pathExists(output)) {
      throw new ExploreError(`Export destination already exists: ${output}`);
    }
    await mkdir(output, { recursive: true });
    await copyFile(this.mapPath, join(output, "screen-map.json"));
    await copyFile(schemaPath, join(output, "screen-map.schema.json"));
    for (const artifact of map.artifacts) {
      const source = resolve(this.root, artifact.path);
      const sourceRelative = relative(this.artifactsDir, source);
      if (
        !sourceRelative ||
        sourceRelative === ".." ||
        sourceRelative.startsWith(`..${sep}`) ||
        isAbsolute(sourceRelative)
      ) {
        throw new ExploreError(`Artifact is outside the exploration directory: ${artifact.id}`);
      }
      const destination = resolve(output, artifact.path);
      const destinationRelative = relative(join(output, "artifacts"), destination);
      if (
        !destinationRelative ||
        destinationRelative === ".." ||
        destinationRelative.startsWith(`..${sep}`) ||
        isAbsolute(destinationRelative)
      ) {
        throw new ExploreError(`Artifact export path is invalid: ${artifact.id}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    await writeFile(
      join(output, "manifest.json"),
      `${JSON.stringify(
        {
          contract: map.contract,
          runId: map.run.id,
          revision: map.revision,
          exportedAt: now(),
          files: map.artifacts.map((artifact) => ({
            path: artifact.path,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
            mimeType: artifact.mimeType,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

export function defaultActionsForElement(element: InputElement): ActionKind[] {
  if (element.actions?.length) return element.actions;
  const role = element.role ?? element.kind ?? "other";
  if (role === "field") return ["fill"];
  if (["button", "link", "tab", "toggle", "menu-item"].includes(role)) return ["press"];
  return [];
}

function elementPriority(element: ScreenElement): number {
  if (element.role === "tab") return 10;
  if (element.role === "menu-item" || element.role === "link") return 20;
  if (element.role === "button") return 30;
  if (element.role === "toggle") return 50;
  if (element.role === "field") return 60;
  return 80;
}

export function mergeElements(options: {
  map: ExploreMap;
  screenId: string;
  observationId: string;
  inputs: InputElement[];
}): string[] {
  const { map, screenId, observationId } = options;
  const elementIds: string[] = [];
  const seenOccurrences = new Map<string, number>();
  for (const [index, input] of options.inputs.entries()) {
    const role = input.role ?? input.kind ?? "other";
    const label = input.label?.trim() || `${role} ${index + 1}`;
    const selector = normalizeSelector(input.selector);
    const occurrenceKey = `${role}\0${label.toLowerCase()}\0${selector ?? ""}`;
    const occurrence = input.occurrence ?? seenOccurrences.get(occurrenceKey) ?? 0;
    seenOccurrences.set(occurrenceKey, occurrence + 1);
    const actions = defaultActionsForElement(input);
    const actionable =
      input.actionable ?? (input.enabled !== false && input.visible !== false && actions.length > 0);
    let requestedId = input.id
      ? `element-${screenId}-${slug(input.id)}`
      : input.identifier
        ? `element-${screenId}-${slug(input.identifier)}`
        : undefined;
    // Android resource ids (and repeated testIDs) recur within one screen; each repeat is its own element.
    if (requestedId) {
      const baseRequestedId = requestedId;
      for (let repeat = 2; elementIds.includes(requestedId); repeat++) requestedId = `${baseRequestedId}-${repeat}`;
    }
    const signature = `${screenId}\0${role}\0${label.toLowerCase()}\0${selector ?? ""}\0${occurrence}`;
    const existing = requestedId
      ? map.elements.find((element) => element.id === requestedId)
      : map.elements.find(
          (element) =>
            element.screenId === screenId &&
            element.role === role &&
            element.label.toLowerCase() === label.toLowerCase() &&
            normalizeSelector(element.selector) === selector &&
            element.occurrence === occurrence,
        );
    if (existing) {
      existing.lastSeenObservationId = observationId;
      if (!existing.observationIds.includes(observationId)) existing.observationIds.push(observationId);
      if (input.identifier !== undefined) existing.identifier = input.identifier;
      if (input.value !== undefined) existing.value = input.value;
      if (input.enabled !== undefined) existing.enabled = input.enabled;
      if (input.visible !== undefined) existing.visible = input.visible;
      if (input.bounds !== undefined) existing.bounds = input.bounds;
      existing.actions = actions;
      existing.risk = input.risk ?? existing.risk;
      existing.actionable = actionable;
      elementIds.push(existing.id);
      continue;
    }
    let id =
      requestedId ??
      `element-${screenId}-${slug(label)}-${shortHash(signature).slice(0, 6)}`;
    let suffix = 2;
    const baseId = id;
    while (map.elements.some((element) => element.id === id)) id = `${baseId}-${suffix++}`;
    const element: ScreenElement = {
      id,
      screenId,
      role,
      label,
      occurrence,
      controller: map.run.controller,
      actions,
      risk: input.risk ?? "unknown",
      actionable,
      firstSeenObservationId: observationId,
      lastSeenObservationId: observationId,
      observationIds: [observationId],
      ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.visible !== undefined ? { visible: input.visible } : {}),
      ...(input.bounds !== undefined ? { bounds: input.bounds } : {}),
      ...(selector ? { selector } : {}),
    };
    map.elements.push(element);
    elementIds.push(id);
  }
  return elementIds;
}

function snapshotElements(
  map: ExploreMap,
  elementIds: string[],
  inputs: InputElement[],
): ObservedElement[] {
  return elementIds.map((elementId, index) => {
    const element = map.elements.find((entry) => entry.id === elementId);
    if (!element) throw new ExploreError(`Unknown observed element: ${elementId}`);
    const input = inputs[index];
    if (!input) throw new ExploreError(`Missing input for observed element: ${elementId}`);
    const role = input.role ?? input.kind ?? "other";
    const label = input.label?.trim() || `${role} ${index + 1}`;
    const actions = defaultActionsForElement(input);
    const actionable =
      input.actionable ??
      (input.enabled !== false && input.visible !== false && actions.length > 0);
    const selector = normalizeSelector(input.selector);
    return {
      elementId: element.id,
      role,
      label,
      occurrence: element.occurrence,
      controller: map.run.controller,
      actions: [...actions],
      risk: input.risk ?? "unknown",
      actionable,
      ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.visible !== undefined ? { visible: input.visible } : {}),
      ...(input.bounds !== undefined ? { bounds: { ...input.bounds } } : {}),
      ...(selector ? { selector } : {}),
    };
  });
}

export function markRunExploring(map: ExploreMap): void {
  map.run.status = "exploring";
  delete map.run.completedAt;
  delete map.run.stopReason;
}

export function addGap(
  map: ExploreMap,
  gap: Omit<CoverageGap, "id" | "createdAt" | "status"> & { status?: CoverageGap["status"] },
): CoverageGap {
  const existing = map.gaps.find(
    (entry) =>
      entry.status === "open" &&
      entry.kind === gap.kind &&
      entry.message === gap.message &&
      entry.screenId === gap.screenId &&
      entry.observationId === gap.observationId,
  );
  if (existing) {
    if (map.run.status === "complete") markRunExploring(map);
    return existing;
  }
  const value: CoverageGap = {
    id: newId("gap"),
    kind: gap.kind,
    status: gap.status ?? "open",
    message: gap.message,
    createdAt: now(),
    ...(gap.screenId ? { screenId: gap.screenId } : {}),
    ...(gap.observationId ? { observationId: gap.observationId } : {}),
  };
  map.gaps.push(value);
  if (value.status === "open" && map.run.status === "complete") markRunExploring(map);
  return value;
}

function ensureFrontier(map: ExploreMap, screen: Screen, elementIds: string[]): number {
  let added = 0;
  for (const elementId of elementIds) {
    const element = map.elements.find((entry) => entry.id === elementId);
    if (!element || !element.actionable || element.actions.length === 0) continue;
    for (const actionKind of element.actions) {
      const id = `frontier-${shortHash(`${screen.id}\0${element.id}\0${actionKind}`)}`;
      const existing = map.frontier.find((item) => item.id === id);
      if (existing) {
        existing.depth = screen.depth;
        existing.priority = elementPriority(element);
        continue;
      }
      map.frontier.push({
        id,
        screenId: screen.id,
        elementId: element.id,
        label: element.label,
        ...(element.selector ? { selector: element.selector } : {}),
        actionKind,
        risk: element.risk,
        depth: screen.depth,
        priority: elementPriority(element),
        status: "pending",
        createdAt: now(),
      });
      added += 1;
    }
  }
  return added;
}

function uniqueScreenId(map: ExploreMap, requested: string): string {
  let id = requested;
  let suffix = 2;
  while (map.screens.some((screen) => screen.id === id)) id = `${requested}-${suffix++}`;
  return id;
}

function validateCaptureTimestamp(value: string): void {
  const invalid = (): never => {
    throw new ExploreError("capturedAt must be a valid UTC ISO timestamp");
  };
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    invalid();
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid();
  const canonical = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_match, fraction: string) => `.${fraction.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  if (new Date(milliseconds).toISOString() !== canonical) invalid();
}

export async function recordObservation(options: {
  store: ExploreStore;
  map: ExploreMap;
  title: string;
  screenId?: string;
  screenshotPath?: string;
  snapshotPath?: string;
  snapshotText?: string;
  explicitFingerprint?: string;
  elements: InputElement[];
  parseWarnings?: string[];
  route?: string;
  state?: string;
  variantName?: string;
  /** The appearance this capture rendered, recorded on the screen when a review captures several. */
  colorScheme?: "light" | "dark";
  surfaceScope?: SurfaceScope;
  start?: boolean;
  terminal?: boolean;
  depth?: number;
  /** Trusted capture time when recording a screenshot inspected earlier. */
  capturedAt?: string;
}): Promise<{
  screen: Screen;
  variant: ScreenVariant;
  observation: Observation;
  createdScreen: boolean;
  createdVariant: boolean;
  frontierAdded: number;
  preparedArtifacts: PreparedArtifact[];
}> {
  const { map, store } = options;
  if (options.capturedAt !== undefined) validateCaptureTimestamp(options.capturedAt);
  const fingerprints = await fingerprintState({
    ...(options.explicitFingerprint ? { explicit: options.explicitFingerprint } : {}),
    ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    ...(options.snapshotText ? { snapshotText: options.snapshotText } : {}),
  });
  const capturedAt = options.capturedAt ?? now();
  let screen = options.screenId
    ? map.screens.find((entry) => entry.id === options.screenId)
    : undefined;
  if (!screen && !options.screenId) {
    const matchingVariant = map.variants.find((variant) => variant.key === fingerprints.combined);
    screen = matchingVariant
      ? map.screens.find((entry) => entry.id === matchingVariant.screenId)
      : undefined;
  }
  const createdScreen = !screen;
  if (!screen) {
    const requestedId = options.screenId ?? slug(options.title);
    const id = options.screenId ? requestedId : uniqueScreenId(map, requestedId);
    screen = {
      id,
      title: options.title,
      start: options.start ?? false,
      terminal: options.terminal ?? false,
      depth: options.start ? 0 : options.depth ?? 1,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      visits: 0,
      variantIds: [],
      observationIds: [],
      elementIds: [],
      ...(options.route ? { route: options.route } : {}),
      ...(options.state ? { state: options.state } : {}),
      ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    };
    map.screens.push(screen);
  } else {
    if (options.start) {
      screen.start = true;
      screen.depth = 0;
    } else if (options.depth !== undefined && options.depth < screen.depth) {
      screen.depth = options.depth;
    }
    if (options.terminal) screen.terminal = true;
    if (options.route) screen.route = options.route;
    if (options.state) screen.state = options.state;
  }
  // An explicitly named variant groups every rendering the caller declares equivalent, so
  // repeated samples of one declared variant stay together even when their pixels differ.
  let variant = options.variantName
    ? map.variants.find((entry) => entry.screenId === screen.id && entry.name === options.variantName)
    : undefined;
  if (!variant) {
    variant = map.variants.find(
      (entry) => entry.screenId === screen.id && entry.key === fingerprints.combined,
    );
  }
  const createdVariant = !variant;
  if (!variant) {
    // A declared variant keeps one id across builds and re-captures; unnamed variants stay
    // keyed by the rendering that created them.
    variant = {
      id: `variant-${shortHash(
        options.variantName
          ? `${screen.id}\0name\0${options.variantName}`
          : `${screen.id}\0${fingerprints.combined}`,
      )}`,
      screenId: screen.id,
      key: fingerprints.combined,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      observationIds: [],
      ...(options.variantName ? { name: options.variantName } : {}),
    };
    map.variants.push(variant);
    screen.variantIds.push(variant.id);
  } else if (options.variantName && !variant.name) {
    variant.name = options.variantName;
  }
  const observationId = newId("observation");
  const preparedScreenshot = await store.prepareArtifact(
    options.screenshotPath,
    "screenshot",
    observationId,
  );
  const preparedAccessibility = await store.prepareArtifact(
    options.snapshotPath,
    "accessibility",
    observationId,
  );
  const screenshotArtifact = preparedScreenshot?.artifact;
  const accessibilityArtifact = preparedAccessibility?.artifact;
  if (screenshotArtifact) map.artifacts.push(screenshotArtifact);
  if (accessibilityArtifact) map.artifacts.push(accessibilityArtifact);
  const observation: Observation = {
    id: observationId,
    screenId: screen.id,
    variantId: variant.id,
    fingerprints,
    capturedAt,
    surfaceScope: options.surfaceScope ?? "app",
    elementIds: [],
    elements: [],
    ...(screenshotArtifact ? { screenshotArtifactId: screenshotArtifact.id } : {}),
    ...(accessibilityArtifact ? { accessibilityArtifactId: accessibilityArtifact.id } : {}),
  };
  map.observations.push(observation);
  variant.observationIds.push(observation.id);
  variant.lastSeenAt = capturedAt;
  screen.observationIds.push(observation.id);
  screen.lastSeenAt = capturedAt;
  screen.visits += 1;
  const elementIds = mergeElements({
    map,
    screenId: screen.id,
    observationId: observation.id,
    inputs: options.elements,
  });
  observation.elementIds = elementIds;
  observation.elements = snapshotElements(map, elementIds, options.elements);
  screen.elementIds = [...new Set([...screen.elementIds, ...elementIds])];
  const frontierAdded = ensureFrontier(map, screen, elementIds);
  for (const warning of options.parseWarnings ?? []) {
    addGap(map, {
      kind: "controller-parse",
      message: warning,
      screenId: screen.id,
      observationId: observation.id,
    });
  }
  for (const item of map.frontier.filter((entry) => entry.screenId === screen.id)) {
    item.depth = screen.depth;
  }
  markRunExploring(map);
  return {
    screen,
    variant,
    observation,
    createdScreen,
    createdVariant,
    frontierAdded,
    preparedArtifacts: [preparedScreenshot, preparedAccessibility].filter(
      (artifact): artifact is PreparedArtifact => Boolean(artifact),
    ),
  };
}

export function eligibleFrontier(map: ExploreMap, timestamp = Date.now()): FrontierItem[] {
  return map.frontier
    .filter(
      (item) =>
        item.status === "pending" ||
        (item.status === "claimed" && Date.parse(item.claim?.expiresAt ?? "") <= timestamp),
    )
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        left.priority - right.priority ||
        left.createdAt.localeCompare(right.createdAt),
    );
}

export function getCoverage(map: ExploreMap): Coverage {
  const createdAt = Date.parse(map.run.createdAt);
  // A finished run's duration is its recorded lifetime, not the wall-clock age of
  // the file; otherwise every map read or exported later than its duration limit
  // would be stamped limitReached "duration".
  const terminal = ["complete", "partial", "failed"].includes(map.run.status);
  const endAt = terminal ? Date.parse(map.run.updatedAt) : Date.now();
  const elapsedMinutes = Number.isFinite(createdAt) && Number.isFinite(endAt)
    ? (endAt - createdAt) / 60_000
    : 0;
  const actualAttempts = map.actionAttempts.filter((attempt) => attempt.outcome !== "blocked");
  const frontier = {
    pending: map.frontier.filter((item) => item.status === "pending").length,
    claimed: map.frontier.filter((item) => item.status === "claimed").length,
    done: map.frontier.filter((item) => item.status === "done").length,
    skipped: map.frontier.filter((item) => item.status === "skipped").length,
    blocked: map.frontier.filter((item) => item.status === "blocked").length,
  };
  const gaps = {
    open: map.gaps.filter((gap) => gap.status === "open").length,
    accepted: map.gaps.filter((gap) => gap.status === "accepted").length,
    resolved: map.gaps.filter((gap) => gap.status === "resolved").length,
  };
  const blockers: string[] = [];
  if (map.screens.length === 0) blockers.push("no screens observed");
  if (!map.screens.some((screen) => screen.start) && map.screens.length > 0) {
    blockers.push("no start screen");
  }
  if (frontier.pending > 0) blockers.push(`${frontier.pending} pending frontier actions`);
  if (frontier.claimed > 0) blockers.push(`${frontier.claimed} claimed frontier actions`);
  if (frontier.blocked > 0) blockers.push(`${frontier.blocked} blocked frontier actions`);
  if (gaps.open > 0) blockers.push(`${gaps.open} open coverage gaps`);
  let limitReached: Coverage["limitReached"];
  if (map.screens.length >= map.run.limits.maxScreens) limitReached = "screens";
  else if (actualAttempts.length >= map.run.limits.maxActions) limitReached = "actions";
  else if (elapsedMinutes >= map.run.limits.maxDurationMinutes) limitReached = "duration";
  return {
    screens: map.screens.length,
    variants: map.variants.length,
    observations: map.observations.length,
    elements: map.elements.length,
    transitions: map.transitions.length,
    actions: {
      attempted: actualAttempts.length,
      succeeded: map.actionAttempts.filter((attempt) =>
        ["transition", "same-screen"].includes(attempt.outcome),
      ).length,
      noChange: map.actionAttempts.filter((attempt) => attempt.outcome === "no-change").length,
      failed: map.actionAttempts.filter((attempt) => attempt.outcome === "failed").length,
      blocked: map.actionAttempts.filter((attempt) => attempt.outcome === "blocked").length,
    },
    frontier,
    gaps,
    completion: { eligible: blockers.length === 0, blockers },
    limits: map.run.limits,
    ...(limitReached ? { limitReached } : {}),
  };
}

function replayAttempt(map: ExploreMap, transition: Transition): ActionAttempt | undefined {
  return [...transition.attemptIds]
    .reverse()
    .map((id) => map.actionAttempts.find((attempt) => attempt.id === id))
    .find(
      (attempt): attempt is ActionAttempt =>
        Boolean(attempt && ["transition", "same-screen"].includes(attempt.outcome)),
    );
}

export function shortestPath(
  map: ExploreMap,
  sourceScreenIds: string[],
  targetScreenId: string,
): ActionAttempt[] | null {
  const queue = sourceScreenIds.map((screenId) => ({ screenId, path: [] as ActionAttempt[] }));
  const seen = new Set(sourceScreenIds);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    if (current.screenId === targetScreenId) return current.path;
    for (const transition of map.transitions.filter((entry) => entry.fromScreenId === current.screenId)) {
      if (seen.has(transition.toScreenId)) continue;
      const attempt = replayAttempt(map, transition);
      if (!attempt) continue;
      seen.add(transition.toScreenId);
      queue.push({ screenId: transition.toScreenId, path: [...current.path, attempt] });
    }
  }
  return null;
}

export function shortestReplay(map: ExploreMap, targetScreenId: string): ActionAttempt[] | null {
  return shortestPath(
    map,
    map.screens.filter((screen) => screen.start).map((screen) => screen.id),
    targetScreenId,
  );
}

export async function validateMap(
  map: ExploreMap,
  store: ExploreStore,
  options: { checkArtifacts?: boolean } = {},
): Promise<string[]> {
  const validate = await getSchemaValidator();
  const structurallyValid = validate(map);
  const errors = structurallyValid ? [] : schemaErrors(validate.errors);
  if (!structurallyValid) return errors;
  if (map.contract !== CONTRACT) errors.push(`contract must be ${CONTRACT}`);
  if (map.run.status === "complete") {
    const coverage = getCoverage(map);
    if (!coverage.completion.eligible) {
      errors.push(
        `complete run has unresolved coverage blockers: ${coverage.completion.blockers.join("; ")}`,
      );
    }
  }
  const collections = {
    screen: map.screens,
    variant: map.variants,
    observation: map.observations,
    element: map.elements,
    artifact: map.artifacts,
    attempt: map.actionAttempts,
    transition: map.transitions,
    frontier: map.frontier,
    journey: map.journeys,
    gap: map.gaps,
  };
  for (const [kind, values] of Object.entries(collections)) {
    const ids = new Set(values.map((value) => value.id));
    if (ids.size !== values.length) errors.push(`${kind} ids must be unique`);
  }
  const screenIds = new Set(map.screens.map((screen) => screen.id));
  for (const field of ["sourceNavigation", "baselineSourceNavigation"] as const) {
    if (map[field] === undefined) continue;
    try { validateNavigationGraph(map[field], screenIds); }
    catch (error) { errors.push(`${field}: ${error instanceof Error ? error.message : "Invalid source navigation graph"}`); }
  }
  const observationIds = new Set(map.observations.map((observation) => observation.id));
  const attemptIds = new Set(map.actionAttempts.map((attempt) => attempt.id));
  const transitionIds = new Set(map.transitions.map((transition) => transition.id));
  const screensById = new Map(map.screens.map((screen) => [screen.id, screen]));
  const variantsById = new Map(map.variants.map((variant) => [variant.id, variant]));
  const observationsById = new Map(
    map.observations.map((observation) => [observation.id, observation]),
  );
  const elementsById = new Map(map.elements.map((element) => [element.id, element]));
  const artifactsById = new Map(map.artifacts.map((artifact) => [artifact.id, artifact]));
  const attemptsById = new Map(map.actionAttempts.map((attempt) => [attempt.id, attempt]));
  const transitionsById = new Map(
    map.transitions.map((transition) => [transition.id, transition]),
  );
  const frontierById = new Map(map.frontier.map((item) => [item.id, item]));
  for (const artifact of map.artifacts) {
    const artifactPath = resolve(store.root, artifact.path);
    const artifactRelative = relative(store.artifactsDir, artifactPath);
    const outsideArtifactDirectory =
      !artifactRelative ||
      artifactRelative === ".." ||
      artifactRelative.startsWith(`..${sep}`) ||
      isAbsolute(artifactRelative);
    if (outsideArtifactDirectory) {
      errors.push(`artifact ${artifact.id} is outside the artifact directory`);
      continue;
    }
    if (options.checkArtifacts !== false) {
      if (!(await pathExists(artifactPath))) {
        errors.push(`artifact ${artifact.id} is missing`);
        continue;
      }
      const bytes = await readFile(artifactPath);
      if (sha256(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) {
        errors.push(`artifact ${artifact.id} failed integrity validation`);
      }
    }
  }
  for (const variant of map.variants) {
    const screen = screensById.get(variant.screenId);
    if (!screen) errors.push(`variant ${variant.id} has unknown screen`);
    else if (!screen.variantIds.includes(variant.id)) {
      errors.push(`variant ${variant.id} is not referenced by screen ${screen.id}`);
    }
    for (const id of variant.observationIds) {
      const observation = observationsById.get(id);
      if (!observation) errors.push(`variant ${variant.id} has unknown observation ${id}`);
      else if (observation.variantId !== variant.id || observation.screenId !== variant.screenId) {
        errors.push(`variant ${variant.id} references observation ${id} from another variant or screen`);
      }
    }
  }
  for (const observation of map.observations) {
    const screen = screensById.get(observation.screenId);
    const variant = variantsById.get(observation.variantId);
    if (!screen) errors.push(`observation ${observation.id} has unknown screen`);
    else if (!screen.observationIds.includes(observation.id)) {
      errors.push(`observation ${observation.id} is not referenced by screen ${screen.id}`);
    }
    if (!variant) errors.push(`observation ${observation.id} has unknown variant`);
    else {
      if (variant.screenId !== observation.screenId) {
        errors.push(`observation ${observation.id} uses a variant from another screen`);
      }
      if (!variant.observationIds.includes(observation.id)) {
        errors.push(`observation ${observation.id} is not referenced by variant ${variant.id}`);
      }
    }
    const snapshotElementIds = observation.elements.map((element) => element.elementId);
    if (new Set(snapshotElementIds).size !== snapshotElementIds.length) {
      errors.push(`observation ${observation.id} has duplicate element snapshots`);
    }
    if (
      snapshotElementIds.length !== observation.elementIds.length ||
      snapshotElementIds.some((id) => !observation.elementIds.includes(id))
    ) {
      errors.push(`observation ${observation.id} element snapshots do not match elementIds`);
    }
    for (const id of observation.elementIds) {
      const element = elementsById.get(id);
      if (!element) errors.push(`observation ${observation.id} has unknown element ${id}`);
      else if (element.screenId !== observation.screenId) {
        errors.push(`observation ${observation.id} references element ${id} from another screen`);
      } else if (!element.observationIds.includes(observation.id)) {
        errors.push(`observation ${observation.id} is not referenced by element ${id}`);
      }
    }
    for (const [id, kind] of [
      [observation.screenshotArtifactId, "screenshot"],
      [observation.accessibilityArtifactId, "accessibility"],
    ] as const) {
      const artifact = id ? artifactsById.get(id) : undefined;
      if (id && !artifact) errors.push(`observation ${observation.id} has unknown artifact ${id}`);
      else if (artifact && artifact.kind !== kind) {
        errors.push(`observation ${observation.id} ${kind} artifact has kind ${artifact.kind}`);
      }
    }
  }
  for (const screen of map.screens) {
    for (const id of screen.variantIds) {
      const variant = variantsById.get(id);
      if (!variant) errors.push(`screen ${screen.id} has unknown variant ${id}`);
      else if (variant.screenId !== screen.id) {
        errors.push(`screen ${screen.id} references variant ${id} from another screen`);
      }
    }
    for (const id of screen.observationIds) {
      const observation = observationsById.get(id);
      if (!observation) errors.push(`screen ${screen.id} has unknown observation ${id}`);
      else if (observation.screenId !== screen.id) {
        errors.push(`screen ${screen.id} references observation ${id} from another screen`);
      }
    }
    for (const id of screen.elementIds) {
      const element = elementsById.get(id);
      if (!element) errors.push(`screen ${screen.id} has unknown element ${id}`);
      else if (element.screenId !== screen.id) {
        errors.push(`screen ${screen.id} references element ${id} from another screen`);
      }
    }
  }
  for (const element of map.elements) {
    const screen = screensById.get(element.screenId);
    if (!screen) errors.push(`element ${element.id} has unknown screen`);
    else if (!screen.elementIds.includes(element.id)) {
      errors.push(`element ${element.id} is not referenced by screen ${screen.id}`);
    }
    if (!element.observationIds.includes(element.firstSeenObservationId)) {
      errors.push(`element ${element.id} first observation is not in observationIds`);
    }
    if (!element.observationIds.includes(element.lastSeenObservationId)) {
      errors.push(`element ${element.id} last observation is not in observationIds`);
    }
    for (const id of element.observationIds) {
      const observation = observationsById.get(id);
      if (!observation) errors.push(`element ${element.id} has unknown observation ${id}`);
      else if (observation.screenId !== element.screenId || !observation.elementIds.includes(element.id)) {
        errors.push(`element ${element.id} references observation ${id} from another screen or occurrence`);
      }
    }
  }
  for (const attempt of map.actionAttempts) {
    if (!screenIds.has(attempt.sourceScreenId)) errors.push(`attempt ${attempt.id} has unknown source screen`);
    if (!observationIds.has(attempt.sourceObservationId)) errors.push(`attempt ${attempt.id} has unknown source observation`);
    const sourceObservation = observationsById.get(attempt.sourceObservationId);
    if (sourceObservation && sourceObservation.screenId !== attempt.sourceScreenId) {
      errors.push(`attempt ${attempt.id} source observation belongs to another screen`);
    }
    if (attempt.targetScreenId && !screenIds.has(attempt.targetScreenId)) {
      errors.push(`attempt ${attempt.id} has unknown target screen`);
    }
    if (attempt.targetObservationId && !observationIds.has(attempt.targetObservationId)) {
      errors.push(`attempt ${attempt.id} has unknown target observation`);
    }
    if (Boolean(attempt.targetScreenId) !== Boolean(attempt.targetObservationId)) {
      errors.push(`attempt ${attempt.id} must pair target screen and target observation`);
    }
    const targetObservation = attempt.targetObservationId
      ? observationsById.get(attempt.targetObservationId)
      : undefined;
    if (targetObservation && targetObservation.screenId !== attempt.targetScreenId) {
      errors.push(`attempt ${attempt.id} target observation belongs to another screen`);
    }
    if (["transition", "same-screen"].includes(attempt.outcome) && !attempt.targetScreenId) {
      errors.push(`attempt ${attempt.id} outcome ${attempt.outcome} requires a target`);
    }
    if (attempt.outcome === "transition" && attempt.targetScreenId === attempt.sourceScreenId) {
      errors.push(`attempt ${attempt.id} transition must target another canonical screen`);
    }
    if (attempt.outcome === "same-screen" && attempt.targetScreenId !== attempt.sourceScreenId) {
      errors.push(`attempt ${attempt.id} same-screen outcome must target its source screen`);
    }
    if (["transition", "same-screen"].includes(attempt.outcome)) {
      const containingTransitions = map.transitions.filter((transition) =>
        transition.attemptIds.includes(attempt.id),
      );
      if (containingTransitions.length !== 1) {
        errors.push(`attempt ${attempt.id} must belong to exactly one transition`);
      }
    }
    const frontierItem = attempt.frontierId ? frontierById.get(attempt.frontierId) : undefined;
    if (attempt.frontierId && !frontierItem) {
      errors.push(`attempt ${attempt.id} has unknown frontier item`);
    } else if (frontierItem) {
      if (frontierItem.screenId !== attempt.sourceScreenId) {
        errors.push(`attempt ${attempt.id} belongs to a frontier item on another screen`);
      }
      if (frontierItem.actionKind !== attempt.action.kind) {
        errors.push(`attempt ${attempt.id} action kind does not match its frontier item`);
      }
      if (frontierItem.elementId !== attempt.action.elementId) {
        errors.push(`attempt ${attempt.id} element does not match its frontier item`);
      }
    }
    const actionElement = attempt.action.elementId
      ? elementsById.get(attempt.action.elementId)
      : undefined;
    if (attempt.action.elementId && !actionElement) {
      errors.push(`attempt ${attempt.id} has unknown action element`);
    } else if (actionElement && actionElement.screenId !== attempt.sourceScreenId) {
      errors.push(`attempt ${attempt.id} action element belongs to another screen`);
    }
    const action = attempt.action;
    const requiresExecutionDetails = attempt.outcome !== "blocked";
    if (action.kind === "fill") {
      if (
        (requiresExecutionDetails || action.input) &&
        (!action.input || Boolean(action.input.value) === Boolean(action.input.fixture))
      ) {
        errors.push(`attempt ${attempt.id} fill action requires exactly one input value or fixture`);
      }
    } else if (action.input) {
      errors.push(`attempt ${attempt.id} non-fill action cannot contain input`);
    }
    if (
      action.kind === "swipe"
        ? requiresExecutionDetails && !action.gesture
        : Boolean(action.gesture)
    ) {
      errors.push(`attempt ${attempt.id} gesture must appear exactly on swipe actions`);
    }
    if (
      action.kind === "deep-link"
        ? requiresExecutionDetails && !action.deepLink
        : Boolean(action.deepLink)
    ) {
      errors.push(`attempt ${attempt.id} deepLink must appear exactly on deep-link actions`);
    }
    if (
      action.kind === "key"
        ? requiresExecutionDetails && !action.key
        : Boolean(action.key)
    ) {
      errors.push(`attempt ${attempt.id} key must appear exactly on key actions`);
    }
    if (action.wait?.strategy === "duration" && action.wait.durationMs === undefined) {
      errors.push(`attempt ${attempt.id} duration wait requires durationMs`);
    }
    if (action.wait?.strategy === "element" && !action.wait.selector) {
      errors.push(`attempt ${attempt.id} element wait requires selector`);
    }
  }
  for (const transition of map.transitions) {
    if (!screenIds.has(transition.fromScreenId)) errors.push(`transition ${transition.id} has unknown source`);
    if (!screenIds.has(transition.toScreenId)) errors.push(`transition ${transition.id} has unknown target`);
    for (const id of transition.attemptIds) {
      const attempt = attemptsById.get(id);
      if (!attempt) errors.push(`transition ${transition.id} has unknown attempt ${id}`);
      else if (
        attempt.sourceScreenId !== transition.fromScreenId ||
        attempt.targetScreenId !== transition.toScreenId ||
        !["transition", "same-screen"].includes(attempt.outcome) ||
        attempt.action.kind !== transition.actionKind ||
        attempt.action.elementId !== transition.elementId ||
        normalizeSelector(attempt.action.selector) !== normalizeSelector(transition.selector)
      ) {
        errors.push(`transition ${transition.id} contains attempt ${id} for another edge or action`);
      }
    }
  }
  for (const item of map.frontier) {
    if (!screenIds.has(item.screenId)) errors.push(`frontier ${item.id} has unknown screen`);
    const element = item.elementId ? elementsById.get(item.elementId) : undefined;
    if (item.elementId && !element) errors.push(`frontier ${item.id} has unknown element`);
    else if (element && element.screenId !== item.screenId) {
      errors.push(`frontier ${item.id} element belongs to another screen`);
    } else if (element && !element.actions.includes(item.actionKind)) {
      errors.push(`frontier ${item.id} action is not supported by its element`);
    }
    const lastAttempt = item.lastAttemptId ? attemptsById.get(item.lastAttemptId) : undefined;
    if (item.lastAttemptId && !lastAttempt) {
      errors.push(`frontier ${item.id} has unknown last attempt`);
    } else if (lastAttempt && lastAttempt.frontierId !== item.id) {
      errors.push(`frontier ${item.id} last attempt belongs to another frontier item`);
    }
    if (["done", "skipped", "blocked"].includes(item.status) && !item.lastAttemptId) {
      errors.push(`frontier ${item.id} status ${item.status} requires a last attempt`);
    }
  }
  for (const journey of map.journeys) {
    for (const id of journey.screenIds) {
      if (!screenIds.has(id)) errors.push(`journey ${journey.id} has unknown screen ${id}`);
    }
    if (journey.source?.kind === "structural") {
      if (journey.transitionIds.length || journey.attemptIds.length) {
        errors.push(`structural journey ${journey.id} cannot claim observed transitions or replay attempts`);
      }
      continue;
    }
    for (const id of journey.transitionIds) {
      if (!transitionIds.has(id)) errors.push(`journey ${journey.id} has unknown transition ${id}`);
    }
    for (const id of journey.attemptIds) {
      if (!attemptIds.has(id)) errors.push(`journey ${journey.id} has unknown attempt ${id}`);
    }
    const expectedEdges = Math.max(0, journey.screenIds.length - 1);
    if (journey.transitionIds.length !== expectedEdges) {
      errors.push(`journey ${journey.id} must have one transition per screen pair`);
    }
    if (journey.attemptIds.length !== journey.transitionIds.length) {
      errors.push(`journey ${journey.id} must have one replay attempt per transition`);
    }
    for (let index = 0; index < journey.transitionIds.length; index += 1) {
      const transitionId = journey.transitionIds[index];
      const transition = transitionId ? transitionsById.get(transitionId) : undefined;
      if (
        transition &&
        (transition.fromScreenId !== journey.screenIds[index] ||
          transition.toScreenId !== journey.screenIds[index + 1])
      ) {
        errors.push(`journey ${journey.id} transition ${transition.id} does not connect its screen pair`);
      }
      const attemptId = journey.attemptIds[index];
      if (transition && attemptId && !transition.attemptIds.includes(attemptId)) {
        errors.push(`journey ${journey.id} attempt ${attemptId} does not belong to transition ${transition.id}`);
      }
    }
  }
  for (const gap of map.gaps) {
    const screen = gap.screenId ? screensById.get(gap.screenId) : undefined;
    const observation = gap.observationId
      ? observationsById.get(gap.observationId)
      : undefined;
    if (gap.screenId && !screen) errors.push(`gap ${gap.id} has unknown screen`);
    if (gap.observationId && !observation) errors.push(`gap ${gap.id} has unknown observation`);
    if (screen && observation && observation.screenId !== screen.id) {
      errors.push(`gap ${gap.id} observation belongs to another screen`);
    }
  }
  return errors;
}
