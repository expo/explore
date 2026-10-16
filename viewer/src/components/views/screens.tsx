import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, ListTree } from "lucide-react";
import { artifactUrl, isLaunchScreen, type ExploreMap, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize } from "../../utils/screen-images";
import { diffClass, isAccessibilityOnly, type BuildDiff, type DiffStatus } from "../../utils/build-diff";
import { isCapturedChange } from "../../utils/changed-screens";
import { displayPathForScreen, screenLabel } from "../../utils/screen-path";
import { screenTree, treeIndex, treeNodeKey, type ScreenTree, type ScreenTreeNode } from "../../utils/screen-tree";
import type { Appearance } from "../../utils/appearance";
import type { FocusRequest, FocusStatus } from "../../utils/navigation";
import { ScreenScreenshotCard } from "../canvas/screen-screenshot-card";
import { useCanvasVisibleFrame } from "../canvas/visible-frame-provider";
import { PhoneSheet } from "../phone/phone-chrome";
import "./screens.css";

/** The statuses a tree dot marks. The Changed filter keeps only the screens whose captures differ (isCapturedChange). */
const CHANGED_STATUSES = new Set<DiffStatus>(["modified", "added", "removed", "needs-review", "source-affected"]);

type Filter = "changed" | "all";

export type ScreensViewProps = {
  map: ExploreMap;
  index: MapIndex;
  diff?: BuildDiff | undefined;
  /** Route files the review read, by screen id: with them the page groups the way `app/` is laid out. */
  routeFiles?: ReadonlyMap<string, string> | undefined;
  /** The other appearances each screen changed in, when the report captured several. */
  changedElsewhere?: ReadonlyMap<string, Appearance[]> | undefined;
  selectedScreenId?: string | undefined;
  /** A request (search, the Changes menu) to bring a screen into view; a new key asks again for the same screen. */
  focusRequest?: FocusRequest | undefined;
  /** The Changes menu's status filter: screens outside it are dimmed, as on the Map. */
  focus?: readonly FocusStatus[] | undefined;
  /** The phone layout: a jump bar and a Tree sheet stand in for the sidebar. */
  phone?: boolean;
  onSelectScreen: (id: string) => void;
  /** The tree and jump bar pick a screen without opening the Inspector; a screenshot click selects it as the canvas does. */
  onPickScreen?: ((id: string) => void) | undefined;
  /** A click on the page around the cards clears the selection, as a click on a canvas's pane does. */
  onClearSelection?: (() => void) | undefined;
};

function statusOf(diff: BuildDiff | undefined, id: string): DiffStatus | undefined {
  return diff?.screens.get(id)?.status;
}

function isChanged(diff: BuildDiff | undefined, id: string): boolean {
  return isCapturedChange(diff?.screens.get(id));
}

/** The dot beside a tree row: changed here, changed only in another appearance, or nothing. */
function dotClass(diff: BuildDiff | undefined, elsewhere: ReadonlyMap<string, Appearance[]> | undefined, id: string): string | undefined {
  const screen = diff?.screens.get(id);
  if (screen && CHANGED_STATUSES.has(screen.status)) return diffClass(screen);
  if (elsewhere?.get(id)?.length) return "elsewhere";
  return undefined;
}

/** The rows a reader folded in All, remembered per report; storage that is unavailable remembers nothing. */
function readFolded(key: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch { return new Set(); }
}

function writeFolded(key: string, folded: ReadonlySet<string>): void {
  try {
    if (folded.size) localStorage.setItem(key, JSON.stringify([...folded]));
    else localStorage.removeItem(key);
  } catch { /* Folds last for this visit only. */ }
}

