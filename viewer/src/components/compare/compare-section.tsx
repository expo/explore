import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ImageOff, ScanSearch } from "lucide-react";
import type { ChangesMenuData } from "../panels/changes-menu";
import { diffLabel, ACCESSIBILITY_ONLY_HIGHLIGHT, type BuildDiff, type ScreenDiff } from "../../utils/build-diff";
import type { MapIndex } from "../../utils/model";
import type { ChangedScreen } from "../../utils/changed-screens";
import { groupVisualRegions, layoutShiftSummary, type VisualChange } from "../../utils/visual-diff";
import { formatShortcut, matchesShortcut, SHORTCUTS, shortcutsLive } from "../../utils/shortcuts";
import { createKeyHold, DIVIDER_GLIDE, glideWhileHeld, type KeyHold } from "../../utils/key-hold";
import { optionalStorage } from "../../utils/embedded-report";
import { usePhoneLayout } from "../../utils/phone-layout";
import { ToggleGroup } from "../shared/toggle-group";
import { Tooltip } from "../shared/tooltip";
import { DEFAULT_SCREENSHOT_RATIO, ScreenshotImage, ScreenshotPlaceholder } from "../shared/screenshot-image";
import { ChangeOutlines, HomeIndicatorBand, StatusBarBand, SwipeCompare, SWIPE_STEP } from "../panels/visual-diff";
import { placeholderFor, presentedChanges, splitForAssistiveTechnology } from "../../utils/presented-changes";
import { CompareNav, WhatChangedPopover } from "./compare-header";
import "./compare-section.css";

export type CompareMode = "split" | "swipe" | "flip";

const MODE_STORAGE_KEY = "expo-explore:compare-mode";
// A phone remembers its own mode: Flip shows one screenshot at full width, which a narrow window
// needs, and a choice made there must not change the desktop layout.
const PHONE_MODE_STORAGE_KEY = "expo-explore:compare-mode-phone";
const OUTLINES_STORAGE_KEY = "expo-explore:compare-outlines";
// One order everywhere, from two frames to one: Split, Swipe, Flip. 1, 2 and 3 follow it.
const MODES: CompareMode[] = ["split", "swipe", "flip"];
const MODE_LABELS: Record<CompareMode, string> = { split: "Split", swipe: "Swipe", flip: "Flip" };
const MODE_KEYS: Record<CompareMode, string> = {
  split: formatShortcut(SHORTCUTS.compare.split),
  swipe: formatShortcut(SHORTCUTS.compare.swipe),
  flip: formatShortcut(SHORTCUTS.compare.flip),
};

function storedMode(key: string, fallback: CompareMode): CompareMode {
  const value = optionalStorage.getItem(key);
  return MODES.find((mode) => mode === value) ?? fallback;
}

/** Split, Swipe, Flip as the mode switch lists them, with their names and keys. */
export function compareModeOptions() {
  return MODES.map((id) => ({
    id,
    label: MODE_LABELS[id],
    title: MODE_LABELS[id],
    shortcut: MODE_KEYS[id],
  }));
}

// Highlight changes (the outlines) is one remembered choice, on unless turned off, shared by
// every view that draws them: Compare, the Inspector's review and its header button, and the O key.
const outlinesListeners = new Set<() => void>();
/** The choice made this visit, so the button works where storage is denied (a private window). */
let outlinesChosen: boolean | undefined;
function storedOutlines(): boolean {
  return outlinesChosen ?? optionalStorage.getItem(OUTLINES_STORAGE_KEY) !== "false";
}
/** Sets the outlines choice everywhere at once and remembers it where it can. */
export function setOutlinesShown(shown: boolean) {
  outlinesChosen = shown;
  optionalStorage.setItem(OUTLINES_STORAGE_KEY, String(shown));
  for (const listener of outlinesListeners) listener();
}
/** The outlines choice, kept in step with every other view that shows or changes it. */
export function useOutlinesShown(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      outlinesListeners.add(onChange);
      return () => outlinesListeners.delete(onChange);
    },
    storedOutlines,
    () => true,
  );
}

export type CompareControllerOptions = {
  diff: BuildDiff;
  index: MapIndex;
  screenId: string;
  order: readonly ChangedScreen[];
  /** Whether the arrow keys step to the previous and next changed screen. Compare steps; the Inspector stays on its screen. */
  stepScreens?: boolean;
  onSelectScreen: (id: string) => void;
  /** Esc with no area selected: Compare ignores it; the map card closes. */
  onEscape?: (() => void) | undefined;
};

