import { useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { ChevronRight } from "lucide-react";
import { artifactUrl, isLaunchScreen, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize, type ScreenshotSize } from "../../utils/screen-images";
import { diffClass, type BuildDiff } from "../../utils/build-diff";
import { screenLabel } from "../../utils/screen-path";
import { treeNodeKey, type ScreenTree, type ScreenTreeIndex, type ScreenTreeNode } from "../../utils/screen-tree";
import { ScreenshotImage } from "../shared/screenshot-image";

/** A neighbour's size and opacity by its distance from the screen in the middle. */
const SCALES = [1, 0.74, 0.54, 0.4];
const OPACITIES = [1, 0.9, 0.6, 0.3];
const GAP = 32;
/** A trackpad swipe or a mouse wheel steps the strip by a screen for every this much travel; a pause starts the count again. */
const WHEEL_STEP_PX = 100;
const WHEEL_PAUSE_MS = 250;
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
  // The wheel's travel since its last pause, and the screen it has stepped to, which can run ahead of the render.
  const wheel = useRef({ travel: 0, last: 0, index: -1 });
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
  const middle = frameSize(focused);
  const frames: { id: string; screen: Screen; distance: number; x: number; width: number; height: number }[] = [
    { id: props.focusedId, screen: focused, distance: 0, x: 0, ...middle },
  ];
  for (const direction of [-1, 1]) {
    let edge = middle.width / 2;
    for (let distance = 1; distance < SCALES.length; distance++) {
      const id = props.order[at + direction * distance];
      const screen = id ? props.index.screens.get(id) : undefined;
      if (!id || !screen) break;
      const size = frameSize(screen);
      const scaled = size.width * SCALES[distance]!;
      const centre = edge + GAP * SCALES[distance]! + scaled / 2;
      frames.push({ id, screen, distance, x: direction * centre, ...size });
      edge = centre + scaled / 2;
    }
  }

  // A swipe along either axis steps, so a mouse wheel works as well as a trackpad; a longer swipe steps further.
  const onWheel = (event: WheelEvent) => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const pixels = event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * stage.width : delta;
    const state = wheel.current;
    if (event.timeStamp - state.last > WHEEL_PAUSE_MS) { state.travel = 0; state.index = at; }
    state.last = event.timeStamp;
    state.travel += pixels;
    const steps = Math.trunc(state.travel / WHEEL_STEP_PX);
    if (!steps) return;
    state.travel -= steps * WHEEL_STEP_PX;
    const index = Math.max(0, Math.min(props.order.length - 1, state.index + steps));
    if (index === state.index) return;
    state.index = index;
    props.onPick(props.order[index]!);
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

      <div ref={stageRef} className="screens-strip-stage">
        {stage.width > 0 ? frames.map(({ id, screen, distance, x, width, height }) => {
          const artifact = primaryScreenshotForScreen(screen, props.index);
          const url = artifactUrl(artifact);
          const size = screenshotSize(artifact);
          const placeholder = <span className="screens-strip-placeholder" aria-hidden="true" />;
          const frameDiff = props.diff?.screens.get(id);
          const scale = SCALES[distance]!;
          const label = labelOf(screen, props.index);
          return (
            <div key={id} id={props.frameId(id)} data-screen-id={id}
              className={`screens-strip-frame${distance === 0 ? " focused" : ""}${frameDiff ? ` ${diffClass(frameDiff)}` : ""}${props.dimmed(id) ? " dimmed" : ""}`}
              style={{
                width,
                height,
                opacity: OPACITIES[distance],
                zIndex: SCALES.length - distance,
                transform: `translate(-50%, -50%) translateX(${x}px) scale(${scale})`,
              }}>
              {/* Only the middle frame is in the tab order: the arrows step the strip, and focus on a neighbour the stage
                  clips would scroll it off its centre. */}
              <button type="button" className="screens-strip-target" aria-label={label} title={distance === 0 ? undefined : label}
                tabIndex={distance === 0 ? undefined : -1}
                aria-pressed={props.selectedId === id} aria-current={distance === 0 ? "true" : undefined}
                onClick={() => (distance === 0 ? props.onOpen(id) : props.onPick(id))}>
                {/* A downloaded report's screenshot is a reference that ScreenshotImage resolves. */}
                {url ? (
                  <ScreenshotImage src={url} alt="" draggable={false} decoding="async" loading={distance <= 1 ? "eager" : "lazy"}
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