function cardId(id: string): string {
  return `screens-card-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function sectionAnchor(id: string): string {
  return `screens-section-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** A route folder that wraps at its slashes rather than mid-segment. */
function breakAfterSlashes(path: string): ReactNode[] {
  return path.split("/").flatMap((segment, index) => (index === 0 ? [segment] : ["/", <wbr key={index} />, segment]));
}

function ScreenCell(props: {
  screen: Screen;
  index: MapIndex;
  diff?: BuildDiff | undefined;
  elsewhere?: Appearance[] | undefined;
  via?: string | undefined;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  const artifact = primaryScreenshotForScreen(props.screen, props.index);
  const url = artifactUrl(artifact);
  const size = screenshotSize(artifact);
  const status = statusOf(props.diff, props.screen.id);
  return (
    <div className={`screens-cell${props.dimmed ? " dimmed" : ""}`} id={cardId(props.screen.id)} data-screen-id={props.screen.id}>
      <ScreenScreenshotCard
        className="screens-card"
        ariaLabel={props.screen.title}
        title={props.screen.title}
        path={displayPathForScreen(props.screen)}
        {...(props.index.plainTitles ? { plainTitle: true } : {})}
        {...(url ? { screenshot: url } : {})}
        {...(size ? size : {})}
        {...(status ? { diff: status } : {})}
        {...(props.diff?.screens.get(props.screen.id)?.accessibilityOnly ? { accessibilityOnly: true } : {})}
        selected={props.selected}
        ariaPressed={props.selected}
        loading="lazy"
        onClick={props.onSelect}
      />
      {props.via ? <span className="screens-cell-via">via “{props.via}”</span> : null}
      {props.elsewhere?.length ? (
        <span className="screens-cell-elsewhere">Changed in {props.elsewhere.join(" and ")}</span>
      ) : null}
    </div>
  );
}

function TreeRows(props: {
  nodes: ScreenTreeNode[];
  depth: number;
  index: MapIndex;
  diff?: BuildDiff | undefined;
  elsewhere?: ReadonlyMap<string, Appearance[]> | undefined;
  visible: ReadonlySet<string>;
  selectedScreenId?: string | undefined;
  folded: ReadonlySet<string>;
  onToggle: (key: string, deep: boolean) => void;
  onSelect: (id: string) => void;
}) {
  return props.nodes.map((node) => {
    const style = { "--tree-depth": props.depth } as CSSProperties;
    const key = node.children.length ? treeNodeKey(node) : undefined;
    const open = key === undefined || !props.folded.has(key);
    const twisty = <span className="screens-tree-twisty" aria-hidden="true">{key ? <ChevronRight /> : null}</span>;
    const children = key && open ? (
      <ul>
        <TreeRows {...props} nodes={node.children} depth={props.depth + 1} />
      </ul>
    ) : null;
    if (node.kind === "folder") {
      return (
        <li key={node.id}>
          <button type="button" className="screens-tree-row folder" style={style} aria-expanded={open} data-tree-key={key}
            onClick={(event) => props.onToggle(node.id, event.altKey)}>
            {twisty}
            <span className="screens-tree-dot" aria-hidden="true" />
            <span className="screens-tree-label path">{node.label}</span>
          </button>
          {children}
        </li>
      );
    }
    const screen = props.index.screens.get(node.screenId);
    if (!screen) return null;
    const dot = dotClass(props.diff, props.elsewhere, screen.id);
    const launch = isLaunchScreen(screen);
    const label = launch ? "Cold start" : screenLabel(screen, props.index);
    return (
      <li key={node.screenId} className={key ? "screens-tree-parent" : undefined}>
        <button type="button" style={style}
          className={`screens-tree-row${node.tab ? " tab" : ""}${props.visible.has(screen.id) ? "" : " filtered"}`}
          aria-current={props.selectedScreenId === screen.id ? "true" : undefined}
          aria-expanded={key ? open : undefined}
          data-tree-key={key}
          onClick={() => props.onSelect(screen.id)}>
          {twisty}
          <span className={`screens-tree-dot${dot ? ` ${dot}` : ""}`} aria-hidden="true" />
          <span className={`screens-tree-label${props.index.plainTitles || launch ? "" : " path"}`}>{label}</span>
          {node.tab ? <span className="screens-tree-kind">tab</span> : null}
        </button>
        {/* A screen row selects its screen; the chevron over its twisty folds what was opened from it. */}
        {key ? (
          <button type="button" className="screens-tree-toggle" style={style} tabIndex={-1}
            aria-label={open ? `Fold ${label}` : `Unfold ${label}`}
            onClick={(event) => props.onToggle(key, event.altKey)} />
        ) : null}
        {children}
      </li>
    );
  });
}

function Legend(props: { others: Appearance[]; accessibilityOnly: boolean }) {
  return (
    <div className="screens-tree-legend">
      <span><span className="screens-tree-dot diff-modified" aria-hidden="true" />Changed</span>
      {props.accessibilityOnly ? (
        <span><span className="screens-tree-dot diff-modified diff-accessibility-only" aria-hidden="true" />Accessibility only</span>
      ) : null}
      {props.others.length ? (
        <span><span className="screens-tree-dot elsewhere" aria-hidden="true" />Changed in {props.others.join(" and ")} only</span>
      ) : null}
      <span><span className="screens-tree-dot diff-source-affected" aria-hidden="true" />Source-affected</span>
    </div>
  );
}

/**
 * Screens as a page that scrolls: a section per route folder (or per tab, when there are no route
 * files), with the tree of them beside it on desktop and behind a Tree button on a phone.
 */
export function ScreensView(props: ScreensViewProps) {
  const tree: ScreenTree = useMemo(
    () => screenTree(props.map.screens, props.index, props.routeFiles),
    [props.index, props.map.screens, props.routeFiles],
  );
  const changedIds = useMemo(
    () => new Set(props.map.screens
      .filter(screen => isChanged(props.diff, screen.id) || (props.changedElsewhere?.get(screen.id)?.length ?? 0) > 0)
      .map(screen => screen.id)),
    [props.changedElsewhere, props.diff, props.map.screens],
  );
  const [filter, setFilter] = useState<Filter>(props.phone && changedIds.size > 0 ? "changed" : "all");
  const [treeOpen, setTreeOpen] = useState(false);
  const shown = filter === "changed" && changedIds.size > 0 ? changedIds : new Set(props.map.screens.map(screen => screen.id));
  const sections = tree.sections
    .map(section => ({ ...section, screenIds: section.screenIds.filter(id => shown.has(id)) }))
    .filter(section => section.screenIds.length > 0);
  const others = [...new Set([...(props.changedElsewhere?.values() ?? [])].flat())];

  // Folding. All keeps the reader's folds and remembers them per report. Changed folds separately, starting
  // each time with only the rows that hold no change folded, so trying Changed never disturbs the folds in All.
  const shape = useMemo(() => treeIndex(tree.tree), [tree]);
  const changedMode = filter === "changed" && changedIds.size > 0;
  const foldedWithoutChanges = () => new Set(shape.keys.filter(key => !(shape.screensUnder.get(key) ?? []).some(id => changedIds.has(id))));
  const storageKey = `explore:screens-folded:${props.map.run.id}`;
  const [foldedAll, setFoldedAll] = useState<ReadonlySet<string>>(() => readFolded(storageKey));
  const [foldedChanged, setFoldedChanged] = useState<ReadonlySet<string>>(foldedWithoutChanges);
  useEffect(() => writeFolded(storageKey, foldedAll), [foldedAll, storageKey]);
  const folded = changedMode ? foldedChanged : foldedAll;
  const setFolded = changedMode ? setFoldedChanged : setFoldedAll;
  const toggleFold = (key: string, deep: boolean) => {
    const fold = !folded.has(key);
    // ⌥-click folds or unfolds every row inside this one too.
    const inside = (candidate: string): boolean => {
      const parent = shape.parents.get(candidate);
      return parent !== undefined && (parent === key || inside(parent));
    };
    const keys = deep ? [key, ...shape.keys.filter(inside)] : [key];
    const next = new Set(folded);
    for (const each of keys) if (fold) next.add(each); else next.delete(each);
    setFolded(next);
  };
  const anyOpen = shape.keys.some(key => !folded.has(key));
  const foldAll = shape.keys.length ? (
    <button type="button" className="screens-tree-fold-all" aria-label={anyOpen ? "Collapse all" : "Expand all"}
      title={anyOpen ? "Collapse all" : "Expand all"}
      onClick={() => setFolded(anyOpen ? new Set(shape.keys) : new Set())}>
      {anyOpen ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
    </button>
  ) : null;
  // ↑ and ↓ move between rows; ← folds a row and → unfolds it, as in any tree.
  const onTreeKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as Element).closest<HTMLButtonElement>(".screens-tree-row");
    if (!row) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".screens-tree-row")];
      rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const key = row.dataset.treeKey;
      if (key && folded.has(key) === (event.key === "ArrowRight")) toggleFold(key, false);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const filterChips = changedIds.size > 0 ? (
    <div className="screens-filter" role="group" aria-label="Show">
      {(["changed", "all"] as const).map((value) => (
        <button key={value} type="button" className="screens-chip" aria-pressed={filter === value}
          onClick={() => {
            if (value === "changed" && filter !== "changed") setFoldedChanged(foldedWithoutChanges());
            setFilter(value);
          }}>
          {value === "changed" ? "Changed" : "All"}
          <span className="screens-chip-count">{value === "changed" ? changedIds.size : props.map.screens.length}</span>
        </button>
      ))}
    </div>
  ) : null;

  // A selection made elsewhere (search, the map, the Inspector) scrolls its card to the middle of
  // the page, as a pick in the tree does; a card already in view stays put.
  const scroller = useRef<HTMLElement>(null);
  const selected = props.selectedScreenId;
  const focusKey = props.focusRequest?.id === selected ? props.focusRequest?.key : undefined;
  const selectedShown = selected !== undefined && shown.has(selected);
  const selectedShownRef = useRef(selectedShown);
  selectedShownRef.current = selectedShown;
  // A screen selected elsewhere that Changed hides shows every screen instead, as a pick in the tree does.
  // Only a new selection or request switches it; choosing Changed afterwards is the reader's call.
  useEffect(() => {
    if (selected && !selectedShownRef.current) setFilter("all");
  }, [selected, focusKey]);
  // A selection made anywhere unfolds the rows above it, in both filters.
  useEffect(() => {
    const above = selected ? shape.ancestors.get(selected) ?? [] : [];
    if (!above.length) return;
    const unfold = (current: ReadonlySet<string>) => (above.some(key => current.has(key)) ? new Set([...current].filter(key => !above.includes(key))) : current);
    setFoldedAll(unfold);
    setFoldedChanged(unfold);
  }, [selected, focusKey, shape]);
  useEffect(() => {
    if (!selected || !selectedShown) return;
    const card = document.getElementById(cardId(selected));
    if (!card || !scroller.current) return;
    const bounds = card.getBoundingClientRect();
    const view = scroller.current.getBoundingClientRect();
    if (bounds.top < view.top || bounds.bottom > view.bottom) card.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, selectedShown, focusKey]);

  const jumpTo = (id: string) => {
    setTreeOpen(false);
    if (!shown.has(id)) setFilter("all");
    (props.onPickScreen ?? props.onSelectScreen)(id);
    requestAnimationFrame(() => document.getElementById(cardId(id))?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  // The Inspector floats over the right edge; the page keeps its content clear of it.
  const { visibleFrame } = useCanvasVisibleFrame();
  const style = !props.phone && visibleFrame
    ? ({ "--screens-right-inset": `calc(100% - ${visibleFrame.x + visibleFrame.width}px)` } as CSSProperties)
    : undefined;

  const treeRows = (
    <ul className="screens-tree-list" onKeyDown={onTreeKey}>
      <TreeRows nodes={tree.tree} depth={0} index={props.index} diff={props.diff} elsewhere={props.changedElsewhere}
        visible={shown} selectedScreenId={props.selectedScreenId} folded={folded}
        onToggle={toggleFold} onSelect={jumpTo} />
    </ul>
  );

  return (
    <main ref={scroller} className={`screens-page${props.phone ? " phone" : ""}`} aria-label="Screens" style={style}
      onClick={(event) => {
        if (!props.onClearSelection || !props.selectedScreenId) return;
        if ((event.target as Element).closest("button, a, input, .screens-cell, .screens-side")) return;
        props.onClearSelection();
      }}>
      {props.phone && filterChips ? <div className="screens-head">{filterChips}</div> : null}

      {props.phone ? (
        <nav className="screens-jump" aria-label="Sections">
          <button type="button" className="screens-jump-chip tree" onClick={() => setTreeOpen(true)}>
            <ListTree aria-hidden="true" />Tree
          </button>
          {sections.map(section => {
            const dot = section.screenIds.map(id => dotClass(props.diff, props.changedElsewhere, id)).find(Boolean);
            return (
              <a key={section.id} className="screens-jump-chip" href={`#${sectionAnchor(section.id)}`}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(sectionAnchor(section.id))?.scrollIntoView({ block: "start", behavior: "smooth" });
                }}>
                {dot ? <span className={`screens-tree-dot ${dot}`} aria-hidden="true" /> : null}
                <span>{section.name ?? section.title}</span>
                <span className="screens-chip-count">{section.screenIds.length}</span>
              </a>
            );
          })}
        </nav>
      ) : null}

      <div className="screens-body">
        {props.phone ? null : (
          <aside className="screens-side">
            <nav className="screens-tree" aria-label={tree.mode === "source" ? "Route files" : "Navigation"}>
              {filterChips || foldAll ? <div className="screens-tree-head">{filterChips}{foldAll}</div> : null}
              <h2>{tree.mode === "source" ? "app/" : "Explored app"}</h2>
              {treeRows}
              {props.diff ? <Legend others={others} accessibilityOnly={[...props.diff.screens.values()].some(isAccessibilityOnly)} /> : null}
            </nav>
          </aside>
        )}
        <div className="screens-sections">
          {sections.map(section => (
            <section key={section.id} id={sectionAnchor(section.id)} className="screens-section" aria-label={section.name ?? section.title}>
              <header className="screens-section-head">
                <h2>{section.name ?? section.title}</h2>
                {section.path ? <span className="path">{breakAfterSlashes(section.title)}</span>
                  : section.subtitle ? <span>{section.subtitle}</span> : null}
              </header>
              <div className="screens-grid">
                {section.screenIds.map(id => {
                  const screen = props.index.screens.get(id);
                  return screen ? (
                    <ScreenCell key={id} screen={screen} index={props.index} diff={props.diff}
                      elsewhere={isChanged(props.diff, id) ? undefined : props.changedElsewhere?.get(id)}
                      via={tree.via.get(id)}
                      selected={props.selectedScreenId === id}
                      dimmed={Boolean(props.focus?.length) && !props.focus!.some((state) => state === statusOf(props.diff, id))}
                      onSelect={() => props.onSelectScreen(id)} />
                  ) : null;
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {props.phone ? (
        <PhoneSheet title={tree.mode === "source" ? "app/" : "Explored app"} open={treeOpen} onClose={() => setTreeOpen(false)}>
          <div className="screens-tree phone">
            {foldAll ? <div className="screens-tree-head">{foldAll}</div> : null}
            {treeRows}
          </div>
        </PhoneSheet>
      ) : null}
    </main>
  );
}