/**
 * Everything Compare and the map card share: the screen in review, its changed areas and facts,
 * the remembered mode and outline choice, and the keys. Both views answer to the same keys.
 */
export function useCompareController(options: CompareControllerOptions) {
  const screen = options.index.screens.get(options.screenId);
  const screenDiff = options.diff.screens.get(options.screenId);
  const position = options.order.findIndex((entry) => entry.id === options.screenId);
  const previous = position > 0 ? options.order[position - 1] : undefined;
  const next = position >= 0 && position < options.order.length - 1 ? options.order[position + 1] : undefined;
  const comparable = Boolean(screenDiff?.beforeScreenshot && screenDiff.afterScreenshot
    && screenDiff.status !== "variant" && !screenDiff.redirectTo);
  const areas = useMemo(
    () => (comparable && screenDiff?.visual ? groupVisualRegions(screenDiff.visual.regions) : []),
    [comparable, screenDiff?.visual],
  );
  // Only what CI found on this screen. The generic summary ("Shared app source changed.") is
  // not a finding about this screen, so it leaves the list empty and the button disabled.
  // Every changed area only moved, CI's own count included (it publishes the largest regions only): say how far,
  // in place of its generic pixel finding ("Updated visual styling in the main content area").
  const shiftLines = useMemo(
    () => (screenDiff?.visual?.allRegionsMoved ? layoutShiftSummary(areas) : undefined),
    [areas, screenDiff?.visual?.allRegionsMoved],
  );
  const measurable = areas.some((area) => area.move);
  const facts = useMemo(
    () => presentedChanges(screenDiff).filter((change) => change.id !== "legacy-summary"
      && !(shiftLines && change.fact?.templateId === "visual.main-content-changed")),
    [screenDiff, shiftLines],
  );
  // "Nothing on this screen changed content" only when no other finding says otherwise.
  const layoutShift = useMemo(
    () => (shiftLines ? { lines: shiftLines, nothingElse: facts.length === 0 } : undefined),
    [shiftLines, facts.length],
  );
  // What changed for assistive technology is listed under its own heading.
  const split = useMemo(() => splitForAssistiveTechnology(facts, screenDiff), [facts, screenDiff]);

  const phone = usePhoneLayout();
  const [desktopMode, setDesktopMode] = useState<CompareMode>(() => storedMode(MODE_STORAGE_KEY, "split"));
  const [phoneMode, setPhoneMode] = useState<CompareMode>(() => storedMode(PHONE_MODE_STORAGE_KEY, "flip"));
  // A screen with nothing to compare shows its one screenshot in Flip's single frame, with the side
  // it lacks dimmed in the names above it. This is the stage's mode; the switch keeps the chosen one.
  const mode: CompareMode = comparable ? (phone ? phoneMode : desktopMode) : "flip";
  const outlines = useOutlinesShown();
  const [activeArea, setActiveArea] = useState<number>();
  const [flipSide, setFlipSide] = useState<"before" | "after">("after");
  const [swipePosition, setSwipePosition] = useState(50);
  const [factsOpen, setFactsOpen] = useState(false);
  const [aspect, setAspect] = useState(DEFAULT_SCREENSHOT_RATIO);

  // Each screen starts whole: no area selected, After showing, the facts closed.
  useEffect(() => {
    setActiveArea(undefined);
    setFlipSide("after");
    setFactsOpen(false);
  }, [options.screenId]);

  const chooseMode = (nextMode: CompareMode) => {
    if (!comparable) return;
    (phone ? setPhoneMode : setDesktopMode)(nextMode);
    optionalStorage.setItem(phone ? PHONE_MODE_STORAGE_KEY : MODE_STORAGE_KEY, nextMode);
  };
  const toggleOutlines = () => setOutlinesShown(!storedOutlines());
  const stepArea = (step: 1 | -1) => {
    if (areas.length === 0) return;
    if (!storedOutlines()) setOutlinesShown(true);
    setActiveArea((current) => {
      if (current === undefined) return step === 1 ? 0 : areas.length - 1;
      return Math.min(areas.length - 1, Math.max(0, current + step));
    });
  };
  const flip = () => setFlipSide((side) => (side === "after" ? "before" : "after"));

  const keyState = useRef({ previous, next, mode, activeArea, options, swipePosition });
  keyState.current = { previous, next, mode, activeArea, options, swipePosition };

  // Stepping to the previous or next changed screen; a held key keeps stepping, accelerating, until
  // it is released, the window loses focus, or the end is reached. The Swipe divider is continuous,
  // so a tap of [ or ] nudges it one step and a held one glides. Both read the latest state.
  const stepScreen = (direction: 1 | -1): boolean => {
    const state = keyState.current;
    const target = direction === 1 ? state.next : state.previous;
    if (!target) return false;
    state.options.onSelectScreen(target.id);
    return true;
  };
  const moveDivider = (direction: 1 | -1, steps = 1): boolean => {
    const state = keyState.current;
    if (state.mode !== "swipe") return false;
    const position = Math.max(0, Math.min(100, state.swipePosition + direction * SWIPE_STEP * steps));
    if (position === state.swipePosition) return false;
    state.swipePosition = position;
    setSwipePosition(position);
    return true;
  };
  const holdRef = useRef<KeyHold>(undefined);
  holdRef.current ??= createKeyHold();
  const hold = holdRef.current;
  useEffect(() => hold.end, [hold]);
  // A tap of [ or ] moves the divider one step; held, it keeps going from the same motion. The hold only
  // tracks the key; the glide reads it every frame and stops with it.
  const glideDivider = (code: string, direction: 1 | -1) => {
    hold.begin(code, () => true);
    glideWhileHeld(hold, code, (steps) => moveDivider(direction, steps), DIVIDER_GLIDE);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      hold.interrupt(event);
      // The browser's own repeat of the held key is not a step; it must not scroll either.
      if (event.repeat && hold.holding(event.code)) { event.preventDefault(); return; }
      if (event.defaultPrevented || !shortcutsLive(event)) return;
      const state = keyState.current;
      const keys = SHORTCUTS.compare;
      const stepScreens = state.options.stepScreens !== false;
      if (stepScreens && matchesShortcut(event, keys.previousScreen)) {
        if (stepScreen(-1)) hold.begin(event.code, () => stepScreen(-1));
      } else if (stepScreens && matchesShortcut(event, keys.nextScreen)) {
        if (stepScreen(1)) hold.begin(event.code, () => stepScreen(1));
      } else if (matchesShortcut(event, keys.nextArea)) {
        stepArea(1);
      } else if (matchesShortcut(event, keys.previousArea)) {
        stepArea(-1);
      } else if (event.key === "Escape") {
        // Esc backs out one level: first the selected area, then (on the map) the card.
        if (state.activeArea !== undefined) setActiveArea(undefined);
        else if (state.options.onEscape) state.options.onEscape();
        else return;
      } else if (matchesShortcut(event, keys.split)) {
        chooseMode("split");
      } else if (matchesShortcut(event, keys.swipe)) {
        chooseMode("swipe");
      } else if (matchesShortcut(event, keys.flip)) {
        chooseMode("flip");
      } else if (matchesShortcut(event, keys.flipSide)) {
        if (state.mode !== "flip") return;
        flip();
      } else if (matchesShortcut(event, keys.dividerLeft)) {
        if (state.mode !== "swipe") return;
        glideDivider(event.code, -1);
      } else if (matchesShortcut(event, keys.dividerRight)) {
        if (state.mode !== "swipe") return;
        glideDivider(event.code, 1);
      } else if (matchesShortcut(event, keys.outlines)) {
        toggleOutlines();
      } else if (matchesShortcut(event, keys.whatChanged)) {
        setFactsOpen((open) => !open);
      } else {
        return;
      }
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (hold.holding(event.code)) hold.end();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hold.end);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hold.end);
    };
  });

  const route = options.order[position]?.route ?? screen?.route ?? screen?.title ?? "";
  const shownOutlines = outlines && areas.length > 0;
  const statusBarIgnored = (screenDiff?.visual?.ignoredStatusBarRegions ?? 0) > 0;
  const homeIndicatorIgnored = (screenDiff?.visual?.ignoredHomeIndicatorRegions ?? 0) > 0;
  const modeOptions = compareModeOptions();
  // The switch shows the mode the reviewer chose, not the one-screenshot view a screen with nothing
  // to compare falls back to. Such a screen turns the whole switch off, with nothing current, so
  // stepping past it leaves the choice (and its highlight) where it was.
  const chosenMode: CompareMode = phone ? phoneMode : desktopMode;
  const modesDisabled = !comparable;
  return {
    screen, screenDiff, route, position, previous, next, comparable, areas, facts, split, layoutShift, measurable,
    mode, chosenMode, modesDisabled, chooseMode, modeOptions, outlines, shownOutlines, statusBarIgnored, homeIndicatorIgnored, toggleOutlines,
    activeArea, setActiveArea, stepArea, flipSide, flip, swipePosition, setSwipePosition,
    aspect, setAspect, factsOpen, setFactsOpen,
  };
}

