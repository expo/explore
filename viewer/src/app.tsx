import { appearanceLabel, appearanceOptions, appearanceScope, filterComparisonAppearance, filterMapAppearance, filterReviewAppearance, type Appearance } from "./utils/appearance";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Toaster } from "sonner";
import { isEmbeddedArtifactUrl, optionalStorage, releaseEmbeddedArtifactUrl, resolveEmbeddedArtifactUrl, viewerLocation } from "./utils/embedded-report";
import { REPORT_SOURCE } from "./utils/report-source";
import { CanvasToolbar } from "./components/canvas/toolbar";
import { CanvasCameraControls } from "./components/canvas/camera-controls";
import { CanvasVisibleFrameProvider } from "./components/canvas/visible-frame-provider";
import { AppLoading } from "./components/shared/app-loading";
import { ReportLoadingShell } from "./components/shared/report-loading-shell";
import { screenLabel } from "./utils/screen-path";
import { AppPill, PLATFORM_NAMES } from "./components/panels/app-pill";
import { changedScreens, focusCounts as countFocusStatuses, isCapturedChange, type ChangedScreen } from "./utils/changed-screens";
import { MapView } from "./components/views/semantic-map";
import { RightPanel } from "./components/panels/right";
import { SearchCommand } from "./components/search-command";
import { ScreensView } from "./components/views/screens";
import { publicReviewProjection, publicReviewToWorkspace } from "./public/public-workspace";
import type { PublicReview } from "../../src/contracts/capture";
import {
  buildDiff,
  comparisonFor,
  routeContextForCatalog,
  scopeMapArtifacts,
  type ViewerBuild,
  type ViewerWorkspace,
} from "./utils/build-diff";
import { type ViewerPayload, artifactUrl } from "./utils/model";
import {
  canonicalRoute,
  formatRoute,
  CANVAS_LABELS,
  parseLocation,
  resolveScreenId,
  sanitizeViewerRoute,
  screenRoutesOf,
  screenVariantsOf,
  type CanvasView,
  type FocusBehavior,
  type FocusRequest,
  type MapDirection,
  type Route,
  type RouteContext,
  type ThemePreference,
} from "./utils/navigation";
import {
  CANVAS_NUMBER_KEYS,
  matchesShortcut,
  modalOpen,
  SHORTCUTS,
  shortcutsLive,
  type Shortcut,
} from "./utils/shortcuts";
import { deriveCaptureRouteAliases } from "./utils/route-aliases";
import {
  cameraHistoryFitEntry,
  cameraHistoryEntry,
  cameraKeyForRoute,
  createCameraHistoryId,
  routeUsesProjectionFitCamera,
  withCameraHistoryEntry,
  type CameraHistoryEntry,
  type CameraViewport,
} from "./utils/camera-history";
import type { CanvasViewportChangeEvent } from "./components/canvas/camera";
import {
  isBlackBoxMap,
} from "./utils/graph-model";
import { buildSearchItems, suggestedSearchItems } from "./utils/search";
import {
  presentBuildDiff,
  presentScreensByPath,
  screenAliasesForPresentation,
} from "./utils/screen-presentation";
import { canvasViewTransitionDirection } from "./utils/canvas-view-transition";
import {
  STATIC_VIEWER_SOURCE,
  withStaticSourceParameters,
} from "./utils/static-source";
import { reviewProjectionFromWorkspace } from "./utils/review-model";
import { CompareSection } from "./components/compare/compare-section";
import { ShortcutsDialog } from "./components/compare/shortcuts-dialog";
import { usePhoneLayout } from "./utils/phone-layout";
import { PhoneTabBar } from "./components/phone/phone-chrome";
import { HandoffButton, HandoffDialog } from "./components/shared/handoff";
import { handoffPageUrl } from "./utils/handoff";
import { PhoneCompare } from "./components/phone/phone-compare";

const INVALID_WORKSPACE_MESSAGE = "This link did not return a valid Explore workspace. Open the latest Explore review from your pull request.";

function responseRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkspaceResponse(value: unknown): { body: ViewerWorkspace; publicReview?: PublicReview } {
  if (responseRecord(value) && value.contract === "expo.explore.public-review.v1") {
    throw new Error("This report uses an older format. Open the latest Explore review from your pull request.");
  }
  if (responseRecord(value) && value.contract === "explore.review") {
    const publicReview = value as PublicReview;
    return { body: publicReviewToWorkspace(publicReview), publicReview };
  }
  if (!responseRecord(value) || !responseRecord(value.catalog) || !responseRecord(value.builds)
    || typeof value.catalog.currentBuildId !== "string" || !value.catalog.currentBuildId
    || !Array.isArray(value.catalog.builds) || !Array.isArray(value.catalog.comparisons)
    || !responseRecord(value.comparison) || !Array.isArray(value.comparison.entries)
    || !Object.values(value.builds).every(build => responseRecord(build) && responseRecord(build.map)
      && responseRecord(build.map.run) && typeof build.map.run.id === "string"
      && Array.isArray(build.map.screens) && responseRecord(build.coverage))) {
    throw new Error(INVALID_WORKSPACE_MESSAGE);
  }
  return { body: value as ViewerWorkspace };
}

type ViewerStatus = {
  runId: string;
  revision: number;
  coverage: ViewerPayload["coverage"];
};

type WorkspaceViewerStatus = {
  currentBuildId: string;
  defaultBaselineBuildId: string;
  builds: Record<string, {
    runId: string;
    revision: number;
    coverage: ViewerPayload["coverage"];
  }>;
  comparison: {
    baselineBuildId: string;
    currentBuildId: string;
    baselineRevision: number;
    currentRevision: number;
  };
};

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "expo-explore:theme";
const LEGACY_COLLAPSED_STORAGE_KEY = "expo-explore:panel-collapsed";
const RIGHT_COLLAPSED_STORAGE_KEY = "expo-explore:right-panel-collapsed";
// The shell's keyboard map, paired with what each key selects. Read as lists so a key and the
// thing it reaches stay one entry.
const CANVAS_KEYS = [
  ...Object.entries(SHORTCUTS.canvas),
  ...(CANVAS_NUMBER_KEYS ? Object.entries(SHORTCUTS.canvasByNumber) : []),
] as [CanvasView, Shortcut][];

/** Before data loads there is no comparison to assume. A workspace reparses the URL on arrival. */
const EMPTY_ROUTE_CONTEXT: RouteContext = {
  defaultBaseline: "",
  baselines: [],
  screenRoutes: new Map(),
};

type FocusTarget = Pick<FocusRequest, "target" | "id">;
type PendingSearchFocus = {
  canvas: CanvasView;
  target: FocusTarget;
};
type NavigateOptions = {
  /** Rewrites the current history entry instead of adding one: a highlight, not a move. */
  replace?: boolean;
  /** What the canvas should bring into view once the route has settled. */
  focus?: FocusTarget;
  behavior?: FocusBehavior;
  /** Keeps an in-flight focus while an internal projection change makes its target visible. */
  preserveFocus?: boolean;
  /** Keeps an Inspector selection from changing the Map projection after an explicit Map change. */
  preserveMapContent?: boolean;
  /** Discards a remembered camera so an explicit projection drill-down can frame fresh content. */
  resetCamera?: boolean;
};

type NavigateResult = {
  next: Route;
  cameraEntry: CameraHistoryEntry;
  restoredCamera: boolean;
};

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedThemePreference(): ThemePreference {
  const stored = optionalStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function storedPanelCollapsed(key: string, fallback = false): boolean {
  const current = optionalStorage.getItem(key);
  if (current !== null) return current === "true";
  const legacy = optionalStorage.getItem(LEGACY_COLLAPSED_STORAGE_KEY);
  return legacy !== null ? legacy === "true" : fallback;
}

function standaloneBuild(payload: ViewerPayload | undefined): ViewerBuild | undefined {
  if (!payload) return undefined;
  const provenance = payload.map.run.build;
  const version = provenance.version
    ?? provenance.number
    ?? provenance.hash
    ?? provenance.gitCommit
    ?? provenance.id
    ?? payload.map.run.id;
  return {
    id: provenance.id ?? payload.map.run.id,
    kind: "build",
    version,
    mapDir: ".",
  };
}

function currentUrl(): string {
  return REPORT_SOURCE.data ? (window.location.hash || "#/map") : `${window.location.pathname}${window.location.search}`;
}

function formatViewerRoute(route: Route, context: RouteContext): string {
  const path = formatRoute(route, context);
  return REPORT_SOURCE.data ? `#${path}` : withStaticSourceParameters(path);
}

function routeContextForMap(
  map: ViewerPayload["map"],
  catalog?: ViewerWorkspace["catalog"],
): RouteContext {
  const presentation = presentScreensByPath(map);
  const aliases = screenAliasesForPresentation(
    map,
    presentation,
    deriveCaptureRouteAliases(map),
  );
  return {
    ...routeContextForCatalog(catalog),
    screenRoutes: screenRoutesOf(presentation.map.screens),
    screenVariants: screenVariantsOf(presentation.map.screens),
    screenIdAliases: aliases.screenIdAliases,
    screenIdAliasVariants: aliases.screenIdAliasVariants,
    screenRouteAliases: aliases.screenRouteAliases,
  };
}

/** A flight is motion for its own sake; readers who asked for less of it get a cut. */
function preferredBehavior(): FocusBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "cut" : "fly";
}

