import type { MapDirection, Route } from "./navigation";

/** React Flow's camera transform, independent from the rendered canvas size. */
export type CameraViewport = {
  x: number;
  y: number;
  zoom: number;
  /** World point that sat at the visible-frame centre when this snapshot was committed. */
  center?: { x: number; y: number };
};

export type CameraHistoryEntry = {
  version: 1;
  id: string;
  key: string;
  viewport?: CameraViewport;
};

/**
 * Browser history restores semantic destinations, not arbitrary inspection transforms. Dropping
 * the old viewport gives the selected node (or the current projection) sole ownership of
 * the next centred Fit while retaining the history entry's stable identity.
 */
export function cameraHistoryFitEntry(
  entry: CameraHistoryEntry | undefined,
  key: string,
): CameraHistoryEntry {
  return {
    version: 1,
    id: entry?.id ?? createCameraHistoryId(),
    key,
  };
}

const CAMERA_STATE_KEY = "__expoExploreCamera";

type CameraRoute = Pick<Route, "baseline" | "canvas">;

/** Every canvas is a deterministic overview, so entering one frames the full projection. */
export function routeUsesProjectionFitCamera(route: Pick<Route, "canvas">): boolean {
  return route.canvas === "screens" || route.canvas === "map";
}

/**
 * Cameras belong to a rendered document projection, not a selected screen. Inspector changes
 * therefore keep the current view steady, while each build, comparison and Map scope gets its
 * own remembered position.
 */
export function cameraKeyForRoute(
  route: CameraRoute,
  documentId: string,
  mapDirection: MapDirection,
): string {
  const common: readonly string[] = [
    "camera-v1",
    documentId,
    route.baseline || "no-baseline",
    route.canvas,
  ];
  return JSON.stringify(route.canvas === "map" ? [...common, mapDirection] : common);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isViewport(value: unknown): value is CameraViewport {
  if (!isRecord(value)) return false;
  const validCenter = value.center === undefined || (
    isRecord(value.center)
    && Number.isFinite(value.center.x)
    && Number.isFinite(value.center.y)
  );
  return validCenter
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.zoom)
    && Number(value.zoom) > 0;
}

/** Untrusted browser history state is accepted only when every camera field is valid. */
export function cameraHistoryEntry(state: unknown): CameraHistoryEntry | undefined {
  if (!isRecord(state)) return undefined;
  const value = state[CAMERA_STATE_KEY];
  if (!isRecord(value)) return undefined;
  if (value.version !== 1 || typeof value.id !== "string" || typeof value.key !== "string") {
    return undefined;
  }
  if (value.viewport !== undefined && !isViewport(value.viewport)) return undefined;
  return {
    version: 1,
    id: value.id,
    key: value.key,
    ...(value.viewport ? {
      viewport: {
        ...value.viewport,
        ...(value.viewport.center && isRecord(value.viewport.center)
          ? { center: { x: Number(value.viewport.center.x), y: Number(value.viewport.center.y) } }
          : {}),
      },
    } : {}),
  };
}

/** Adds Explore's camera entry without discarding state another history integration owns. */
export function withCameraHistoryEntry(
  state: unknown,
  entry: CameraHistoryEntry,
): Record<string, unknown> {
  return {
    ...(isRecord(state) ? state : {}),
    [CAMERA_STATE_KEY]: {
      ...entry,
    ...(entry.viewport ? {
      viewport: {
        ...entry.viewport,
        ...(entry.viewport.center ? { center: { ...entry.viewport.center } } : {}),
      },
    } : {}),
    },
  };
}

/** Unique per browser history entry; the id is also the one-shot camera restore identity. */
export function createCameraHistoryId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