/**
 * Fits Compare's command bar between the other floating chrome. It has one width of its own
 * (COMPARE_BAR_WIDTH, grown by --ui-scale), so it keeps one size from screen to screen. It stays on the pill's row, clear of the pill on both
 * sides (--compare-side-reserve); only a window with less room beside the pill than the bar needs
 * marks the section `data-bar-below`, and the bar drops under the pill.
 */
/** The command bar's width before --ui-scale: the screen, its steps, the mode switch and two actions. */
const COMPARE_BAR_WIDTH = 600;

function useBarGeometry(sectionRef: RefObject<HTMLElement | null>, mounted: boolean) {
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const pill = document.querySelector<HTMLElement>(".left-panel.collapsed");
    const update = () => {
      const box = section.getBoundingClientRect();
      const pillBox = pill?.getBoundingClientRect();
      // A pill on the bar's row narrows it; an open panel beside the section does not.
      const reach = pillBox && pillBox.top < box.top + 80 ? Math.max(0, pillBox.right - box.left) : 0;
      const reserve = reach > 0 ? reach + 12 : 16;
      const scale = Number.parseFloat(getComputedStyle(section).getPropertyValue("--ui-scale")) || 1;
      const barWidth = COMPARE_BAR_WIDTH * scale;
      section.style.setProperty("--compare-side-reserve", `${reserve}px`);
      section.toggleAttribute("data-bar-below", box.width - 2 * reserve < barWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(section);
    if (pill) observer.observe(pill);
    return () => observer.disconnect();
  }, [sectionRef, mounted]);
}

