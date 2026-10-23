import { useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { ChevronRight } from "lucide-react";
import { artifactUrl, isLaunchScreen, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize, type ScreenshotSize } from "../../utils/screen-images";
import { diffClass, type BuildDiff } from "../../utils/build-diff";
import { screenLabel } from "../../utils/screen-path";
import { treeNodeKey, type ScreenTree, type ScreenTreeIndex, type ScreenTreeNode } from "../../utils/screen-tree";
import { ScreenshotImage } from "../shared/screenshot-image";

/**
 * A neighbour's size and opacity by its distance from the screen in the middle. The last, invisible, place is where a
 * screen waits to come in, so a swipe or a step fades it in rather than popping it.
 */
const SCALES = [1, 0.74, 0.54, 0.4, 0.3];
const OPACITIES = [1, 0.9, 0.6, 0.3, 0];
const GAP = 32;
/** A swipe has ended once its wheel events (and the trackpad's momentum after it) stop for this long. */
const SWIPE_END_MS = 140;
/**
 * At the end of a swipe the strip settles on the next screen in its direction once it has moved this far towards it,
 * so one wheel notch steps a screen and a twitch springs back.
 */
const SWIPE_COMMIT = 0.2;
/** An iPhone's portrait shape, for a run with no screenshot sizes at all. */
const FALLBACK_SIZE: ScreenshotSize = { imageWidth: 390, imageHeight: 844 };

export type ScreensFilmstripProps = {
  /** The screens shown, in the tree's order. */
  order: readonly string[];
  /** The screen in the middle. */
  focusedId: string;
  selectedId?: string | undefined;
  index: MapIndex;
  diff?: BuildDiff | undefined;
  tree: ScreenTree;
  shape: ScreenTreeIndex;
  typicalSize?: ScreenshotSize | undefined;
  /** The element id a screen's frame takes, which the page's arrow keys focus by. */
  frameId: (id: string) => string;
  /** The tree's dot class for a screen: its status, shown beside its name as the grid and the tree show it. */
  dot: (id: string) => string | undefined;
  dimmed: (id: string) => boolean;
  /** Brings a screen to the middle without opening the Inspector. */
  onPick: (id: string) => void;
  /** Selects a screen and opens it in the Inspector, as a click on its card does. */
  onOpen: (id: string) => void;
};

function labelOf(screen: Screen, index: MapIndex): string {
  return isLaunchScreen(screen) ? "Cold start" : screenLabel(screen, index);
}

/** The stage's size, which the frames are fitted to. */
function useSize(): [(element: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}

/**
 * Screens one at a time: the focused screen large in the middle, the screens before and after it smaller and fainter
 * the further they are, in the tree's order. Above it, the rows of the tree it was opened from, ending in its name with
 * its status dot. The neighbours, whose names are not shown, are outlined in their status colour instead.
 */
export function ScreensFilmstrip(props: ScreensFilmstripProps) {
  const [stageRef, stage] = useSize();
  const at = props.order.indexOf(props.focusedId);
  // While a swipe lasts, the strip sits at a fractional position in `order`, following the gesture.
  const [swipe, setSwipe] = useState<{ position: number; direction: number } | null>(null);
  // The swipe's position as of the last wheel event, which can arrive before the render that shows the one before it.
  const live = useRef<number | null>(null);
  const swipeEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(swipeEnd.current), []);
  const focused = props.index.screens.get(props.focusedId);

  // A row of the tree by its fold key, as the path above the frame names it.
  const rowLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const walk = (nodes: readonly ScreenTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "folder") labels.set(node.id, node.label);
        else {
          const screen = props.index.screens.get(node.screenId);
          if (screen) labels.set(treeNodeKey(node), labelOf(screen, props.index));
        }
        walk(node.children);
      }
    };
    walk(props.tree.tree);
    return labels;
  }, [props.index, props.tree]);

  if (!focused || at < 0) return null;

  const sizeOf = (screen: Screen) => screenshotSize(primaryScreenshotForScreen(screen, props.index)) ?? props.typicalSize ?? FALLBACK_SIZE;
  const aspect = (screen: Screen) => {
    const size = sizeOf(screen);
    return size.imageWidth / size.imageHeight;
  };
  // Every frame is laid out as the middle one would be, filling the stage's height short of growing wider than half
  // the stage, so a landscape capture beside portrait ones is as wide as it may be rather than as tall; then it is scaled
  // down around its centre, and the centres are spaced so the scaled frames sit a gap apart, the gap shrinking with them.
  const frameSize = (screen: Screen) => {
    const height = Math.max(0, Math.min(stage.height - 16, (stage.width * 0.5) / aspect(screen)));
    return { width: height * aspect(screen), height };
  };
  // Where each screen sits with the screen at `centre` in the middle: its distance and its centre's offset.
  const layout = (centre: number) => {
    const placed = new Map<string, { distance: number; x: number }>();
    const middle = props.index.screens.get(props.order[centre] ?? "");
    if (!middle) return placed;
    placed.set(props.order[centre]!, { distance: 0, x: 0 });
    for (const direction of [-1, 1]) {
      let edge = frameSize(middle).width / 2;
      for (let distance = 1; distance < SCALES.length; distance++) {
        const id = props.order[centre + direction * distance];
        const screen = id ? props.index.screens.get(id) : undefined;
        if (!id || !screen) break;
        const scaled = frameSize(screen).width * SCALES[distance]!;
        const x = edge + GAP * SCALES[distance]! + scaled / 2;
        placed.set(id, { distance, x: direction * x });
        edge = x + scaled / 2;
      }
    }
    return placed;
  };
  // A swipe someone else's step overtook (an arrow key, a click) no longer places the strip.
  const position = swipe && Math.round(swipe.position) === at ? swipe.position : at;
  const base = Math.floor(position), fraction = position - base;
  const from = layout(base), to = fraction > 0 ? layout(base + 1) : from;
  const lerp = (a: number, b: number) => a + (b - a) * fraction;
  const last = SCALES.length - 1;
  const frames = [...new Set([...from.keys(), ...to.keys()])].flatMap(id => {
    const screen = props.index.screens.get(id);
    if (!screen) return [];
    const a = from.get(id), b = to.get(id);
    // A screen in only one of the two places is coming in or going out at the invisible end.
    const distance = lerp(a?.distance ?? last, b?.distance ?? last);
    const x = lerp(a?.x ?? b!.x, b?.x ?? a!.x);
    const scale = lerp(SCALES[a?.distance ?? last]!, SCALES[b?.distance ?? last]!);
    const opacity = lerp(OPACITIES[a?.distance ?? last]!, OPACITIES[b?.distance ?? last]!);
    return [{ id, screen, distance, x, scale, opacity, ...frameSize(screen) }];
  });
  // The frames' gap at rest, which one screen of swipe travels.
  const pitch = Math.abs(layout(at).get(props.order[at + 1] ?? props.order[at - 1] ?? "")?.x ?? frameSize(focused).width) || 1;

  // A swipe along either axis moves the strip with it, so a mouse wheel works as well as a trackpad; when it ends, the
  // strip settles on a screen.
  const onWheel = (event: WheelEvent) => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const pixels = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * stage.width : delta;
    if (!pixels) return;
    const next = Math.max(0, Math.min(props.order.length - 1, (live.current ?? position) + pixels / pitch));
    live.current = next;
    const direction = Math.sign(pixels);
    setSwipe({ position: next, direction });
    // The middle screen, and with it the path above, follows the swipe as it passes halfway.
    if (Math.round(next) !== at) props.onPick(props.order[Math.round(next)]!);
    clearTimeout(swipeEnd.current);
    swipeEnd.current = setTimeout(() => {
      const settle = direction > 0 ? Math.floor(next + 1 - SWIPE_COMMIT) : Math.ceil(next - 1 + SWIPE_COMMIT);
      const index = Math.max(0, Math.min(props.order.length - 1, settle));
      if (index !== Math.round(next)) props.onPick(props.order[index]!);
      live.current = null;
      setSwipe(null);
    }, SWIPE_END_MS);
  };

  const path = (props.shape.ancestors.get(props.focusedId) ?? []).flatMap(key => rowLabels.get(key) ?? []);
  const plain = props.index.plainTitles || isLaunchScreen(focused);
  const dot = props.dot(props.focusedId);

  return (
    <section className="screens-strip" aria-label="Filmstrip" onWheel={onWheel}>
      <div className="screens-strip-path">
        {path.map((label, position) => (
          <span key={position} className="screens-strip-crumb" title={label}>
            <span className={`screens-strip-crumb-label${plain ? "" : " path"}`}>{label}</span>
            <ChevronRight aria-hidden="true" />
          </span>
        ))}
        <span className="screens-strip-crumb current" title={labelOf(focused, props.index)}>
          {dot ? <span className={`screens-tree-dot ${dot}`} aria-hidden="true" /> : null}
          <span className={`screens-strip-crumb-label${plain ? "" : " path"}`}>{labelOf(focused, props.index)}</span>
        </span>
      </div>

      <div ref={stageRef} className={`screens-strip-stage${swipe ? " swiping" : ""}`}>
        {stage.width > 0 ? frames.map(({ id, screen, distance, x, scale, opacity, width, height }) => {
          const artifact = primaryScreenshotForScreen(screen, props.index);
          const url = artifactUrl(artifact);
          const size = screenshotSize(artifact);
          const placeholder = <span className="screens-strip-placeholder" aria-hidden="true" />;
          const frameDiff = props.diff?.screens.get(id);
          const label = labelOf(screen, props.index);
          const middle = id === props.focusedId;
          const hidden = opacity === 0;
          return (
            <div key={id} id={props.frameId(id)} data-screen-id={id}
              className={`screens-strip-frame${middle ? " focused" : ""}${frameDiff ? ` ${diffClass(frameDiff)}` : ""}${props.dimmed(id) ? " dimmed" : ""}`}
              style={{
                width,
                height,
                opacity,
                zIndex: Math.round((SCALES.length - distance) * 10),
                transform: `translate(-50%, -50%) translateX(${x}px) scale(${scale})`,
              }}>
              {/* Only the middle frame is in the tab order: the arrows step the strip, and focus on a neighbour the stage
                  clips would scroll it off its centre. */}
              <button type="button" className="screens-strip-target" aria-label={label} title={middle ? undefined : label}
                tabIndex={middle ? undefined : -1} aria-hidden={hidden || undefined} disabled={hidden}
                aria-pressed={props.selectedId === id} aria-current={middle ? "true" : undefined}
                onClick={() => (middle ? props.onOpen(id) : props.onPick(id))}>
                {/* A downloaded report's screenshot is a reference that ScreenshotImage resolves. */}
                {url ? (
                  <ScreenshotImage src={url} alt="" draggable={false} decoding="async" loading={distance <= 1.5 ? "eager" : "lazy"}
                    {...(size ? { width: size.imageWidth, height: size.imageHeight } : {})} fallback={placeholder} />
                ) : placeholder}
              </button>
            </div>
          );
        }) : null}
      </div>
    </section>
  );
}