/**
 * Where a route asks the canvas to land: the selected screen, when the route names one.
 */
function focusTargetFor(
  route: Route,
  ctx: RouteContext,
): FocusTarget | undefined {
  const screenId = resolveScreenId(route, ctx);
  return screenId ? { target: "screen", id: screenId } : undefined;
}

/** Stable identity for the content a same-canvas navigation is asking the camera to frame. */
function semanticCameraTargetKey(route: Route, ctx: RouteContext): string {
  const focus = focusTargetFor(route, ctx);
  if (focus) return `${focus.target}:${focus.id}`;
  return `${route.canvas}:root`;
}

function viewerRoute(route: Route): Route {
  return sanitizeViewerRoute(route);
}

export function App() {
  const source = useSyncExternalStore(REPORT_SOURCE.subscribe, REPORT_SOURCE.getSnapshot, REPORT_SOURCE.getSnapshot);
  useEffect(() => { void REPORT_SOURCE.load(); }, []);
  const openFile = useCallback((file: File) => { void REPORT_SOURCE.openFile(file); }, []);
  const retry = useCallback(() => REPORT_SOURCE.retry(), []);
  if (source.status !== "ready") {
    // A wrong file is replaced by dropping the right one, even from the failed state.
    const droppable = REPORT_SOURCE.canRetry && (source.status === "awaiting-file" || source.status === "failed");
    return <ReportLoadingShell progress={source.progress}
      {...(source.identity ? { identity: source.identity } : {})}
      {...(source.error ? { error: source.error } : {})}
      awaiting={source.status === "awaiting-file"}
      {...(REPORT_SOURCE.workflowUrl ? { workflowUrl: REPORT_SOURCE.workflowUrl } : {})}
      {...(REPORT_SOURCE.downloadUrl ? { downloadUrl: REPORT_SOURCE.downloadUrl } : {})}
      {...(REPORT_SOURCE.expectedFileName ? { expectedFileName: REPORT_SOURCE.expectedFileName } : {})}
      {...(droppable ? { onOpenFile: openFile } : {})}
      {...(droppable && source.status === "failed" ? { onRetry: retry } : {})} />;
  }
  return <ViewerApp />;
}

