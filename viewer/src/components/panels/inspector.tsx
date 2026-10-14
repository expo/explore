import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LAUNCH_SURFACE_ID } from "../../../../src/contracts/capture";
import { isEmbeddedArtifactUrl, resolveEmbeddedArtifactUrl } from "../../utils/embedded-report";
import type { TransitionDirection } from "../../utils/navigation";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ImageOff,
  GitCompareArrows,
  MousePointerClick,
  ZoomIn,
} from "lucide-react";
import { ToggleGroup } from "../shared/toggle-group";
import { Tooltip } from "../shared/tooltip";
import { DEFAULT_SCREENSHOT_RATIO, ScreenshotImage, ScreenshotPlaceholder } from "../shared/screenshot-image";
import { ImageLightbox, type LightboxImage } from "../shared/image-lightbox";
import { copyImageToClipboard } from "../../utils/copy-image";
import type { NavigationEdge } from "../../../../src/contracts/navigation-graph";
import { navigationEdgeKey } from "../../utils/source-navigation";
import {
  DIFF_LABELS,
  type BuildDiff,
  type ScreenDiff,
} from "../../utils/build-diff";
import { placeholderFor, presentedChanges, type PresentedChange } from "../../utils/presented-changes";
import type { ChangedScreen } from "../../utils/changed-screens";
import { SidebarReview, SidebarReviewOff } from "../compare/sidebar-review";
import { ScreenVariantCarousel } from "./screen-variant-carousel";
import { CapturedScreenVariants } from "./captured-screen-variants";
import { ChangeOutlines } from "./visual-diff";
import { groupVisualRegions } from "../../utils/visual-diff";
import {
  artifactUrl,
  screenshotForScreen,
  type Artifact,
  type MapIndex,
  type Screen,
  type Transition,
} from "../../utils/model";
import { displayPathForScreen, screenLabel } from "../../utils/screen-path";

type Direction = TransitionDirection;

const INITIAL_CHANGE_COUNT = 5;

function ScreenshotDiffFrame(props: { children: React.ReactNode }) {
  return (
    <div className="screenshot-diff-frame session-preview-frame">
      {props.children}
    </div>
  );
}

type InspectorTransition = {
  screen: Screen;
  observed: Transition[];
  sources: { edge: NavigationEdge; previous: boolean }[];
};

/** Group navigation destinations for display while retaining each evidence source separately. */
function inspectorTransitions(screenId: string | undefined, index: MapIndex) {
  const directions = { in: new Map<string, InspectorTransition>(), out: new Map<string, InspectorTransition>() };
  const destination = (direction: Direction, targetId: string) => {
    const screen = index.screens.get(targetId);
    if (!screen || targetId === screenId) return undefined;
    let item = directions[direction].get(targetId);
    if (!item) {
      item = { screen, observed: [], sources: [] };
      directions[direction].set(targetId, item);
    }
    return item;
  };
  if (screenId) {
    for (const transition of index.outgoing.get(screenId) ?? []) {
      destination("out", transition.toScreenId)?.observed.push(transition);
    }
    for (const transition of index.incoming.get(screenId) ?? []) {
      destination("in", transition.fromScreenId)?.observed.push(transition);
    }
    const seen = new Set<string>();
    for (const [graph, previous] of [
      [index.sourceNavigation, false], [index.baselineSourceNavigation, true],
    ] as const) {
      for (const edge of graph?.edges ?? []) {
        const key = navigationEdgeKey(edge);
        if (seen.has(key) || !index.screens.has(edge.from) || !index.screens.has(edge.to)) continue;
        seen.add(key);
        if (edge.from === screenId) destination("out", edge.to)?.sources.push({ edge, previous });
        if (edge.to === screenId) destination("in", edge.from)?.sources.push({ edge, previous });
      }
    }
  }
  const sorted = (items: Map<string, InspectorTransition>) => [...items.values()].sort((left, right) => (
    displayPathForScreen(left.screen).localeCompare(displayPathForScreen(right.screen), "en")
    || left.screen.id.localeCompare(right.screen.id, "en")
  ));
  return { incoming: sorted(directions.in), outgoing: sorted(directions.out) };
}