type CompareSectionProps = Omit<CompareControllerOptions, "onEscape"> & {
  /** Opens the Changes menu from the route in the header. */
  picker: ComparePicker;
};

/**
 * Compare is a section of its own, beside Map and Screens: one changed screen at a time,
 * as large as the window allows. The header, as on a phone, names the screen, steps between
 * changed screens (‹ › or ← →) and holds Highlight changes and What changed. The mode switch
 * sits in the bottom toolbar, after the section buttons.
 * J and K select one changed area; Esc clears it. The keys are listed behind "?" in the bottom bar.
 */
export function CompareSection(props: CompareSectionProps) {
  const compare = useCompareController(props);
  const {
    screen, screenDiff, route, areas, facts, mode, chooseMode, modeOptions, outlines, shownOutlines,
    statusBarIgnored, homeIndicatorIgnored, toggleOutlines, activeArea, flipSide, flip, swipePosition, setSwipePosition, aspect,
    setAspect, factsOpen, setFactsOpen,
  } = compare;
  const sectionRef = useRef<HTMLElement>(null);
  useBarGeometry(sectionRef, Boolean(screen && screenDiff));

  if (!screen || !screenDiff) {
    return (
      <section className="compare-section compare-section-empty" aria-label="Compare">
        <p>No changed screens to compare.</p>
      </section>
    );
  }

  const title = screen.title;
  const overlay = shownOutlines ? (
    <>
      <ChangeOutlines changes={areas} activeIndex={activeArea} />
      {statusBarIgnored ? <StatusBarBand /> : null}
      {homeIndicatorIgnored ? <HomeIndicatorBand /> : null}
    </>
  ) : null;

  const factCopies = compare.split.visible.map((fact) => fact.copy);
  const assistive = compare.split.assistive.map((fact) => fact.copy);
  const notes = compareNotes(screenDiff, facts.length, statusBarIgnored, homeIndicatorIgnored);

  return (
    <section ref={sectionRef} className="compare-section" aria-label={`Compare ${route}`}
      style={{ "--compare-aspect": aspect } as CSSProperties}>
      {/* One command bar at the top, in the bottom toolbar's make: which screen and where it sits,
          how to look at it, and what to look for. The bottom toolbar stays the same on every section. */}
      <header className="compare-top">
        <div className="compare-bar">
          <CompareNav variant="desktop" status={screenDiff.status} accessibilityOnly={screenDiff.accessibilityOnly} statusLabel={diffLabel(screenDiff)} route={route} title={title}
            position={compare.position} count={props.order.length} picker={props.picker}
            onPrevious={compare.previous ? () => props.onSelectScreen(compare.previous!.id) : undefined}
            onNext={compare.next ? () => props.onSelectScreen(compare.next!.id) : undefined} />
          <span className="toolbar-divider" aria-hidden="true" />
          <div className="compare-controls">
            <ToggleGroup<CompareMode>
              value={compare.chosenMode}
              disabled={compare.modesDisabled}
              options={modeOptions}
              onChange={chooseMode}
              ariaLabel="Comparison mode"
              // The arrow keys step through screens, never through modes. 1, 2 and 3 pick a mode.
              arrowKeys={false}
            />
          </div>
          <span className="toolbar-divider" aria-hidden="true" />
          <Tooltip label={screenDiff.accessibilityOnly ? ACCESSIBILITY_ONLY_HIGHLIGHT : "Highlight changes"} shortcut={formatShortcut(SHORTCUTS.compare.outlines)} placement="bottom">
            <button type="button" className="toolbar-button compare-outlines" aria-label="Highlight changes"
              aria-pressed={outlines} disabled={areas.length === 0} onClick={toggleOutlines}>
              <ScanSearch aria-hidden="true" />
            </button>
          </Tooltip>
          <WhatChangedPopover facts={factCopies} assistive={assistive} accessibilityOnly={screenDiff.accessibilityOnly}
            layoutShift={compare.layoutShift} measurable={compare.measurable} notes={notes} open={factsOpen} onOpenChange={setFactsOpen} />
        </div>
      </header>

      <div className={`compare-stage mode-${mode}`}>
        {/* Every mode names Before and After in a row above the screenshots. */}
        <CompareStage
          mode={mode}
          swipeLabels="above"
          diff={screenDiff}
          title={title}
          areas={areas}
          activeArea={activeArea}
          showOutlines={shownOutlines}
          statusBarIgnored={statusBarIgnored}
          homeIndicatorIgnored={homeIndicatorIgnored}
          overlay={overlay}
          flipSide={flipSide}
          onFlip={flip}
          swipePosition={swipePosition}
          onSwipePosition={setSwipePosition}
          aspect={aspect}
          onAspect={setAspect}
        />
      </div>

    </section>
  );
}

