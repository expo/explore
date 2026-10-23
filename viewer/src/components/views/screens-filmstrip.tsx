import { useLayoutEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { artifactUrl, isLaunchScreen, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize, type ScreenshotSize } from "../../utils/screen-images";
import { diffClass, diffLabel, type BuildDiff } from "../../utils/build-diff";
import { screenLabel } from "../../utils/screen-path";
import { treeNodeKey, type ScreenTree, type ScreenTreeIndex, type ScreenTreeNode } from "../../utils/screen-tree";
import type { Appearance } from "../../utils/appearance";

/** A neighbour's size and opacity by its distance from the screen in the middle. */
const SCALES = [1, 0.74, 0.54, 0.4];
const OPACITIES = [1, 0.9, 0.6, 0.3];
const GAP = 32;
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
  elsewhere?: ReadonlyMap<string, Appearance[]> | undefined;
  tree: ScreenTree;
  shape: ScreenTreeIndex;
  typicalSize?: ScreenshotSize | undefined;
  /** The element id a screen's frame takes, which the page's arrow keys focus by. */
  frameId: (id: string) => string;
  /** The tree's dot class for a screen, which its scrubber tick takes. */
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
 * the further they are, in the tree's order. Above it, the rows of the tree it was opened from; below it, its name,
 * how it was reached and where it sits, and a scrubber with a tick for every screen, grouped as the tree's top rows are.
 */
export function ScreensFilmstrip(props: ScreensFilmstripProps) {
  const [stageRef, stage] = useSize();
  const at = props.order.indexOf(props.focusedId);
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

  // The scrubber's groups: the tree's top rows, or the rows inside a lone top folder (source mode's `app/`).
  const groups = useMemo(() => {
    const roots = props.tree.tree.length === 1 && props.tree.tree[0]!.kind === "folder" ? props.tree.tree[0]!.children : props.tree.tree;
    const shown = new Set(props.order);
    const place = new Map(props.order.map((id, position) => [id, position]));
    const grouped = new Set<string>();
    const result = roots.flatMap((node) => {
      const under = node.children.length ? props.shape.screensUnder.get(treeNodeKey(node)) ?? [] : [];
      const ids = [...(node.kind === "screen" ? [node.screenId] : []), ...under]
        .filter(id => shown.has(id))
        .sort((left, right) => place.get(left)! - place.get(right)!);
      if (!ids.length) return [];
      ids.forEach(id => grouped.add(id));
      const label = node.kind === "folder" ? node.label : rowLabels.get(treeNodeKey(node)) ?? "";
      return [{ key: node.kind === "folder" ? node.id : node.screenId, label, ids }];
    });
    const rest = props.order.filter(id => !grouped.has(id));
    return rest.length ? [...result, { key: "rest", label: "Other", ids: rest }] : result;
  }, [props.order, props.shape, props.tree, rowLabels]);

  if (!focused || at < 0) return null;

  const sizeOf = (screen: Screen) => screenshotSize(primaryScreenshotForScreen(screen, props.index)) ?? props.typicalSize ?? FALLBACK_SIZE;
  const aspect = (screen: Screen) => {
    const size = sizeOf(screen);
    return size.imageWidth / size.imageHeight;
  };
  // The middle frame fills the stage's height, short of a landscape capture growing wider than half the stage.
  const height = Math.max(120, Math.min(stage.height - 16, (stage.width * 0.5) / aspect(focused)));
  // Each frame is laid out at the middle frame's height and scaled down around its centre; the centres are spaced so
  // the scaled frames sit a gap apart, the gap shrinking with them.
  const middleWidth = height * aspect(focused);
  const frames: { id: string; screen: Screen; distance: number; x: number; width: number }[] = [
    { id: props.focusedId, screen: focused, distance: 0, x: 0, width: middleWidth },
  ];
  for (const direction of [-1, 1]) {
    let edge = middleWidth / 2;
    for (let distance = 1; distance < SCALES.length; distance++) {
      const id = props.order[at + direction * distance];
      const screen = id ? props.index.screens.get(id) : undefined;
      if (!id || !screen) break;
      const width = height * aspect(screen);
      const scaled = width * SCALES[distance]!;
      const centre = edge + GAP * SCALES[distance]! + scaled / 2;
      frames.push({ id, screen, distance, x: direction * centre, width });
      edge = centre + scaled / 2;
    }
  }

  const screenDiff = props.diff?.screens.get(props.focusedId);
  const status = screenDiff && screenDiff.status !== "unchanged" ? screenDiff : undefined;
  const via = props.tree.via.get(props.focusedId);
  const elsewhere = props.elsewhere?.get(props.focusedId);
  const tab = props.tree.tree.some(function isTab(node): boolean {
    return (node.kind === "screen" && node.screenId === props.focusedId && node.tab === true) || node.children.some(isTab);
  });
  const path = (props.shape.ancestors.get(props.focusedId) ?? []).flatMap(key => rowLabels.get(key) ?? []);
  const plain = props.index.plainTitles || isLaunchScreen(focused);

  return (
    <section className="screens-strip" aria-label="Filmstrip">
      <nav className="screens-strip-path" aria-label="Opened from">
        {path.map((label, position) => (
          <span key={position} className="screens-strip-crumb">
            <span className={plain ? undefined : "path"}>{label}</span>
            <ChevronRight aria-hidden="true" />
          </span>
        ))}
        <span className={`screens-strip-crumb current${plain ? "" : " path"}`}>{labelOf(focused, props.index)}</span>
      </nav>

      <div ref={stageRef} className="screens-strip-stage">
        {stage.width > 0 ? frames.map(({ id, screen, distance, x, width }) => {
          const artifact = primaryScreenshotForScreen(screen, props.index);
          const url = artifactUrl(artifact);
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
              <button type="button" className="screens-strip-target" aria-label={label} title={distance === 0 ? undefined : label}
                aria-pressed={props.selectedId === id} aria-current={distance === 0 ? "true" : undefined}
                onClick={() => (distance === 0 ? props.onOpen(id) : props.onPick(id))}>
                {url ? <img src={url} alt="" draggable={false} /> : <span className="screens-strip-placeholder" aria-hidden="true" />}
              </button>
            </div>
          );
        }) : null}
      </div>

      <div className="screens-strip-caption">
        <button type="button" className="screens-strip-step" aria-label="Previous screen" disabled={at === 0}
          onClick={() => props.onPick(props.order[at - 1]!)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <div className="screens-strip-title">
          <div className="screens-strip-name">
            <h2 className={plain ? undefined : "path"}>{labelOf(focused, props.index)}</h2>
            {tab ? <span className="screens-strip-kind">tab</span> : null}
            {status ? (
              <span className={`screens-strip-status ${diffClass(status)}`}>
                <span className="screens-tree-dot" aria-hidden="true" />{diffLabel(status)}
              </span>
            ) : null}
          </div>
          <p className="screens-strip-meta">
            {via ? <>via “{via}” · </> : null}
            {at + 1} of {props.order.length}
            {elsewhere?.length && !status ? <> · <span className="screens-cell-elsewhere">Changed in {elsewhere.join(" and ")}</span></> : null}
          </p>
        </div>
        <button type="button" className="screens-strip-step" aria-label="Next screen" disabled={at === props.order.length - 1}
          onClick={() => props.onPick(props.order[at + 1]!)}>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>

      <div className="screens-strip-scrubber" role="group" aria-label="Every screen">
        {groups.map(group => (
          <div key={group.key} className={`screens-strip-group${group.ids.includes(props.focusedId) ? " current" : ""}`}>
            <div className="screens-strip-ticks">
              {group.ids.map(id => {
                const screen = props.index.screens.get(id);
                const dot = props.dot(id);
                return (
                  <button key={id} type="button" tabIndex={-1}
                    className={`screens-strip-tick${id === props.focusedId ? " current" : ""}${dot ? ` ${dot}` : ""}`}
                    aria-label={screen ? labelOf(screen, props.index) : id} title={screen ? labelOf(screen, props.index) : id}
                    onClick={() => props.onPick(id)} />
                );
              })}
            </div>
            <span className="screens-strip-group-label">{group.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