function TransitionRow(props: {
  item: InspectorTransition;
  index: MapIndex;
  diff?: BuildDiff | undefined;
  onSelectScreen: (id: string) => void;
}) {
  const { screen, sources, observed } = props.item;
  const targetId = screen.id;
  const screenshot = artifactUrl(screenshotForScreen(screen, props.index));
  const status = props.diff?.screens.get(targetId)?.status ?? "unchanged";
  const kinds = [...new Set(sources.length
    ? sources.map(({ edge }) => edge.kind)
    : observed.map(transition => transition.actionKind))].sort();
  const descriptions = sources.map(({ edge, previous }) => (
    `${previous ? "Previously declared" : "Declared"} in ${edge.sourceFile} (${edge.kind})`
  ));
  if (observed.length) {
    const actions = [...new Set(observed.map(transition => transition.actionKind))].sort().join(", ");
    descriptions.unshift(`${observed.length} recorded transition${observed.length === 1 ? "" : "s"} (${actions})`);
  }
  const description = descriptions.slice(0, 6).join("\n")
    + (descriptions.length > 6 ? `\n${descriptions.length - 6} more source declarations` : "");
  const provenance = sources.length ? observed.length ? "mixed" : "source" : "observed";
  // No screenshot, or one that cannot be read: the variant thumbnails' glyph.
  const missing = <ImageOff size={16} aria-hidden="true" />;
  return (
    <Tooltip label={description} placement="left">
      <button type="button" className="transition-row" data-navigation-provenance={provenance}
        aria-description={description} onClick={() => props.onSelectScreen(targetId)}>
        <span className="transition-thumb">
          {screenshot ? <ScreenshotImage src={screenshot} alt="" loading="lazy" decoding="async"
            fallback={missing} /> : missing}
        </span>
        <span className="transition-kinds">
          {kinds.map(kind => <span className="transition-kind" key={kind}>{kind}</span>)}
        </span>
        <span className="transition-copy">
          <strong className="transition-path">{screenLabel(screen, props.index)}</strong>
        </span>
        <span className={`diff-dot diff-${status}`} title={DIFF_LABELS[status]} />
        <ChevronRight size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

type CopyFeedback = "idle" | "copied" | "failed";

const COPY_FEEDBACK_MS = 2000;

function DiffSide(props: {
  side: "before" | "after";
  /** A screen variant compares two runtime states of unchanged code, not a before and after. */
  stateVariant?: boolean;
  screenshot?: string | undefined;
  placeholder: string;
  title: string;
  aspectRatio: number;
  onAspectRatio: (screenshot: string, aspectRatio: number) => void;
  /** Drawn over the screenshot, such as the outlines of the changed areas. */
  overlay?: React.ReactNode;
  /** Opens the screenshot full window; the section owns the viewer so it can flip sides. */
  onView: () => void;
}) {
  const label = props.stateVariant
    ? props.side === "before" ? "Base state" : "Head state"
    : props.side === "before" ? "Before" : "After";
  const style = {
    "--inspector-diff-aspect-ratio": props.aspectRatio,
    // Match the single-screenshot 53vh / 468px sizing instead of growing with the compare row.
    "--inspector-diff-preview-width-vh": `${53 * props.aspectRatio}vh`,
    "--inspector-diff-preview-width-max": `${468 * props.aspectRatio}px`,
  } as CSSProperties;
  const previewRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>("idle");
  const alt = `${props.title}, ${label.toLowerCase()} comparison`;

  useEffect(() => {
    if (copyFeedback === "idle") return;
    const timer = window.setTimeout(() => setCopyFeedback("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyFeedback]);

  // Embedded reports render a resolved blob: URL; the displayed <img> is the source of truth.
  // A screenshot that is still loading or could not be read has nothing to view or copy.
  const displayedSrc = () => {
    const image = previewRef.current?.querySelector("img");
    if (!image || (image.dataset.screenshotState && image.dataset.screenshotState !== "ready")) return undefined;
    return image.currentSrc || image.src || undefined;
  };

  const copy = () => {
    const src = displayedSrc();
    if (!src) return;
    void copyImageToClipboard(src)
      .then(() => setCopyFeedback("copied"))
      .catch(() => setCopyFeedback("failed"));
  };

  return (
    <figure
      className="inspector-diff-figure"
      data-diff-side={props.side}
      style={style}>
      <figcaption className="inspector-diff-caption">{label}</figcaption>
      <div ref={previewRef} className="inspector-diff-preview">
        {props.screenshot ? (
          <>
            <ScreenshotImage
              src={props.screenshot}
              alt={alt}
              decoding="async"
              loading="eager"
              indicator="spinner"
              fallback={<ScreenshotPlaceholder className="inspector-diff-placeholder" />}
              onLoad={(event) => {
                const { naturalHeight, naturalWidth } = event.currentTarget;
                if (naturalHeight > 0 && naturalWidth > 0) {
                  props.onAspectRatio(props.screenshot!, naturalWidth / naturalHeight);
                }
              }}
            />
            {props.overlay}
            <div
              className="inspector-diff-actions"
              data-feedback={copyFeedback === "idle" ? undefined : copyFeedback}>
              <div className="inspector-diff-action-group" role="group" aria-label={`${label} screenshot actions`}>
                <button
                  type="button"
                  className="inspector-diff-action"
                  aria-label={`View ${label.toLowerCase()} screenshot`}
                  onClick={props.onView}>
                  <ZoomIn aria-hidden="true" />
                  <span>View</span>
                </button>
                <button
                  type="button"
                  className="inspector-diff-action"
                  data-state={copyFeedback}
                  aria-label={`Copy ${label.toLowerCase()} screenshot`}
                  aria-live="polite"
                  onClick={copy}>
                  {copyFeedback === "copied" ? <Check aria-hidden="true" />
                    : copyFeedback === "failed" ? <CircleAlert aria-hidden="true" />
                      : <Copy aria-hidden="true" />}
                  <span>{copyFeedback === "copied" ? "Copied" : copyFeedback === "failed" ? "Failed" : "Copy"}</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <ScreenshotPlaceholder className="inspector-diff-placeholder" label={props.placeholder} />
        )}
      </div>
    </figure>
  );
}

function WhatChangedSummary(props: { screenId: string; changes: PresentedChange[]; stateVariant?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [props.screenId]);
  const visibleChanges = expanded ? props.changes : props.changes.slice(0, INITIAL_CHANGE_COUNT);
  const hiddenChangeCount = Math.max(0, props.changes.length - INITIAL_CHANGE_COUNT);
  return (
    <section className="inspector-diff-summary" aria-labelledby="inspector-diff-summary-title">
      <h3 id="inspector-diff-summary-title">{props.stateVariant ? "State difference" : "What changed"}</h3>
      {props.stateVariant ? (
        <p className="what-changed-context">
          No source change reaches this screen. Its captures differ only in runtime UI state, so it is not a review target.
        </p>
      ) : null}
      {visibleChanges.length > 0 ? (
        <ul className="what-changed-list">
          {visibleChanges.map((change) => (
            // Each line states a finding; nothing here is a control.
            <li key={change.id} className="what-changed-item">
              <span aria-hidden="true" className="what-changed-bullet" />
              <span>{change.copy}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="what-changed-empty">
          Reviewer-visible change details are unavailable for this capture.
        </p>
      )}
      {hiddenChangeCount > 0 && (
        <button
          type="button"
          className="what-changed-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}>
          <ChevronDown aria-hidden="true" />
          {expanded ? "Show fewer" : `Show ${hiddenChangeCount} more`}
        </button>
      )}
    </section>
  );
}

/**
 * A screen with a reviewed change shows its Before → After pair and the What changed list where
 * the single screenshot would otherwise sit. Swipe, Flip and stepping through the changed areas
 * live in Compare; the button opens this screen there.
 */
function ScreenDiffSection(props: {
  screen: Screen;
  diff: ScreenDiff;
  changes: PresentedChange[];
  onOpenCompare?: (() => void) | undefined;
}) {
  const { diff, screen, changes } = props;
  const stateVariant = diff.status === "variant";
  const comparable = Boolean(diff.beforeScreenshot && diff.afterScreenshot && !stateVariant && !diff.redirectTo);
  const visualChanges = useMemo(
    () => (comparable && diff.visual ? groupVisualRegions(diff.visual.regions) : []),
    [comparable, diff.visual],
  );
  const [lightboxSide, setLightboxSide] = useState<"before" | "after">();
  // Both sides open in one viewer, so the left and right arrows flip between them.
  const lightboxImages: LightboxImage[] = (["before", "after"] as const).flatMap((side) => {
    const src = side === "before" ? diff.beforeScreenshot : diff.afterScreenshot;
    const label = stateVariant ? (side === "before" ? "Base state" : "Head state") : side === "before" ? "Before" : "After";
    return src ? [{ src, label, alt: `${screen.title}, ${label.toLowerCase()}` }] : [];
  });
  const lightboxIndex = lightboxSide ? lightboxImages.findIndex((image) => image.src === (
    lightboxSide === "before" ? diff.beforeScreenshot : diff.afterScreenshot
  )) : -1;
  const [imageAspectRatios, setImageAspectRatios] = useState<Record<string, number>>({});
  const knownBeforeRatio = diff.beforeScreenshot
    ? imageAspectRatios[diff.beforeScreenshot]
    : undefined;
  const knownAfterRatio = diff.afterScreenshot
    ? imageAspectRatios[diff.afterScreenshot]
    : undefined;
  const fallbackRatio = knownBeforeRatio ?? knownAfterRatio ?? DEFAULT_SCREENSHOT_RATIO;
  const recordAspectRatio = (screenshot: string, aspectRatio: number) => {
    setImageAspectRatios((current) => (
      current[screenshot] === aspectRatio
        ? current
        : { ...current, [screenshot]: aspectRatio }
    ));
  };
  // CI compares the two images pixel for pixel, so the same areas are outlined on both sides.
  const outlines = visualChanges.length > 0 ? <ChangeOutlines changes={visualChanges} /> : null;

  return (
    <>
      <section id="inspector-diff-visual" className="inspector-diff-visual">
        <div
          className="inspector-diff-compare"
          role="group"
          aria-label={stateVariant
            ? "Base and head runtime states of the same screen"
            : diff.redirectTo
              ? `Before to after comparison of ${diff.redirectTo}, the route this redirect declares`
              : "Before to after comparison"}>
          <DiffSide
            side="before"
            stateVariant={stateVariant}
            screenshot={diff.beforeScreenshot}
            placeholder={placeholderFor("before", diff.status, diff.captureNotes)}
            title={screen.title}
            aspectRatio={knownBeforeRatio ?? fallbackRatio}
            onAspectRatio={recordAspectRatio}
            overlay={outlines}
            onView={() => setLightboxSide("before")}
          />
          <DiffSide
            side="after"
            stateVariant={stateVariant}
            screenshot={diff.afterScreenshot}
            placeholder={placeholderFor("after", diff.status, diff.captureNotes)}
            title={screen.title}
            aspectRatio={knownAfterRatio ?? fallbackRatio}
            onAspectRatio={recordAspectRatio}
            overlay={outlines}
            onView={() => setLightboxSide("after")}
          />
        </div>
        {props.onOpenCompare && !stateVariant ? (
          <button type="button" className="inspector-open-compare" onClick={props.onOpenCompare}>
            <GitCompareArrows aria-hidden="true" />
            <span>Open in Compare</span>
          </button>
        ) : null}
      </section>

      <WhatChangedSummary screenId={screen.id} changes={changes} stateVariant={stateVariant} />
      {lightboxIndex >= 0 ? (
        <ImageLightbox images={lightboxImages} initialIndex={lightboxIndex} onClose={() => setLightboxSide(undefined)} />
      ) : null}
    </>
  );
}

type InspectorPanelProps = {
  index: MapIndex;
  screen?: Screen | undefined;
  diff?: BuildDiff | undefined;
  direction: Direction;
  onChangeDirection: (direction: Direction) => void;
  selectedVariantId?: string | undefined;
  onSelectVariant: (variantId: string) => void;
  onSelectScreen: (id: string) => void;
  /** Opens the selected changed screen in Compare. */
  onOpenCompare?: (() => void) | undefined;
  /** The changed screens in review order, and how to step to one, for the sidebar review. */
  review?: { order: readonly ChangedScreen[]; onSelectScreen: (id: string) => void } | undefined;
};

/** The URL to show for an artifact, resolving an embedded (self-contained report) reference lazily. */
function useArtifactSrc(artifact: Artifact | undefined): string | undefined {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const url = artifactUrl(artifact);
    if (!url) { setSrc(undefined); return; }
    if (!isEmbeddedArtifactUrl(url)) { setSrc(url); return; }
    let disposed = false;
    void resolveEmbeddedArtifactUrl(url, "lazy").then((resolved) => { if (!disposed) setSrc(resolved); }, () => { if (!disposed) setSrc(undefined); });
    return () => { disposed = true; };
  }, [artifact]);
  return src;
}

/** The app launch: what the frame shows, the filmstrip of the launch, and, when the report carries one, the recording. */
function LaunchSection({ screen, index, note }: { screen: Screen; index: MapIndex; note?: string | undefined }) {
  // Filtering the map to one appearance presents `launch:splash@dark` as `launch:splash`; artifacts keep the full id.
  // A secondary appearance owns a suffixed launch frame, and then only its own media may show: the bare id is the
  // primary appearance's, so falling back to it would play the light launch under a dark screen that has none.
  const bySide = (prefix: string, id: string) => [`${prefix}:head:${id}`, `${prefix}:base:${id}`].map((key) => index.artifacts.get(key)).find(Boolean);
  const suffixed = screen.colorScheme && !screen.id.includes("@") ? `${screen.id}@${screen.colorScheme}` : undefined;
  const launchId = suffixed && bySide("image", suffixed) ? suffixed : screen.id;
  const find = (prefix: string) => bySide(prefix, launchId);
  const filmstrip = find("filmstrip");
  const video = find("video");
  const filmstripSrc = useArtifactSrc(filmstrip);
  const videoSrc = useArtifactSrc(video);
  return (
    <section className="inspector-section launch-section">
      <div className="section-title"><h3>Launch</h3></div>
      <p className="launch-note">{note?.trim() || (screen.state === "splash" ? "Splash screen while it was visible." : "First settled frame; no splash screen was observed.")}</p>
      {filmstrip && filmstripSrc ? (
        <figure className="launch-filmstrip">
          <img src={filmstripSrc} alt="Launch filmstrip: the distinct frames of the launch, labelled with their time from the launch transition" />
          <figcaption>Before the launch, the transition, the splash as it appeared and when it first changed, and the first screen; times are from the launch transition.</figcaption>
        </figure>
      ) : null}
      {video ? (
        <video className="launch-video" controls muted playsInline preload="metadata" src={videoSrc} aria-label="Launch recording" />
      ) : null}
    </section>
  );
}

export function InspectorPanel(props: InspectorPanelProps) {
  const { direction, screen } = props;
  const screenDiff = screen ? props.diff?.screens.get(screen.id) : undefined;
  const changes = useMemo(() => presentedChanges(screenDiff), [screenDiff]);
  const { outgoing, incoming } = useMemo(
    () => inspectorTransitions(screen?.id, props.index), [screen?.id, props.index],
  );
  // Only a screen whose comparison actually differs earns the Before → After layout. A screen
  // the review confirmed as unchanged reads like any other: one screenshot and its transitions.
  const showDiff = Boolean(
    screenDiff
    && screenDiff.status !== "unchanged"
    && screenDiff.status !== "not-compared"
    && screenDiff.status !== "unavailable"
    && !screenDiff.noVisibleChange,
  );

  if (!screen) {
    return (
      <div className="panel-body inspector">
        <div className="panel-empty inspector-empty">
          <MousePointerClick size={20} />
          <strong>Select a screen</strong>
          <span>Click a screenshot to inspect its changes and transitions.</span>
        </div>
      </div>
    );
  }

  const transitions = direction === "out" ? outgoing : incoming;
  // A changed screen gets the sidebar review: Compare at sidebar size, for the screen the reader
  // picked (stepping through the changes is Compare's). Redirects and state variants keep the
  // pair, which labels what the two sides are.
  const reviewable = screenDiff && props.diff && props.review && props.onOpenCompare
    && screenDiff.status !== "variant" && !screenDiff.redirectTo
    && props.review.order.some((entry) => entry.id === screen.id);

  const preview = (
    <ScreenshotDiffFrame>
      <ScreenVariantCarousel
        screen={screen}
        index={props.index}
        selectedVariantId={props.selectedVariantId}
        onSelectVariant={props.onSelectVariant}
        placeholder={screenDiff?.status === "unavailable"
          ? placeholderFor("after", screenDiff.status, screenDiff.captureNotes)
          : undefined}
        placeholderDetail={props.index.screenNotes.get(screen.id)}
      />
    </ScreenshotDiffFrame>
  );

  return (
    <div className={`panel-body inspector${showDiff || reviewable ? " inspector-diff" : ""}`}>
      {reviewable && props.diff && props.review && props.onOpenCompare ? (
        <>
          <SidebarReview diff={props.diff} index={props.index} screenId={screen.id}
            order={props.review.order} onSelectScreen={props.review.onSelectScreen} />
          <CapturedScreenVariants screen={screen} index={props.index}
            selectedVariantId={props.selectedVariantId} onSelectVariant={props.onSelectVariant} />
        </>
      ) : showDiff && screenDiff ? (
        <>
          <ScreenDiffSection key={screen.id} screen={screen} diff={screenDiff} changes={changes}
            onOpenCompare={props.onOpenCompare} />
          <CapturedScreenVariants screen={screen} index={props.index}
            selectedVariantId={props.selectedVariantId} onSelectVariant={props.onSelectVariant} />
        </>
      ) : (
        <>
          {/* With a baseline, a screen the build left unchanged keeps the review's shape (the modes
              over the screenshot, the actions under it), all off, so the Inspector holds one shape
              from a changed screen to an unchanged one. */}
          {props.diff && props.review ? <SidebarReviewOff>{preview}</SidebarReviewOff> : preview}
          {screenDiff?.note?.trim() ? <WhatChangedSummary screenId={screen.id} changes={changes} /> : null}
        </>
      )}

      {screen.id.startsWith(LAUNCH_SURFACE_ID) ? <LaunchSection screen={screen} index={props.index} note={screenDiff?.note} /> : null}

      <section
        className={`inspector-section transition-section${transitions.length === 0 ? " is-empty" : ""}`}>
        <div className="section-title">
          <h3>Transition</h3>
          <ToggleGroup<Direction>
            ariaLabel="Transition direction"
            variant="flat"
            value={direction}
            onChange={props.onChangeDirection}
            options={[
              { id: "in", label: "In", icon: <ArrowDownLeft size={13} />, count: incoming.length },
              { id: "out", label: "Out", icon: <ArrowUpRight size={13} />, count: outgoing.length },
            ]}
          />
        </div>
        {transitions.length === 0 ? (
          <div className="inline-empty">
            {direction === "out" ? "No transitions leave this screen." : "No transitions arrive here."}
          </div>
        ) : (
          <div className="transition-list">
            {transitions.map((item) => (
              <TransitionRow
                key={item.screen.id}
                item={item}
                index={props.index}
                diff={props.diff}
                onSelectScreen={props.onSelectScreen}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