/** The Changes menu as Compare's header opens it, with its open state. */
export type ComparePicker = ChangesMenuData & { open: boolean; onOpenChange: (open: boolean) => void };

/**
 * The notes about a comparison, listed with its findings wherever What changed opens. A
 * phone has no hover, so the status bar's note, a tooltip on wider windows, is listed here too.
 */
export function compareNotes(screenDiff: ScreenDiff, factCount: number, statusBarIgnored: boolean, homeIndicatorIgnored = false): string[] {
  return [
    ...(factCount === 0 && screenDiff.status === "needs-review"
      ? ["The code for this screen changed. No visible difference was found."] : []),
    ...(screenDiff.status === "added" ? ["This screen is new in this PR. There is no Before to compare."]
      : screenDiff.status === "removed" ? ["This screen was removed in this PR. There is no After to compare."] : []),
    ...(statusBarIgnored
      ? ["The status bar (clock, signal, battery) differs between the captures. It is not counted as a change."] : []),
    ...(homeIndicatorIgnored
      ? ["The home indicator at the bottom differs between the captures. It is not counted as a change."] : []),
  ];
}

type StageProps = {
  mode: CompareMode;
  /**
   * Where Split names Before and After: `above` is a caption row over each frame, `inside` puts
   * them in the frames' bottom corners, as Swipe does. Flip always names both sides above the
   * frame, with the one on screen lit, so flipping never moves the screenshot.
   */
  labels?: "above" | "inside";
  /** Where Swipe names Before and After: in the frame's bottom corners (the default) or in a row above it, as Flip does. */
  swipeLabels?: "above" | "inside";
  diff: ScreenDiff;
  title: string;
  areas: VisualChange[];
  activeArea: number | undefined;
  showOutlines: boolean;
  statusBarIgnored: boolean;
  homeIndicatorIgnored: boolean;
  overlay: ReactNode;
  flipSide: "before" | "after";
  onFlip: () => void;
  swipePosition: number;
  onSwipePosition: (position: number) => void;
  aspect: number;
  onAspect: (aspect: number) => void;
};