function ViewerApp() {
  const [payload, setPayload] = useState<ViewerPayload>();
  const [workspace, setWorkspace] = useState<ViewerWorkspace>();
  const [loadedPublicReview, setLoadedPublicReview] = useState<PublicReview>();
  const [error, setError] = useState<string>();
  // The URL is the one record of where the viewer is; `route` is it parsed, and everything a
  // reader would call navigation — canvas, rail, selection, inspector tabs, baseline, focus —
  // is read off it rather than held on its own.
  const [route, setRoute] = useState<Route>(() => (
    viewerRoute(parseLocation(viewerLocation(), EMPTY_ROUTE_CONTEXT))
  ));
  const routeRef = useRef(route);
  const contextRef = useRef(EMPTY_ROUTE_CONTEXT);
  const [mapProjectionFitKey, setMapProjectionFitKey] = useState(0);
  // A report captured in several appearances shows one at a time; the primary (first captured) is the default.
  const [appearanceChoice, setAppearanceChoice] = useState<Appearance | undefined>();
  const [handoffOpen, setHandoffOpen] = useState(false);
  /** Whether this page can hand the report off (a hosted preview); the A key reads it. */
  const handoffAvailableRef = useRef(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>();
  const [pendingSearchFocus, setPendingSearchFocus] = useState<PendingSearchFocus>();
  const focusSeq = useRef(0);
  const landed = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Compare steps through the changed screens in review order. Callbacks read it from a ref,
  // because they are created before the diff that produces it.
  const compareOrderRef = useRef<readonly ChangedScreen[]>([]);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const [preferredSystemTheme, setPreferredSystemTheme] = useState<Theme>(systemTheme);
  const [themePreference, setThemePreference] = useState<ThemePreference>(storedThemePreference);
  const [changesOpen, setChangesOpen] = useState(false);
  // The bottom toolbar's slot that desktop Compare fills with its mode switch.
  // Below the phone breakpoint the canvases become lists, the Inspector a bottom sheet and the
  // toolbar a tab bar. The Map's canvas stays one tap away.
  const phone = usePhoneLayout();
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  // The reader closed the Inspector while a screen was selected. Moving to another screen then
  // leaves it closed, until the reader clears the selection or opens it again.
  const inspectorDismissedRef = useRef(false);
  const blackBoxRef = useRef(false);
  // Compare on a phone is full screen; its back button returns to the view it was opened from.
  const [rightCollapsed, setRightCollapsed] = useState(() => {
    return storedPanelCollapsed(
      RIGHT_COLLAPSED_STORAGE_KEY,
      !(route.screen || route.screenRoute),
    );
  });
  // Map content changes read this without being recreated on every panel toggle.
  const rightCollapsedRef = useRef(rightCollapsed);
  rightCollapsedRef.current = rightCollapsed;
  const previousSelectedScreenIdRef = useRef<string | undefined>(
    route.screen ?? route.screenRoute,
  );
  const canvasViewTransitionRef = useRef<ViewTransition | undefined>(undefined);
  const mapDirection: MapDirection = "TB";
  // Browser history owns semantic destinations, not inspection transforms. Cold opens and
  // Back/Forward both derive a fresh centred camera from the active selection or projection.
  const [cameraEntry, setCameraEntryState] = useState<CameraHistoryEntry | undefined>();
  // The same history entry may be revisited after a same-document focus without ever changing
  // its id. Keep an explicit publish generation so CanvasStage treats Back/Forward as a fresh
  // semantic Fit even when it already consumed this entry on first mount.
  const [cameraRestoreRevision, setCameraRestoreRevision] = useState(0);
  const [cameraRestoreBehavior, setCameraRestoreBehavior] = useState<FocusBehavior>("cut");
  const cameraEntryRef = useRef(cameraEntry);
  const cameraCacheRef = useRef<Map<string, CameraViewport>>(new Map());
  const activeCameraRef = useRef<{ key: string; viewport: CameraViewport } | undefined>(undefined);
  const activeCameraKeyRef = useRef("");
  const cameraContextRef = useRef({ documentId: "loading", mapDirection });
  const workspaceEtagRef = useRef<string | undefined>(undefined);
  const mapEtagRef = useRef<string | undefined>(undefined);
  const workspaceModeRef = useRef(false);
  const workspaceRevisionRef = useRef<Record<string, { runId: string; revision: number }>>({});
  const revisionRef = useRef<{ runId: string; revision: number } | undefined>(undefined);
  const pollingRef = useRef(false);
  const theme = themePreference === "system" ? preferredSystemTheme : themePreference;
  // Auto → Dark → Light → Auto, as the button's tooltip spells out.
  const toggleTheme = useCallback(() => {
    setThemePreference(current => current === "system" ? "dark" : current === "dark" ? "light" : "system");
  }, []);

  const load = useCallback(async (silent = false) => {
    void silent;
    try {
      if (REPORT_SOURCE.data?.exploration) {
        const { map, coverage } = REPORT_SOURCE.data.exploration;
        workspaceModeRef.current = false;
        revisionRef.current = { runId: map.run.id, revision: map.revision };
        setLoadedPublicReview(undefined);
        setWorkspace(undefined);
        setPayload({ map, coverage });
        const nextContext = routeContextForMap(map);
        const nextRoute = viewerRoute(parseLocation(viewerLocation(), nextContext));
        contextRef.current = nextContext;
        routeRef.current = nextRoute;
        setRoute(nextRoute);
        setError(undefined);
        return;
      }
      if (REPORT_SOURCE.data) {
        const publicReview = REPORT_SOURCE.data.publicReview;
        const body = publicReview ? publicReviewToWorkspace(publicReview) : REPORT_SOURCE.data.workspace!;
        const current = body.builds[body.catalog.currentBuildId];
        if (!current) throw new Error(`Current build is missing: ${body.catalog.currentBuildId}`);
        workspaceModeRef.current = true;
        setLoadedPublicReview(publicReview);
        setWorkspace(body);
        setPayload(current);
        const nextContext = routeContextForMap(current.map, body.catalog);
        const nextRoute = viewerRoute(parseLocation(viewerLocation(), nextContext));
        contextRef.current = nextContext;
        routeRef.current = nextRoute;
        setRoute(nextRoute);
        setError(undefined);
        return;
      }
      if (STATIC_VIEWER_SOURCE.mode === "invalid") {
        throw new Error(STATIC_VIEWER_SOURCE.error);
      }
      if (STATIC_VIEWER_SOURCE.mode === "static") {
        const response = await fetch(STATIC_VIEWER_SOURCE.workspaceUrl, {
          cache: "no-cache",
          // Authenticated review hosts expose the private workspace at this origin and keep the
          // GitHub session in an HttpOnly cookie. `same-origin` sends it there while still never
          // attaching credentials to an explicitly cross-origin public workspace URL.
          credentials: "same-origin",
        });
        const result: unknown = await response.json().catch(() => undefined);
        if (!response.ok) throw new Error(responseRecord(result) && typeof result.error === "string"
          ? result.error : `Static viewer returned ${response.status}`);
        const { body, publicReview } = readWorkspaceResponse(result);
        const current = body.builds[body.catalog.currentBuildId];
        if (!current) throw new Error(`Current build is missing: ${body.catalog.currentBuildId}`);
        workspaceModeRef.current = true;
        workspaceRevisionRef.current = Object.fromEntries(
          Object.entries(body.builds).map(([buildId, build]) => [
            buildId,
            { runId: build.map.run.id, revision: build.map.revision },
          ]),
        );
        revisionRef.current = { runId: current.map.run.id, revision: current.map.revision };
        setLoadedPublicReview(publicReview);
        setWorkspace(body);
        setPayload(current);
        const nextContext = routeContextForMap(current.map, body.catalog);
        const nextRoute = viewerRoute(parseLocation(viewerLocation(), nextContext));
        contextRef.current = nextContext;
        routeRef.current = nextRoute;
        setRoute(nextRoute);
        setError(undefined);
        return;
      }
      const workspaceResponse = await fetch("/api/workspace", {
        cache: "no-cache",
        credentials: "same-origin",
        headers: workspaceEtagRef.current
          ? { "If-None-Match": workspaceEtagRef.current }
          : {},
      });
      if (workspaceResponse.status === 304) {
        setError(undefined);
        return;
      }
      if (workspaceResponse.status !== 404) {
        const result: unknown = await workspaceResponse.json().catch(() => undefined);
        if (!workspaceResponse.ok) {
          throw new Error(responseRecord(result) && typeof result.error === "string"
            ? result.error : `Viewer returned ${workspaceResponse.status}`);
        }
        const { body } = readWorkspaceResponse(result);
        const current = body.builds[body.catalog.currentBuildId];
        if (!current) {
          throw new Error(`Current build is missing: ${body.catalog.currentBuildId}`);
        }
        const nextEtag = workspaceResponse.headers.get("etag");
        if (nextEtag) workspaceEtagRef.current = nextEtag;
        workspaceModeRef.current = true;
        workspaceRevisionRef.current = Object.fromEntries(
          Object.entries(body.builds).map(([buildId, build]) => [
            buildId,
            { runId: build.map.run.id, revision: build.map.revision },
          ]),
        );
        revisionRef.current = { runId: current.map.run.id, revision: current.map.revision };
        setWorkspace(body);
        setPayload(current);
        const nextContext = routeContextForMap(current.map, body.catalog);
        const nextRoute = viewerRoute(parseLocation(viewerLocation(), nextContext));
        contextRef.current = nextContext;
        routeRef.current = nextRoute;
        setRoute(nextRoute);
        setError(undefined);
        return;
      }

      workspaceModeRef.current = false;
      const mapResponse = await fetch("/api/map", {
        cache: "no-cache",
        credentials: "same-origin",
        headers: mapEtagRef.current ? { "If-None-Match": mapEtagRef.current } : {},
      });
      if (mapResponse.status === 304) {
        setError(undefined);
        return;
      }
      const body = (await mapResponse.json()) as ViewerPayload & { error?: string };
      if (!mapResponse.ok) throw new Error(body.error ?? `Viewer returned ${mapResponse.status}`);
      const nextEtag = mapResponse.headers.get("etag");
      if (nextEtag) mapEtagRef.current = nextEtag;
      revisionRef.current = { runId: body.map.run.id, revision: body.map.revision };
      setWorkspace(undefined);
      setPayload(body);
      const nextContext = routeContextForMap(body.map);
      const nextRoute = viewerRoute(parseLocation(viewerLocation(), nextContext));
      contextRef.current = nextContext;
      routeRef.current = nextRoute;
      setRoute(nextRoute);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      if (workspaceModeRef.current) {
        const response = await fetch("/api/workspace/status", {
          cache: "no-store",
          credentials: "same-origin",
          headers: workspaceEtagRef.current
            ? { "If-None-Match": workspaceEtagRef.current }
            : {},
        });
        if (response.status === 304) {
          setError(undefined);
          return;
        }
        const status = (await response.json()) as WorkspaceViewerStatus & { error?: string };
        if (!response.ok) throw new Error(status.error ?? `Viewer returned ${response.status}`);
        const nextEtag = response.headers.get("etag");
        const changed = Boolean(
          nextEtag && workspaceEtagRef.current && nextEtag !== workspaceEtagRef.current,
        ) || Object.entries(status.builds).some(([buildId, build]) => {
          const known = workspaceRevisionRef.current[buildId];
          return !known || known.runId !== build.runId || known.revision !== build.revision;
        });
        if (changed) {
          await load(true);
        } else {
          // Duration-based coverage can advance without changing either map revision. Keep both
          // build payloads current while preserving the graph objects and comparison identity.
          setWorkspace((existing) => {
            if (!existing) return existing;
            let nextBuilds = existing.builds;
            for (const [buildId, buildStatus] of Object.entries(status.builds)) {
              const build = existing.builds[buildId];
              if (!build || JSON.stringify(build.coverage) === JSON.stringify(buildStatus.coverage)) {
                continue;
              }
              if (nextBuilds === existing.builds) nextBuilds = { ...existing.builds };
              nextBuilds[buildId] = { ...build, coverage: buildStatus.coverage };
            }
            return nextBuilds === existing.builds ? existing : { ...existing, builds: nextBuilds };
          });
          const currentCoverage = status.builds[status.currentBuildId]?.coverage;
          if (currentCoverage) {
            setPayload((existing) => {
              if (!existing
                || JSON.stringify(existing.coverage) === JSON.stringify(currentCoverage)) {
                return existing;
              }
              return { ...existing, coverage: currentCoverage };
            });
          }
          setError(undefined);
        }
        return;
      }
      const response = await fetch("/api/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const status = (await response.json()) as ViewerStatus & { error?: string };
      if (!response.ok) throw new Error(status.error ?? `Viewer returned ${response.status}`);
      const current = revisionRef.current;
      if (!current || current.runId !== status.runId || current.revision !== status.revision) {
        await load(true);
        return;
      }
      setPayload((existing) => {
        if (!existing || JSON.stringify(existing.coverage) === JSON.stringify(status.coverage)) {
          return existing;
        }
        return { ...existing, coverage: status.coverage };
      });
      setError(undefined);
    } catch (pollError) {
      setError(pollError instanceof Error ? pollError.message : String(pollError));
    } finally {
      pollingRef.current = false;
    }
  }, [load]);

  useEffect(() => {
    void load();
    if (REPORT_SOURCE.data || STATIC_VIEWER_SOURCE.mode !== "api") return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [load, poll]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const onPreferenceChange = (event: MediaQueryListEvent) => {
      setPreferredSystemTheme(event.matches ? "dark" : "light");
    };
    preference.addEventListener("change", onPreferenceChange);
    return () => preference.removeEventListener("change", onPreferenceChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    optionalStorage.setItem(THEME_STORAGE_KEY, themePreference);
  }, [themePreference]);

  // Panel state is persisted only by the explicit toggles below. Route-driven collapses (a
  // deep link opening the Inspector) are canvas defaults, not reader
  // preferences, so writing them here would poison the next cold load. The legacy shared key
  // still migrates once into both per-side keys before it is dropped.
  useEffect(() => {
    const legacy = optionalStorage.getItem(LEGACY_COLLAPSED_STORAGE_KEY);
    if (legacy !== null) {
      if (optionalStorage.getItem(RIGHT_COLLAPSED_STORAGE_KEY) === null) {
        optionalStorage.setItem(RIGHT_COLLAPSED_STORAGE_KEY, legacy);
      }
    }
    optionalStorage.removeItem(LEGACY_COLLAPSED_STORAGE_KEY);
  }, []);

  const publishCameraEntry = useCallback((
    entry: CameraHistoryEntry,
    behavior: FocusBehavior = "cut",
  ) => {
    cameraEntryRef.current = entry;
    setCameraRestoreBehavior(behavior);
    setCameraEntryState(entry);
    setCameraRestoreRevision((current) => current + 1);
  }, []);

  const cameraKey = useCallback((candidate: Route, direction?: MapDirection) => {
    const context = cameraContextRef.current;
    return cameraKeyForRoute(
      candidate,
      context.documentId,
      direction ?? context.mapDirection,
    );
  }, []);

  /**
   * The latest camera lives in refs while it moves. A history write happens only at a settled
   * frame or immediately before navigation, so pan/zoom never rerenders App or mutates browser
   * history once per animation frame.
   */
  const persistActiveCamera = useCallback(() => {
    const active = activeCameraRef.current;
    if (!active || active.key !== activeCameraKeyRef.current) return;
    cameraCacheRef.current.set(active.key, active.viewport);
    const current = cameraHistoryEntry(window.history.state) ?? cameraEntryRef.current;
    const entry: CameraHistoryEntry = {
      version: 1,
      id: current?.id ?? createCameraHistoryId(),
      key: active.key,
      viewport: active.viewport,
    };
    window.history.replaceState(
      withCameraHistoryEntry(window.history.state, entry),
      "",
      currentUrl(),
    );
    // Keep the imperative copy current without rerendering on every camera commit. Popstate or a
    // view change publishes the entry to React when CanvasStage actually needs to restore it.
    cameraEntryRef.current = entry;
  }, []);

  const requestFocus = useCallback((
    target: FocusTarget | undefined,
    behavior: FocusBehavior,
    options?: { preserveMapContent?: boolean },
  ) => {
    focusSeq.current += 1;
    setFocusRequest(target ? {
      ...target,
      key: focusSeq.current,
      behavior,
      ...(options?.preserveMapContent ? { preserveMapContent: true } : {}),
    } : undefined);
  }, []);

  const requestCanvasFit = useCallback((canvas: CanvasView) => {
    // Screens is a page, not a canvas: only the map has a projection to fit.
    if (canvas === "map") setMapProjectionFitKey((current) => current + 1);
  }, []);

  /**
   * Moves the viewer: writes the next route to the address bar, then to state. Works off refs so
   * the handlers handed to the canvases stay stable — their layouts are memoised on them. Every
   * move settles the pending focus, so a deep link's landing never replays on a later canvas.
   */
  const navigate = useCallback((
    patch: Partial<Route>,
    options: NavigateOptions = {},
  ): NavigateResult => {
    persistActiveCamera();
    const ctx = contextRef.current;
    const next = viewerRoute(canonicalRoute({ ...routeRef.current, ...patch }, ctx));
    const url = formatViewerRoute(next, ctx);
    const previousCameraKey = activeCameraKeyRef.current;
    const nextCameraKey = cameraKey(next);
    const sameCanvasSemanticMove = routeRef.current.canvas === next.canvas
      && semanticCameraTargetKey(routeRef.current, ctx) !== semanticCameraTargetKey(next, ctx);
    const projectionOwnsCamera = routeUsesProjectionFitCamera(next)
      && nextCameraKey !== previousCameraKey;
    const currentHistoryEntry = cameraHistoryEntry(window.history.state) ?? cameraEntryRef.current;
    const sameHistoryEntry = url === currentUrl() && (Boolean(REPORT_SOURCE.data) || !window.location.hash);
    if (options.resetCamera || projectionOwnsCamera) cameraCacheRef.current.delete(nextCameraKey);
    let nextViewport = options.resetCamera || projectionOwnsCamera || sameCanvasSemanticMove
      ? undefined
      : cameraCacheRef.current.get(nextCameraKey);
    // A replace-style canonicalisation is still the same visible place. When only its stable
    // identity changes (for example an unresolved branch becomes concrete), carry the current
    // camera across instead of introducing an unnecessary fit.
    if (
      !nextViewport
      && options.replace
      && !options.resetCamera
      && routeRef.current.canvas === next.canvas
      && activeCameraRef.current
    ) {
      nextViewport = activeCameraRef.current.viewport;
      cameraCacheRef.current.set(nextCameraKey, nextViewport);
    }
    // A focus within the current canvas document is the camera command for the new entry. Do not
    // stamp that entry with the camera from just before the command: an immediate reload would
    // treat the stale snapshot as authoritative and suppress the route-backed focus. The focus
    // lifecycle's phase:end persists its actual target; until then, a reload correctly derives
    // the camera from the URL selection.
    if (options.focus && nextCameraKey === previousCameraKey) nextViewport = undefined;
    const nextCameraEntry: CameraHistoryEntry = {
      version: 1,
      id: options.replace || sameHistoryEntry
        ? currentHistoryEntry?.id ?? createCameraHistoryId()
        : createCameraHistoryId(),
      key: nextCameraKey,
      ...(nextViewport ? { viewport: nextViewport } : {}),
    };
    const nextHistoryState = withCameraHistoryEntry(
      options.replace ? window.history.state : null,
      nextCameraEntry,
    );
    const restoredCamera = Boolean(nextViewport && nextCameraKey !== previousCameraKey);
    if (url !== currentUrl() || (!REPORT_SOURCE.data && window.location.hash)) {
      window.history[options.replace ? "replaceState" : "pushState"](
        nextHistoryState,
        "",
        url,
      );
    } else {
      window.history.replaceState(
        withCameraHistoryEntry(window.history.state, nextCameraEntry),
        "",
        url,
      );
    }
    if (nextCameraKey !== previousCameraKey) {
      publishCameraEntry(
        nextCameraEntry,
        next.canvas === routeRef.current.canvas ? "fly" : "cut",
      );
    } else {
      // A screen selection is a new history entry but not a camera restore. Publishing its
      // new id to CanvasStage would let restore arbitration consume the focus flight requested by
      // this same navigation. The browser state and imperative ref still receive the entry; React
      // sees it only if Back/Forward later asks to restore it.
      cameraEntryRef.current = nextCameraEntry;
    }
    routeRef.current = next;
    setRoute(next);
    if (!options.preserveFocus) {
      requestFocus(
        restoredCamera ? undefined : options.focus,
        options.behavior ?? preferredBehavior(),
        options.preserveMapContent ? { preserveMapContent: true } : undefined,
      );
    }
    return { next, cameraEntry: nextCameraEntry, restoredCamera };
  }, [cameraKey, persistActiveCamera, publishCameraEntry, requestFocus]);

  // Back and forward step through semantic destinations the viewer wrote. Like a cold deep link,
  // each destination derives a fresh centred camera from its selection or projection instead of
  // restoring an arbitrary pan/zoom that was captured under an older visible frame.
  useEffect(() => {
    const onPopState = () => {
      const ctx = contextRef.current;
      const parsed = viewerRoute(parseLocation(viewerLocation(), ctx));
      const nextCameraKey = cameraKey(parsed);
      const historyCamera = cameraHistoryEntry(window.history.state);
      const nextCameraEntry = cameraHistoryFitEntry(historyCamera, nextCameraKey);
      // `undefined` is an intentional camera-ownership sentinel. It prevents the document cache
      // from outranking the Fit/Focus command published for this same history generation.
      cameraCacheRef.current.delete(nextCameraKey);
      publishCameraEntry(nextCameraEntry, "fly");
      // History destinations get the same deterministic shell as toolbar navigation: the
      // Inspector stays out of the way until a screenshot is selected.
      setRightCollapsed(true);
      routeRef.current = parsed;
      setRoute(parsed);
      const semanticFocus = focusTargetFor(parsed, ctx);
      if (semanticFocus) {
        requestFocus(semanticFocus, preferredBehavior());
      } else {
        requestCanvasFit(parsed.canvas);
        requestFocus(undefined, preferredBehavior());
      }
      const canonical = formatViewerRoute(parsed, ctx);
      if (
        (!REPORT_SOURCE.data && window.location.hash)
        || canonical !== currentUrl()
        || historyCamera?.key !== nextCameraKey
        || historyCamera?.viewport !== undefined
      ) {
        window.history.replaceState(
          withCameraHistoryEntry(window.history.state, nextCameraEntry),
          "",
          canonical,
        );
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [cameraKey, publishCameraEntry, requestCanvasFit, requestFocus]);

  // Panel controls only change shell state. CanvasStage is the single camera owner: it listens to
  // the provider's visible-frame revision and waits for React Flow's measured width before fitting.

  // The Inspector is route-derived on every cold load (open when a screen is selected, out of
  // the way otherwise), so its toggle is session-local and writes nothing.
  const toggleRightPanel = useCallback(() => {
    if (!rightCollapsedRef.current) inspectorDismissedRef.current = true;
    setRightCollapsed((current) => !current);
  }, []);

  // Every canvas opens with the panel showing and the Inspector out of the way.
  // The sidebar keeps whatever state the reader gave it; only the Inspector closes, because a
  // new view has no selection to inspect.
  const applyCanvasPanelDefaults = useCallback(() => {
    setRightCollapsed(true);
  }, []);

  // Every canvas starts with the Inspector closed; selecting a screenshot opens the Inspector on
  // demand. A peer canvas is a fresh inventory, so a screen selection never travels with the reader
  // into the destination view.
  const commitCanvasSelection = useCallback((canvas: CanvasView) => {
    const current = routeRef.current;
    if (canvas === "compare") {
      // Compare always shows one changed screen: the selected one when it changed, else the first.
      const order = compareOrderRef.current;
      const selected = resolveScreenId(current, contextRef.current);
      const start = order.find((entry) => entry.id === selected) ?? order[0];
      setRightCollapsed(true);
      navigate({
        canvas,
        screen: start?.id,
        screenRoute: undefined,
        variant: undefined,
      });
      return;
    }
    const entersMapRoot = canvas === "map" && current.canvas !== "map";
    applyCanvasPanelDefaults();
    const clearedCanvasSelection = {
      screen: undefined,
      screenRoute: undefined,
      variant: undefined,
    } satisfies Partial<Route>;
    navigate(
      entersMapRoot ? {
        canvas,
        ...clearedCanvasSelection,
        expandedGroups: [],
      } : {
        canvas,
        ...clearedCanvasSelection,
      },
    );
  }, [applyCanvasPanelDefaults, navigate]);

  // The logo returns to the Map root, the equivalent of the "/map" URL.
  const openMapHome = useCallback(() => {
    applyCanvasPanelDefaults();
    const result = navigate({
      canvas: "map",
      screen: undefined,
      screenRoute: undefined,
      variant: undefined,
      expandedGroups: [],
    });
    if (!result.restoredCamera) requestCanvasFit("map");
  }, [applyCanvasPanelDefaults, navigate, requestCanvasFit]);

  const selectCanvas = useCallback((canvas: CanvasView) => {
    const direction = canvasViewTransitionDirection(routeRef.current.canvas, canvas);
    if (!direction) return;
    if (typeof document.startViewTransition !== "function") {
      commitCanvasSelection(canvas);
      return;
    }

    canvasViewTransitionRef.current?.skipTransition();
    // Panel width changes must settle before the browser captures the outgoing canvas. If they
    // happen inside the transition update, the named canvas snapshot interpolates between two
    // different rectangles and looks like it zooms instead of sliding.
    flushSync(() => applyCanvasPanelDefaults());
    document.documentElement.dataset.canvasTransitionDirection = direction;
    // The browser pauses rendering while this callback runs. Keep it synchronous: waiting for a
    // paint/RAF here deadlocks until the View Transition timeout and silently skips the motion.
    let transition: ViewTransition;
    try {
      transition = document.startViewTransition(() => {
        flushSync(() => commitCanvasSelection(canvas));
      });
    } catch {
      flushSync(() => commitCanvasSelection(canvas));
      delete document.documentElement.dataset.canvasTransitionDirection;
      return;
    }
    canvasViewTransitionRef.current = transition;

    const clearTransition = () => {
      if (canvasViewTransitionRef.current !== transition) return;
      canvasViewTransitionRef.current = undefined;
      delete document.documentElement.dataset.canvasTransitionDirection;
    };
    void transition.finished.then(clearTransition, clearTransition);
  }, [applyCanvasPanelDefaults, commitCanvasSelection]);

  const clearSelectedScreen = useCallback(() => {
    if (!resolveScreenId(routeRef.current, contextRef.current)) return;
    setRightCollapsed(true);
    const result = navigate({
      screen: undefined,
      screenRoute: undefined,
      variant: undefined,
    });
    // Leaving a screen returns to the whole projection. The projection itself is
    // unchanged, so explicitly refit it instead of leaving the camera parked on the old screen.
    if (!result.restoredCamera) requestCanvasFit(routeRef.current.canvas);
  }, [navigate, requestCanvasFit]);
  // The shell's shortcuts: rail sections open only the left panel; each side has an independent
  // toggle. Canvas shortcuts use the same view-specific panel defaults as the toolbar.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, SHORTCUTS.app.search)) {
        event.preventDefault();
        if (event.repeat || searchOpen || modalOpen()) return;
        setSearchOpen(true);
        return;
      }
      if (!shortcutsLive(event)) return;
      // Esc backs out one step: it closes the Inspector, and with the Inspector already closed it
      // deselects the screen. Something else may have used it first (a selected area, a menu, a
      // popover); those listeners may run after this one, so decide once the event is done.
      if (event.key === "Escape") {
        if (routeRef.current.canvas === "compare") return;
        if (rightCollapsedRef.current) {
          if (!resolveScreenId(routeRef.current, contextRef.current)) return;
          setTimeout(() => {
            if (!event.defaultPrevented) clearSelectedScreen();
          }, 0);
          return;
        }
        setTimeout(() => {
          if (event.defaultPrevented) return;
          inspectorDismissedRef.current = true;
          setRightCollapsed(true);
        }, 0);
        return;
      }
      // "?" is a character, not a key position; read it from the layout. It works everywhere.
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (matchesShortcut(event, SHORTCUTS.app.handoff)) {
        if (!handoffAvailableRef.current) return;
        setHandoffOpen(true);
      } else if (matchesShortcut(event, SHORTCUTS.app.changes)) {
        setChangesOpen((open) => !open);
      } else if (matchesShortcut(event, SHORTCUTS.panel.right)) {
        toggleRightPanel();
      } else {
        const canvas = CANVAS_KEYS.find(([, shortcut]) => matchesShortcut(event, shortcut));
        if (!canvas) return;
        selectCanvas(canvas[0]);
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clearSelectedScreen, navigate, searchOpen, selectCanvas, toggleRightPanel]);

  // A side-panel row or a deep link is a "go to": the camera fits that screen and the step is
  // kept. Screens inventory clicks only select in place; Map clicks also focus the chosen screen. Repeating a selected target refits it without adding history.
  // Landing on another screen opens its Session view: the right panel is about the screen in
  // front of the reader, not about the tab they happened to leave open on the last one.
  const screenPatch = useCallback((id: string, variantId?: string): Partial<Route> => {
    if (variantId) return { screen: id, inspect: "session", variant: variantId };
    return resolveScreenId(routeRef.current, contextRef.current) === id
      ? { screen: id }
      : { screen: id, inspect: "session", variant: undefined };
  }, []);

  const selectScreenOnCanvas = useCallback(
    (id: string, variantId?: string) => {
      const currentScreenId = resolveScreenId(routeRef.current, contextRef.current);
      const sameSelection = currentScreenId === id
        && (routeRef.current.variant ?? undefined) === (variantId ?? undefined);
      setRightCollapsed(false);
      navigate(screenPatch(id, variantId), {
        replace: sameSelection,
        focus: { target: "screen", id },
      });
    },
    [navigate, screenPatch],
  );
  /** A screen picked in place (the Screens tree): its selection leaves the Inspector as it was. */
  const pickedInPlaceRef = useRef<string | undefined>(undefined);
  // The Screens tree and jump bar pick a screen in place: it is selected and scrolled to, and the
  // Inspector stays as it was. A click on the screenshot, or I, opens it.
  const pickScreenInPlace = useCallback((id: string) => {
    const sameSelection = resolveScreenId(routeRef.current, contextRef.current) === id;
    if (!sameSelection) pickedInPlaceRef.current = id;
    navigate(screenPatch(id), { replace: sameSelection, focus: { target: "screen", id } });
  }, [navigate, screenPatch]);
  // On a phone the Inspector covers the map, so a tap selects the screen first (its ring, its
  // connections, the Open hint) and only a second tap on the selected screen opens it.
  const phoneSelectOnlyRef = useRef<string | undefined>(undefined);
  const selectScreenOnMap = useCallback(
    (id: string, options?: { replace?: boolean }) => {
      const alreadySelected = resolveScreenId(routeRef.current, contextRef.current) === id;
      if (phoneRef.current && !alreadySelected) phoneSelectOnlyRef.current = id;
      else setRightCollapsed(false);
      if (alreadySelected) return;
      navigate(
        screenPatch(id),
        {
          replace: alreadySelected || options?.replace === true,
          focus: { target: "screen", id },
        },
      );
    },
    [navigate, screenPatch],
  );
  const selectSearchScreen = useCallback((screenId: string) => {
    applyCanvasPanelDefaults();
    // On a phone the Inspector would cover the Screens page the pick is meant to show, so the
    // pick is in place there, like the Screens tree; a tap on the screenshot opens the Inspector.
    if (phoneRef.current && resolveScreenId(routeRef.current, contextRef.current) !== screenId) pickedInPlaceRef.current = screenId;
    setPendingSearchFocus({
      canvas: "screens",
      target: { target: "screen", id: screenId },
    });
    navigate({
      canvas: "screens",
      ...screenPatch(screenId),
      expandedGroups: [],
    }, {
      resetCamera: true,
    });
  }, [applyCanvasPanelDefaults, navigate, screenPatch]);
  // Following a row inside the inspector is the exception: a transition or changed screen is
  // read from a view the reader chose, and landing somewhere new is no
  // reason to close it. The panel stays where it was and only its subject changes.
  const goToScreenKeepingView = useCallback(
    (id: string) => navigate({ screen: id, variant: undefined }, { focus: { target: "screen", id } }),
    [navigate],
  );
  const standalone = useMemo(() => standaloneBuild(payload), [payload]);
  const builds = useMemo(() => {
    if (!workspace) return standalone ? [standalone] : [];
    const visibleIds = new Set([
      workspace.catalog.currentBuildId,
      workspace.catalog.defaultBaselineBuildId,
    ]);
    return workspace.catalog.builds.filter((build) => visibleIds.has(build.id));
  }, [standalone, workspace]);
  const currentBuild = workspace
    ? builds.find((build) => build.id === workspace.catalog.currentBuildId)
    : builds[0];
  const baseline = builds.find((build) => build.id === route.baseline);
  const appearances = useMemo(() => appearanceOptions(payload?.map), [payload]);
  const appearance = appearanceChoice && appearances.includes(appearanceChoice) ? appearanceChoice : appearances[0];
  const appearanceMap = useMemo(() => payload ? filterMapAppearance(payload.map, appearance) : undefined, [appearance, payload]);
  const currentMap = useMemo(() => (
    appearanceMap && workspace && currentBuild
      ? scopeMapArtifacts(appearanceMap, currentBuild.id)
      : appearanceMap
  ), [appearanceMap, currentBuild, workspace]);
  const baselinePayload = workspace && baseline ? workspace.builds[baseline.id] : undefined;
  // The comparison and the review name every appearance's surfaces; in one appearance they are keyed by route.
  const scope = useMemo(() => appearanceScope([payload?.map, baselinePayload?.map], appearance), [appearance, baselinePayload, payload]);
  const comparison = useMemo(() => {
    const whole = workspace && currentBuild && baseline ? comparisonFor(workspace, currentBuild.id, baseline.id) : undefined;
    return whole ? filterComparisonAppearance(whole, scope) : undefined;
  }, [baseline, currentBuild, scope, workspace]);
  const review = useMemo(() => {
    const whole = loadedPublicReview ? publicReviewProjection(loadedPublicReview) : reviewProjectionFromWorkspace(workspace);
    return whole ? filterReviewAppearance(whole, scope) : undefined;
  }, [loadedPublicReview, scope, workspace]);
  // A reviewed comparison augments the current map only with real baseline-only screens.
  const sourceDiff = useMemo(
    () => (
      appearanceMap && currentBuild && baseline && baselinePayload && comparison
        ? buildDiff({
          currentBuild,
          currentMap: appearanceMap,
          baselineBuild: baseline,
          baselineMap: filterMapAppearance(baselinePayload.map, appearance),
          comparison,
          ...(review ? { review } : {}),
        })
        : undefined
    ),
    [appearance, appearanceMap, baseline, baselinePayload, comparison, currentBuild, review],
  );
  const reviewedMap = sourceDiff?.map ?? currentMap;
  const screenPresentation = useMemo(
    () => (reviewedMap ? presentScreensByPath(reviewedMap) : undefined),
    [reviewedMap],
  );
  const diff = useMemo(
    () => (sourceDiff && screenPresentation
      ? presentBuildDiff(sourceDiff, screenPresentation)
      : undefined),
    [screenPresentation, sourceDiff],
  );
  // The Screens page says which screens changed in an appearance other than the one shown.
  const changedElsewhere = useMemo(() => {
    const other = appearances.filter((option) => option !== appearance);
    if (!other.length || !payload || !currentBuild || !baseline || !baselinePayload || !workspace) return undefined;
    const wholeComparison = comparisonFor(workspace, currentBuild.id, baseline.id);
    const wholeReview = loadedPublicReview ? publicReviewProjection(loadedPublicReview) : reviewProjectionFromWorkspace(workspace);
    if (!wholeComparison) return undefined;
    const changed = new Map<string, Appearance[]>();
    for (const option of other) {
      const otherScope = appearanceScope([payload.map, baselinePayload.map], option);
      const otherDiff = buildDiff({
        currentBuild,
        currentMap: filterMapAppearance(payload.map, option),
        baselineBuild: baseline,
        baselineMap: filterMapAppearance(baselinePayload.map, option),
        comparison: filterComparisonAppearance(wholeComparison, otherScope),
        ...(wholeReview ? { review: filterReviewAppearance(wholeReview, otherScope) } : {}),
      });
      const presented = presentBuildDiff(otherDiff, presentScreensByPath(otherDiff.map));
      for (const [id, entry] of presented.screens) {
        if (["modified", "added", "removed"].includes(entry.status)) changed.set(id, [...(changed.get(id) ?? []), option]);
      }
    }
    return changed;
  }, [appearance, appearances, baseline, baselinePayload, currentBuild, loadedPublicReview, payload, workspace]);
  // The route file of each surface, when the review read the source: Screens groups by them.
  const routeFiles = useMemo(() => new Map(
    Object.entries(review?.surfaces ?? {}).flatMap(([id, surface]) => (surface.routeFile ? [[id, surface.routeFile] as const] : [])),
  ), [review]);
  const presentedMap = screenPresentation?.map;
  // The map keeps its capture-specific name in provenance. A build catalog owns the viewer
  // workspace label, so source dates and duplicate build text do not leak into comparison UI.
  const map = useMemo(() => (
    presentedMap && workspace
      ? { ...presentedMap, run: { ...presentedMap.run, name: workspace.catalog.name } }
      : presentedMap
  ), [presentedMap, workspace]);
  // Focus singles out diff states, so it means nothing without a baseline to diff against.
  const focusFilter = diff ? route.focus : [];
  const focusCounts = useMemo(() => countFocusStatuses(diff), [diff]);
  const index = diff?.index ?? screenPresentation?.index;
  const compareOrder = useMemo(
    () => (diff && index ? changedScreens(diff, index).filter(entry => isCapturedChange(diff.screens.get(entry.id))) : []),
    [diff, index],
  );
  compareOrderRef.current = compareOrder;
  const blackBox = Boolean(map && isBlackBoxMap(map));
  blackBoxRef.current = blackBox;
  // Compare always opens; with nothing to show it says why.
  const compareEmptyReason = compareOrder.length > 0 ? undefined
    : blackBox ? "An exploration run has no baseline build to compare against."
    : !baseline ? "This report has no baseline build to compare against."
    : !diff ? "The baseline is still loading."
    : "No screen looks different from the baseline.";
  const searchIndex = useMemo(
    () => map ? buildSearchItems({ screens: map.screens }) : [],
    [map],
  );
  const openChangedScreen = useCallback((screenId: string) => {
    const current = routeRef.current;
    const currentScreenId = resolveScreenId(current, contextRef.current);
    setRightCollapsed(false);

    if (current.canvas === "map") {
      setPendingSearchFocus({
        canvas: "map",
        target: { target: "screen", id: screenId },
      });
      navigate({
        canvas: "map",
        ...screenPatch(screenId),
        expandedGroups: [],
      }, {
        resetCamera: true,
      });
      return;
    }

    navigate({
      ...screenPatch(screenId),
    }, {
      replace: currentScreenId === screenId,
      focus: { target: "screen", id: screenId },
    });
  }, [navigate, screenPatch]);

  const buildRouteContext = useMemo(
    () => routeContextForCatalog(workspace?.catalog),
    [workspace?.catalog],
  );
  const screenAliases = useMemo(() => {
    if (!reviewedMap || !screenPresentation) return undefined;
    return screenAliasesForPresentation(
      reviewedMap,
      screenPresentation,
      currentMap ? deriveCaptureRouteAliases(currentMap) : new Map(),
    );
  }, [currentMap, reviewedMap, screenPresentation]);
  const routeContext = useMemo<RouteContext>(
    () => (map ? {
      ...buildRouteContext,
      screenRoutes: screenRoutesOf(map.screens),
      screenVariants: screenVariantsOf(map.screens),
      ...(screenAliases ? {
        screenIdAliases: screenAliases.screenIdAliases,
        screenIdAliasVariants: screenAliases.screenIdAliasVariants,
        screenRouteAliases: screenAliases.screenRouteAliases,
      } : {}),
    } : { ...buildRouteContext, screenRoutes: new Map() }),
    [buildRouteContext, map, screenAliases],
  );
  contextRef.current = routeContext;
  const cameraDocumentId = currentBuild?.id ?? map?.run.id ?? payload?.map.run.id ?? "loading";
  const activeCameraKey = useMemo(
    () => cameraKeyForRoute(route, cameraDocumentId, mapDirection),
    [cameraDocumentId, mapDirection, route],
  );
  cameraContextRef.current = { documentId: cameraDocumentId, mapDirection };
  activeCameraKeyRef.current = activeCameraKey;
  if (activeCameraRef.current?.key !== activeCameraKey) activeCameraRef.current = undefined;

  const handleCanvasViewportChange = useCallback((event: CanvasViewportChangeEvent) => {
    const viewport: CameraViewport = {
      x: event.x,
      y: event.y,
      zoom: event.zoom,
      center: { ...event.center },
    };
    cameraCacheRef.current.set(activeCameraKey, viewport);
    activeCameraRef.current = { key: activeCameraKey, viewport };
    if (event.phase === "end") persistActiveCamera();
  }, [activeCameraKey, persistActiveCamera]);

  const projectionOwnsActiveCamera = routeUsesProjectionFitCamera(route);
  const initialCanvasViewport = !landed.current
    ? undefined
    : cameraEntry?.key === activeCameraKey
      // A matching history generation with no viewport deliberately delegates to Fit/Focus.
      // Falling through to the document cache here would make that stale camera outrank the
      // focus command created by the same click.
      ? cameraEntry.viewport
      : projectionOwnsActiveCamera
        ? undefined
        : cameraCacheRef.current.get(activeCameraKey);
  const canvasViewportIdentity = initialCanvasViewport
    ? `${cameraEntry?.id ?? "cache"}:${activeCameraKey}:${cameraRestoreRevision}`
    : undefined;

  // The address bar always shows the route in its current form — "/" becomes "/map", a legacy
  // hash becomes a path, an id gains its expo-router route once the map says what it is — and
  // never as a new history entry. The first time the map is known, the canvas is asked to land
  // on whatever the link named.
  useEffect(() => {
    // A workspace supplies the valid baseline ids asynchronously. Formatting against the empty
    // bootstrap context would erase a comparison link before `/api/workspace` can reparse it.
    if (!index) return;
    const url = formatViewerRoute(route, routeContext);
    const stored = cameraHistoryEntry(window.history.state);
    const projectionOwnsCamera = projectionOwnsActiveCamera;
    const opening = !landed.current;
    if (opening || projectionOwnsCamera) cameraCacheRef.current.delete(activeCameraKey);
    const viewport = opening || projectionOwnsCamera
      ? undefined
      : stored?.key === activeCameraKey
        ? stored.viewport
        : cameraCacheRef.current.get(activeCameraKey);
    const normalizedCameraEntry: CameraHistoryEntry = {
      version: 1,
      id: stored?.id ?? cameraEntryRef.current?.id ?? createCameraHistoryId(),
      key: activeCameraKey,
      ...(viewport ? { viewport } : {}),
    };
    if (
      url !== currentUrl()
      || (!REPORT_SOURCE.data && window.location.hash)
      || stored?.key !== activeCameraKey
      || (opening && stored?.viewport !== undefined)
    ) {
      window.history.replaceState(
        withCameraHistoryEntry(window.history.state, normalizedCameraEntry),
        "",
        url,
      );
    }
    if (
      cameraEntryRef.current?.id !== normalizedCameraEntry.id
      || cameraEntryRef.current?.key !== normalizedCameraEntry.key
      || (opening && cameraEntryRef.current?.viewport !== undefined)
    ) publishCameraEntry(normalizedCameraEntry, "cut");
    if (landed.current) return;
    landed.current = true;
    // CanvasStage already owns the opening fit. Sending the overview projection another fit key
    // here starts a second animated camera pass immediately after the fitted frame is revealed,
    // which makes the area grid appear to fly in from the top-left on a cold load.
    requestFocus(focusTargetFor(route, routeContext), "cut");
  }, [activeCameraKey, index, projectionOwnsActiveCamera, publishCameraEntry, requestFocus, route, routeContext]);

  // The route may name a screen the map does not have — yet, for a live exploration,
  // or at all for a stale link. It stays in the URL and simply selects nothing until it does.
  const selectedScreenId = useMemo(() => {
    const id = resolveScreenId(route, routeContext);
    return id && index?.screens.has(id) ? id : undefined;
  }, [index, route, routeContext]);
  // The tab names the report: "Settings · euxy · iOS · Explore" with a screen selected, "euxy · iOS · Explore" without.
  // Its icon is the app's own when the report carries one, else the Expo mark index.html ships.
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    const fallback = icon?.dataset.fallback ?? icon?.getAttribute("href") ?? "";
    if (icon && !icon.dataset.fallback) icon.dataset.fallback = fallback;
    if (!map || !index) {
      document.title = "Expo Explore";
      icon?.setAttribute("href", fallback);
      return;
    }
    const platform = PLATFORM_NAMES[map.run.platform] ?? map.run.platform;
    const screen = selectedScreenId ? index.screens.get(selectedScreenId) : undefined;
    document.title = [screen ? screenLabel(screen, index) : undefined, map.run.name, platform, "Explore"].filter(Boolean).join(" · ");
    const appIcon = artifactUrl(map.run.appIcon);
    if (!appIcon || !isEmbeddedArtifactUrl(appIcon)) {
      icon?.setAttribute("href", appIcon ?? fallback);
      return;
    }
    // A report ZIP's icon is a reference the browser cannot load: the tab holds its Blob URL while it shows.
    let state: "pending" | "shown" | "gone" = "pending";
    resolveEmbeddedArtifactUrl(appIcon, "eager").then(
      (url) => {
        if (state === "gone") return void releaseEmbeddedArtifactUrl(appIcon);
        state = "shown";
        icon?.setAttribute("href", url);
      },
      () => icon?.setAttribute("href", fallback),
    );
    return () => {
      if (state === "shown") releaseEmbeddedArtifactUrl(appIcon);
      state = "gone";
    };
  }, [index, map, selectedScreenId]);
  useEffect(() => {
    if (!index) return;
    const previousScreenId = previousSelectedScreenIdRef.current;
    previousSelectedScreenIdRef.current = selectedScreenId;
    if (selectedScreenId && selectedScreenId === pickedInPlaceRef.current) {
      pickedInPlaceRef.current = undefined;
    } else if (selectedScreenId && selectedScreenId === phoneSelectOnlyRef.current) {
      phoneSelectOnlyRef.current = undefined;
      setRightCollapsed(true);
    } else if (selectedScreenId && selectedScreenId !== previousScreenId) {
      setRightCollapsed(false);
    } else if (!selectedScreenId && previousScreenId) {
      setRightCollapsed(true);
    }
  }, [index, selectedScreenId]);
  // Opening the Inspector again ends a dismissal.
  useEffect(() => {
    if (!rightCollapsed) inspectorDismissedRef.current = false;
  }, [rightCollapsed]);
  // Compare always shows a changed screen. A link to an unchanged one, or to /compare with no
  // screen, settles on the first change in review order without adding a history entry.
  useEffect(() => {
    if (!diff || route.canvas !== "compare") return;
    if (selectedScreenId && compareOrder.some((entry) => entry.id === selectedScreenId)) return;
    const first = compareOrder[0];
    if (!first) return;
    navigate({ screen: first.id, screenRoute: undefined, variant: undefined }, { replace: true });
  }, [compareOrder, diff, navigate, route.canvas, selectedScreenId]);
  // A changed screen in the Inspector shows the sidebar review, which answers to Compare's keys.
  const reviewingInSidebar = route.canvas !== "compare" && !rightCollapsed && selectedScreenId !== undefined
    && compareOrder.some((entry) => entry.id === selectedScreenId);

  // A search can replace the entire canvas document. Let that destination mount first, then
  // publish its focus in a layout effect: CanvasStage sees the target before its opening fit RAF
  // and gives the selected screen sole ownership of this camera generation.
  useLayoutEffect(() => {
    if (!pendingSearchFocus || route.canvas !== pendingSearchFocus.canvas) return;
    const targetReady = selectedScreenId === pendingSearchFocus.target.id;
    if (!targetReady) return;
    requestFocus(pendingSearchFocus.target, preferredBehavior());
    setPendingSearchFocus(undefined);
  }, [pendingSearchFocus, requestFocus, route.canvas, selectedScreenId]);

  const searchSuggestions = useMemo(() => suggestedSearchItems(searchIndex, {
    ...(selectedScreenId ? { screenId: selectedScreenId } : {}),
  }), [searchIndex, selectedScreenId]);

  if (!payload && error) {
    if (REPORT_SOURCE.data) return <ReportLoadingShell progress={REPORT_SOURCE.progress} error={error}
      {...(REPORT_SOURCE.identity ? { identity: REPORT_SOURCE.identity } : {})}
      {...(REPORT_SOURCE.workflowUrl ? { workflowUrl: REPORT_SOURCE.workflowUrl } : {})}
      onRetry={() => void load()} />;
    return (
      <main className="centered-state">
        <div className="state-icon state-icon-danger"><AlertCircle size={22} /></div>
        <h1>Couldn’t open this map</h1>
        <p>{error}</p>
        <button className="button button-primary" onClick={() => void load()}>
          <RefreshCw size={15} /> Try again
        </button>
      </main>
    );
  }

  if (
    !payload
    || !map
    || !index
  ) {
    if (REPORT_SOURCE.data) return <ReportLoadingShell progress={{ ...REPORT_SOURCE.progress, phase: "opening" }}
      {...(REPORT_SOURCE.identity ? { identity: REPORT_SOURCE.identity } : {})}
      {...(REPORT_SOURCE.workflowUrl ? { workflowUrl: REPORT_SOURCE.workflowUrl } : {})}
      onRetry={() => void load()} />;
    return (
      <AppLoading label="Loading exploration map" />
    );
  }

  const selectedScreen = selectedScreenId ? index.screens.get(selectedScreenId) : undefined;
  const selectedVariantId = route.variant && selectedScreen?.variantIds.includes(route.variant)
    ? route.variant
    : undefined;
  // "Review all" opens Compare on the selected screen when it is a change, otherwise on the
  // first change in review order.
  const reviewAllChanges = () => selectCanvas("compare");
  const comparing = route.canvas === "compare";
  // Compare with nothing to show behaves like any other canvas: the chrome stays and the view says why.
  const compareEmpty = comparing && compareOrder.length === 0;
  const comparingScreens = comparing && !compareEmpty;

  const comparePicker = diff && selectedScreenId ? {
    diff,
    index,
    selectedScreenId,
    focus: focusFilter,
    focusCounts,
    onChangeFocus: (focus: Route["focus"]) => navigate({ focus }, { replace: true }),
    onOpenChangedScreen: openChangedScreen,
    open: changesOpen,
    onOpenChange: setChangesOpen,
  } : undefined;

  // A hosted preview, or a local review's Viewer, serves an agent-readable index of this report, so it can be handed to an agent.
  const handoffUrl = typeof window === "undefined" ? undefined : handoffPageUrl(new URL(window.location.href));
  const handoffInput = handoffUrl ? {
    pageUrl: handoffUrl,
    appName: map.run.name,
    pullRequest: review?.pullRequest,
    appearances: appearances.map(appearanceLabel),
  } : undefined;
  const handoffView = {
    view: CANVAS_LABELS[route.canvas],
    platform: PLATFORM_NAMES[map.run.platform] ?? map.run.platform,
    ...(appearances.length > 1 && appearance ? { appearance: appearanceLabel(appearance) } : {}),
    ...(selectedScreen ? { screen: screenLabel(selectedScreen, index) } : {}),
  };
  const openHandoff = () => setHandoffOpen(true);
  handoffAvailableRef.current = Boolean(handoffInput);
  const handoffAction = handoffInput ? <HandoffButton {...(phone ? { className: "collapsed-search" } : { tooltip: true })} onOpen={openHandoff} /> : null;

  const viewer = (
    <>
    <div className={`app-shell${phone ? " phone-layout" : ""}`}>
      {phone && comparingScreens ? null : <AppPill
        {...(phone ? { trailing: handoffAction, onOpenSearch: () => setSearchOpen(true) } : {})}
        map={map}
        index={index}
        {...(selectedScreenId ? { selectedScreenId } : {})}
        {...(review?.pullRequest ? { pullRequest: review.pullRequest } : {})}
        {...(appearances.length > 1 && appearance ? { appearance: { current: appearance, options: appearances, onChange: setAppearanceChoice } } : {})}
        focus={focusFilter}
        focusCounts={focusCounts}
        {...(diff ? { diff } : {})}
        changesOpen={changesOpen}
        onChangesOpen={setChangesOpen}
        onChangeFocus={(focus) => navigate({ focus }, { replace: true })}
        onOpenChangedScreen={openChangedScreen}
        onReviewAll={reviewAllChanges}
        onOpenMap={openMapHome}
        hideChanges={route.canvas === "compare"}
      />}
      <CanvasVisibleFrameProvider
        layoutKey={`${rightCollapsed}:${route.canvas}:${route.inspect}`}>
        <div className="canvas-view-content" data-canvas-view={route.canvas}>
          {route.canvas === "screens" ? (
            <ScreensView
              map={map}
              index={index}
              diff={diff}
              routeFiles={routeFiles}
              changedElsewhere={changedElsewhere}
              selectedScreenId={selectedScreenId}
              {...(focusRequest ? { focusRequest } : {})}
              focus={focusFilter}
              phone={phone}
              onSelectScreen={selectScreenOnCanvas}
              onPickScreen={pickScreenInPlace}
              onClearSelection={clearSelectedScreen}
            />
          ) : null}
          {comparing && phone && diff && selectedScreenId && comparePicker ? (
            <PhoneCompare
              diff={diff}
              index={index}
              screenId={selectedScreenId}
              order={compareOrder}
              onSelectScreen={goToScreenKeepingView}
              picker={comparePicker}
              headerAction={handoffInput ? <HandoffButton className="phone-icon-button" onOpen={openHandoff} /> : null}
            />
          ) : null}
          {compareEmpty ? (
            <div className="graph-canvas canvas-empty">
              <div className="page-empty compact-empty map-empty">
                <h2>Nothing to compare</h2>
                <p>{compareEmptyReason}</p>
              </div>
            </div>
          ) : null}
          {comparing && !phone && diff && index && selectedScreenId && comparePicker ? (
            <CompareSection
              diff={diff}
              index={index}
              screenId={selectedScreenId}
              order={compareOrder}
              onSelectScreen={goToScreenKeepingView}
              picker={comparePicker}
            />
          ) : null}
          {route.canvas === "map" && (
            <MapView
              map={map}
              index={index}
              {...(initialCanvasViewport ? { initialViewport: initialCanvasViewport } : {})}
              {...(canvasViewportIdentity ? { viewportIdentity: canvasViewportIdentity } : {})}
              restoreViewportBehavior={cameraRestoreBehavior}
              onViewportChange={handleCanvasViewportChange}
              direction="TB"
              focus={focusFilter}
              projectionFitKey={mapProjectionFitKey}
              {...(diff ? { diff } : {})}
              {...(selectedScreenId ? { selectedScreenId } : {})}
              {...(focusRequest ? { focusRequest } : {})}
              onSelectScreen={selectScreenOnMap}
              onClearSelection={clearSelectedScreen}
            />
          )}
        </div>
        {phone ? null : (
          <CanvasCameraControls inspectorCollapsed={comparing ? false : rightCollapsed} theme={theme} themePreference={themePreference} onToggleTheme={toggleTheme}
            camera={route.canvas === "map"} />
        )}
        {phone ? (
          <PhoneTabBar
            canvas={route.canvas}
            compareCount={compareOrder.length}
            onSelectCanvas={selectCanvas}
          />
        ) : <CanvasToolbar
          canvas={route.canvas}
          searchOpen={searchOpen}
          compareCount={compareOrder.length}
          {...(handoffAction ? { actions: handoffAction } : {})}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onSelectCanvas={selectCanvas}
          onOpenSearch={() => setSearchOpen(true)}
        />}
      </CanvasVisibleFrameProvider>
      {shortcutsOpen ? (
        <ShortcutsDialog
          context={{ canvas: route.canvas, review: reviewingInSidebar, hasChanges: compareOrder.length > 0, handoff: Boolean(handoffInput) }}
          onClose={() => setShortcutsOpen(false)}
        />
      ) : null}
      {handoffInput ? (
        <HandoffDialog open={handoffOpen} phone={phone} input={handoffInput} view={handoffView}
          onClose={() => setHandoffOpen(false)} />
      ) : null}
      <SearchCommand
        open={searchOpen}
        items={searchIndex}
        suggestions={searchSuggestions}
        onClose={closeSearch}
        onSelectScreen={selectSearchScreen}
      />
      {comparingScreens ? null : <RightPanel
        index={index}
        screen={selectedScreen}
        diff={diff}
        collapsed={rightCollapsed}
        onToggleCollapsed={toggleRightPanel}
        direction={route.direction}
        onChangeDirection={(direction) => navigate({ direction }, { replace: true })}
        selectedVariantId={selectedVariantId}
        onSelectVariant={(variant) => navigate({ variant }, { replace: true })}
        onSelectScreen={goToScreenKeepingView}
        onOpenCompare={compareOrder.length > 0 ? () => selectCanvas("compare") : undefined}
        review={compareOrder.length > 0 ? { order: compareOrder, onSelectScreen: openChangedScreen } : undefined}
      />}
      {error && payload && (
        <button className="sync-warning" onClick={() => void load()}>
          <AlertCircle size={14} /> Couldn’t refresh · Retry
        </button>
      )}
      {createPortal(<Toaster
        position="bottom-center"
        theme={theme}
        offset={phone ? 92 : 88}
        toastOptions={{ className: "app-toast" }}
      />, document.body)}
    </div>
    </>
  );
  return viewer;
}
