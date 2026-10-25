import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { artifactUrl, isLaunchScreen, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize, type ScreenshotSize } from "../../utils/screen-images";
import { diffClass, type BuildDiff } from "../../utils/build-diff";
import { screenLabel } from "../../utils/screen-path";
import { treeNodeKey, type ScreenTree, type ScreenTreeIndex, type ScreenTreeNode } from "../../utils/screen-tree";
import { Filmstrip } from "../shared/filmstrip";
import { ScreenshotImage } from "../shared/screenshot-image";

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
  /** Brings a screen to the middle without opening the Inspector; `replace` keeps it out of the history. */
  onPick: (id: string, options?: { replace?: boolean }) => void;
  /** Selects a screen and opens it in the Inspector, as a click on its card does. */
  onOpen: (id: string) => void;
  /** The phone layout: the middle screen takes most of the width, and a finger swipes the strip. */
  phone?: boolean | undefined;
};

function labelOf(screen: Screen, index: MapIndex): string {
  return isLaunchScreen(screen) ? "Cold start" : screenLabel(screen, index);
}

/**
 * Screens one at a time, in the tree's order. Above them, the rows of the tree the middle screen was opened from,
 * ending in its name with its status dot. The neighbours, whose names are not shown, are outlined in their status colour
 * instead.
 */
export function ScreensFilmstrip(props: ScreensFilmstripProps) {
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
  const focused = props.index.screens.get(props.focusedId);
  if (!focused) return null;

  const items = props.order.flatMap(id => {
    const screen = props.index.screens.get(id);
    if (!screen) return [];
    const size = screenshotSize(primaryScreenshotForScreen(screen, props.index)) ?? props.typicalSize ?? FALLBACK_SIZE;
    return [{ id, aspect: size.imageWidth / size.imageHeight }];
  });
  const path = (props.shape.ancestors.get(props.focusedId) ?? []).flatMap(key => rowLabels.get(key) ?? []);
  const plain = props.index.plainTitles || isLaunchScreen(focused);
  const dot = props.dot(props.focusedId);
  const header = (
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
  );

  return (
    <Filmstrip items={items} focusedId={props.focusedId} header={header} ariaLabel="Filmstrip" phone={props.phone}
      frameId={props.frameId} idAttribute="data-screen-id"
      frameClass={(id) => {
        const frameDiff = props.diff?.screens.get(id);
        return [frameDiff ? diffClass(frameDiff) : "", props.dimmed(id) ? "dimmed" : ""].filter(Boolean).join(" ") || undefined;
      }}
      label={(id) => { const screen = props.index.screens.get(id); return screen ? labelOf(screen, props.index) : id; }}
      selected={(id) => props.selectedId === id}
      onPick={props.onPick} onOpen={props.onOpen}
      content={(id, { distance }) => {
        const screen = props.index.screens.get(id)!;
        const artifact = primaryScreenshotForScreen(screen, props.index);
        const url = artifactUrl(artifact);
        const size = screenshotSize(artifact);
        const placeholder = <span className="screens-strip-placeholder" aria-hidden="true" />;
        // A downloaded report's screenshot is a reference that ScreenshotImage resolves.
        return url ? (
          <ScreenshotImage src={url} alt="" draggable={false} decoding="async" loading={distance <= 1.5 ? "eager" : "lazy"}
            {...(size ? { width: size.imageWidth, height: size.imageHeight } : {})} fallback={placeholder} />
        ) : placeholder;
      }} />
  );
}