export function CompareStage(props: StageProps) {
  const { diff } = props;
  const before = diff.beforeScreenshot;
  const after = diff.afterScreenshot;
  if (!before && !after) {
    const reason = diff.captureNotes?.after ?? diff.captureNotes?.before;
    return (
      <div className="compare-missing">
        <ImageOff aria-hidden="true" />
        <strong>No screenshots for this screen</strong>
        {reason ? <span>{reason}</span> : null}
      </div>
    );
  }
  if (props.mode === "swipe" && before && after) {
    const swipe = (
      <div className="compare-swipe">
        <SwipeCompare
          title={props.title}
          before={before}
          after={after}
          imageAspect={props.aspect}
          changes={props.areas}
          activeIndex={props.activeArea}
          showOutlines={props.showOutlines}
          statusBarIgnored={props.statusBarIgnored}
          homeIndicatorIgnored={props.homeIndicatorIgnored}
          position={props.swipePosition}
          onPositionChange={props.onSwipePosition}
          labels={props.swipeLabels !== "above"}
        />
      </div>
    );
    if (props.swipeLabels !== "above") return swipe;
    // Before on the divider's left, After on its right, in the row Flip names its sides in.
    return (
      <figure className="compare-side">
        <figcaption className="compare-side-label compare-swipe-label">
          <span>Before</span>
          <span>After</span>
        </figcaption>
        {swipe}
      </figure>
    );
  }
  if (props.mode === "flip" && before && after) {
    const showing = props.flipSide;
    return (
      <figure className="compare-side">
        {/* Both names, with the one on screen lit; the other one flips to it. */}
        <figcaption className="compare-side-label compare-flip-label">
          {(["before", "after"] as const).map((side) => (
            <button key={side} type="button" className="compare-flip-side" aria-pressed={showing === side}
              onClick={showing === side ? undefined : props.onFlip}>
              {side === "before" ? "Before" : "After"}
            </button>
          ))}
        </figcaption>
        <div className="compare-frame-wrap">
          <button type="button" className="compare-frame compare-flip-frame" data-side={showing}
            aria-label={`Show ${showing === "after" ? "Before" : "After"}`} onClick={props.onFlip}>
            <CompareImage src={showing === "after" ? after : before} alt={`${props.title}, ${showing}`}
              placeholder="No screenshot" onAspect={props.onAspect} />
            {props.overlay}
          </button>
        </div>
      </figure>
    );
  }
  if (props.mode === "flip") {
    // One screenshot (a new or a removed screen): nothing to compare, so no Before or After. The
    // names' row stays, unseen, so the frame sits where it does on a screen that has both.
    const showing = after ? "after" : "before";
    const src = (after ?? before)!;
    return (
      <figure className="compare-side" data-side={showing}>
        <div className="compare-side-label compare-flip-label compare-side-label-reserved" aria-hidden="true">
          <span>Before</span>
          <span>After</span>
        </div>
        <div className="compare-frame-wrap">
          <div className="compare-frame">
            <CompareImage src={src} alt={`${props.title}, ${showing}`}
              placeholder={placeholderFor(showing, diff.status, diff.captureNotes)} onAspect={props.onAspect} />
          </div>
        </div>
      </figure>
    );
  }
  const sides = (["before", "after"] as const).filter((side) => (
    side === "before" ? diff.status !== "added" : diff.status !== "removed"
  ));
  return (
    <>
      {sides.map((side) => {
        const src = side === "before" ? before : after;
        const label = side === "before" ? "Before" : "After";
        const note = side === "before" && diff.status === "removed" ? " · not in this PR"
          : side === "after" && diff.status === "added" ? " · not in baseline" : "";
        return (
          <figure key={side} className="compare-side" data-side={side}>
            {props.labels === "inside" ? null : <figcaption className="compare-side-label">{label}{note}</figcaption>}
            <div className="compare-frame-wrap">
              <div className="compare-frame">
                {src ? (
                  <CompareImage src={src} alt={`${props.title}, ${side}`}
                    placeholder={placeholderFor(side, diff.status, diff.captureNotes)} onAspect={props.onAspect} />
                ) : (
                  <ScreenshotPlaceholder label={placeholderFor(side, diff.status, diff.captureNotes)} />
                )}
                {src ? props.overlay : null}
              </div>
              {props.labels === "inside" ? (
                <span className={`compare-side-label compare-side-tag ${side}`}>{label}{note}</span>
              ) : null}
            </div>
          </figure>
        );
      })}
    </>
  );
}

function CompareImage(props: { src: string; alt: string; placeholder: string; onAspect: (aspect: number) => void }) {
  return (
    <ScreenshotImage
      src={props.src}
      alt={props.alt}
      loading="eager"
      indicator="spinner"
      draggable={false}
      fallback={<ScreenshotPlaceholder label={props.placeholder} />}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) props.onAspect(naturalWidth / naturalHeight);
      }}
    />
  );
}
