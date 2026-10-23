import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, GalleryHorizontal, LayoutGrid, ListTree, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { artifactUrl, isLaunchScreen, type ExploreMap, type MapIndex, type Screen } from "../../utils/model";
import { primaryScreenshotForScreen, screenshotSize, typicalScreenshotSize, type ScreenshotSize } from "../../utils/screen-images";
import { diffClass, type BuildDiff, type DiffStatus } from "../../utils/build-diff";
import { focusStatusOf, isCapturedChange } from "../../utils/changed-screens";
import { displayPathForScreen, screenLabel } from "../../utils/screen-path";
import { screenTree, treeIndex, treeNodeKey, treeScreenOrder, type ScreenTree, type ScreenTreeNode } from "../../utils/screen-tree";
import type { Appearance } from "../../utils/appearance";
import type { FocusRequest, FocusStatus, ScreensLayout } from "../../utils/navigation";
import { formatShortcut, SHORTCUTS, shortcutsLive } from "../../utils/shortcuts";
import { normalizeSearchText } from "../../utils/search";
import { createKeyHold } from "../../utils/key-hold";
import { placeholderScreen } from "../../utils/map-frame";
import { reportScreens } from "../../utils/omitted-screens";
import { ScreenScreenshotCard } from "../canvas/screen-screenshot-card";
import { NoScreens } from "../shared/no-screens";
import { useCanvasVisibleFrame } from "../canvas/visible-frame-provider";
import { PhoneSheet } from "../phone/phone-chrome";
import { PanelSearch } from "../shared/panel-search";
import { Tooltip } from "../shared/tooltip";
import { ScreensFilmstrip } from "./screens-filmstrip";
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
  /** The routes a public report never captured: not listed, counted or found, as on the Map (omitted-screens.ts). */
  omittedScreenIds?: ReadonlySet<string> | undefined;
  /** A request (search, the Changes menu) to bring a screen into view; a new key asks again for the same screen. */
  focusRequest?: FocusRequest | undefined;
  /** The Changes menu's status filter: screens outside it are dimmed, as on the Map. */
  focus?: readonly FocusStatus[] | undefined;
  /** The phone layout: a jump bar and a Tree sheet stand in for the sidebar. */
  phone?: boolean;
  /** A request to open the find field (`/` pressed on another canvas); a new key asks again. */
  findRequest?: number | undefined;
  /** The find opened for `findRequest`; the parent drops it so a later visit to Screens does not open it again. */
  onFindRequestDone?: (() => void) | undefined;
  onSelectScreen: (id: string) => void;
  /** The tree and jump bar pick a screen without opening the Inspector; a screenshot click selects it as the canvas does. */
  onPickScreen?: ((id: string) => void) | undefined;
  /** A click on the page around the cards clears the selection, as a click on a canvas's pane does. */
  onClearSelection?: (() => void) | undefined;
  /** Desktop only: every card in a grid, or one screen at a time in a filmstrip. */
  layout?: ScreensLayout | undefined;
  /** A double-click on a card opens it in the filmstrip. */
  onChangeLayout?: ((layout: ScreensLayout) => void) | undefined;
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

/**
 * The canvas widths below which the layout switch drops its labels, and below which it is hidden: the pill at the top
 * left grows to 420px (`--left-collapsed-pill-width`), and the switch keeps clear of it, labelled or not.
 */
const SWITCH_LABELLED_FRAME_WIDTH = 640;
const SWITCH_MINIMUM_FRAME_WIDTH = 540;

/** How soon, and how near, a second click follows the first to make a double-click that opens a card in the filmstrip. */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 8;

/** A shown screen to stand for `selected`: itself, or the nearest shown screen after it in the tree, else before it. */
function nearestShown(selected: string | undefined, shown: readonly string[], tree: readonly string[]): string | undefined {
  if (!selected) return undefined;
  if (shown.includes(selected)) return selected;
  const at = tree.indexOf(selected);
  if (at < 0) return undefined;
  const set = new Set(shown);
  return tree.slice(at + 1).find(id => set.has(id)) ?? tree.slice(0, at).reverse().find(id => set.has(id));
}

/** The key that opens the find field: a character, not a key position, so it is read from the layout like "?". */
export const FIND_KEY = "/";

function isFindKey(event: globalThis.KeyboardEvent): boolean {
  return event.key === FIND_KEY && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** The screens whose route or title contains the query, by id; `undefined` when there is no query. */
function findMatches(screens: readonly Screen[], index: MapIndex, rawQuery: string): Set<string> | undefined {
  const query = normalizeSearchText(rawQuery);
  if (!query) return undefined;
  return new Set(screens
    .filter(screen => [displayPathForScreen(screen), screenLabel(screen, index), screen.title]
      .some(text => normalizeSearchText(text).includes(query)))
    .map(screen => screen.id));
}

/**
 * The tree with only the matching screens and the rows above them, so a find reads as a short list in the tree's own
 * shape; a folder or parent screen kept only for what is under it is marked, as a row outside Changed is.
 */
function pruneTree(nodes: readonly ScreenTreeNode[], matches: ReadonlySet<string>): ScreenTreeNode[] {
  return nodes.flatMap((node) => {
    const children = pruneTree(node.children, matches);
    if (node.kind === "screen" ? matches.has(node.screenId) || children.length : children.length) return [{ ...node, children }];
    return [];
  });
}

function cardId(id: string): string {
  return `screens-card-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * The card in the row above or below a screen's, nearest it across: read from where the cards sit, so it follows the
 * grid however many columns the page has room for. A short last row still takes ↓ from the row above it.
 */
function cardInNextRow(from: string, ids: readonly string[], down: boolean): string | undefined {
  const box = (id: string) => document.getElementById(cardId(id))?.getBoundingClientRect();
  const here = box(from);
  if (!here) return undefined;
  const centre = (rect: DOMRect) => rect.left + rect.width / 2;
  const rows = ids.flatMap(id => {
    const rect = box(id);
    return rect && (down ? rect.top >= here.bottom - 1 : rect.bottom <= here.top + 1) ? [{ id, rect }] : [];
  });
  if (!rows.length) return undefined;
  const nearestTop = down ? Math.min(...rows.map(row => row.rect.top)) : Math.max(...rows.map(row => row.rect.top));
  const row = rows.filter(candidate => Math.abs(candidate.rect.top - nearestTop) < 1);
  return row.reduce((best, candidate) =>
    Math.abs(centre(candidate.rect) - centre(here)) < Math.abs(centre(best.rect) - centre(here)) ? candidate : best).id;
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
  /** The run's screenshot shape, which a screen without a screenshot is framed in. */
  typicalSize?: ScreenshotSize | undefined;
  /** A phone's cell, whose screenshot is its own frame: no well frames it while it loads. */
  phone?: boolean | undefined;
  onSelect: (event: ReactMouseEvent) => void;
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
        placeholderSize={placeholderScreen(props.typicalSize)}
        {...(status ? { diff: status } : {})}
        {...(props.diff?.screens.get(props.screen.id)?.accessibilityOnly ? { accessibilityOnly: true } : {})}
        selected={props.selected}
        ariaPressed={props.selected}
        loading="lazy"
        backing={props.phone === true}
        onClick={props.onSelect}
        {...(props.via || props.elsewhere?.length ? { note: <>
          {props.via ? <span className="screens-cell-via">via “{props.via}”</span> : null}
          {props.elsewhere?.length ? <span className="screens-cell-elsewhere">Changed in {props.elsewhere.join(" and ")}</span> : null}
        </> } : {})}
      />
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
          data-screen-id={screen.id}
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

/** Changed and Accessibility only always: a reader learns the kinds even on a report without one. */
function Legend(props: { others: Appearance[] }) {
  return (
    <div className="screens-tree-legend">
      <span><span className="screens-tree-dot diff-modified" aria-hidden="true" />Changed</span>
      <span><span className="screens-tree-dot diff-modified diff-accessibility-only" aria-hidden="true" />Accessibility only</span>
      {props.others.length ? (
        <span><span className="screens-tree-dot elsewhere" aria-hidden="true" />Changed in {props.others.join(" and ")} only</span>
      ) : null}
    </div>
  );
}

/**
 * Screens as a page that scrolls. On desktop, one grid of every screen in the order of the tree beside it, or the same
 * screens one at a time in a filmstrip (screens-filmstrip.tsx); on a phone, a section per route folder (or per tab,
 * when there are no route files), with the tree behind a Tree button.
 */
export function ScreensView(props: ScreensViewProps) {
  // The report's screens, as the Map draws them: a public report's routes it never captured are not among them.
  const screens = useMemo(() => reportScreens(props.map.screens, props.omittedScreenIds ?? new Set()), [props.map.screens, props.omittedScreenIds]);
  const tree: ScreenTree = useMemo(
    () => screenTree(screens, props.index, props.routeFiles),
    [props.index, screens, props.routeFiles],
  );
  const typicalSize = useMemo(
    () => typicalScreenshotSize(screens.map(screen => screenshotSize(primaryScreenshotForScreen(screen, props.index)))),
    [props.index, screens],
  );
  const changedIds = useMemo(
    () => new Set(screens
      .filter(screen => isChanged(props.diff, screen.id) || (props.changedElsewhere?.get(screen.id)?.length ?? 0) > 0)
      .map(screen => screen.id)),
    [props.changedElsewhere, props.diff, screens],
  );
  const [filter, setFilter] = useState<Filter>(props.phone && changedIds.size > 0 ? "changed" : "all");
  const [treeOpen, setTreeOpen] = useState(false);
  // Find: a query narrows the tree and the grid to the screens whose route or title contains it, inside Changed or All.
  const [query, setQuery] = useState("");
  // The phone layout has no field to show or clear a query, so a query typed on desktop does not narrow it.
  const findQuery = props.phone ? "" : query;
  const matches = useMemo(() => findMatches(screens, props.index, findQuery), [props.index, screens, findQuery]);
  const inChanged = filter === "changed" && changedIds.size > 0;
  const inFilter = inChanged ? changedIds : new Set(screens.map(screen => screen.id));
  const shown = matches ? new Set([...inFilter].filter(id => matches.has(id))) : inFilter;
  const sections = tree.sections
    .map(section => ({ ...section, screenIds: section.screenIds.filter(id => shown.has(id)) }))
    .filter(section => section.screenIds.length > 0);
  // The desktop grid reads in the tree's order, not the sections' (screen-tree.ts).
  const treeOrder = useMemo(() => treeScreenOrder(tree), [tree]);
  const order = props.phone ? sections.flatMap(section => section.screenIds) : treeOrder.filter(id => shown.has(id));
  const others = [...new Set([...(props.changedElsewhere?.values() ?? [])].flat())];
  const filmstrip = !props.phone && props.layout === "filmstrip";
  // The filmstrip always has a screen in the middle: the selection when it is shown; else, when Changed or a find hides
  // it, the nearest shown screen after it in the tree (before it, at the end), as the grid's arrows step from it; else
  // the first screen.
  const stripFocus = filmstrip ? nearestShown(props.selectedScreenId, order, treeOrder) ?? order[0] : undefined;
  // The sidebar folds away to give the screens its width. Each switch of layout starts over: the filmstrip with the
  // sidebar folded, the grid with it open. A find's query lives only in the sidebar's field, so the sidebar stays open
  // while one narrows the screens. Changed folds away with it, and the button left in its place says it is on.
  const [side, setSide] = useState({ filmstrip, collapsed: filmstrip && !findQuery });
  if (side.filmstrip !== filmstrip) setSide({ filmstrip, collapsed: filmstrip && !findQuery });
  const sideCollapsed = side.filmstrip === filmstrip ? side.collapsed : filmstrip && !findQuery;
  const setSideCollapsed = (collapsed: boolean) => setSide({ filmstrip, collapsed });
  // A button that folds or opens the sidebar is replaced by the other one; the keyboard moves to it.
  const toggleSide = (collapsed: boolean) => {
    setSideCollapsed(collapsed);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".screens-side .screens-side-toggle")?.focus());
  };

  // Folding. All keeps the reader's folds and remembers them per report. Changed folds separately, starting
  // each time with only the rows that hold no change folded, so trying Changed never disturbs the folds in All.
  const shape = useMemo(() => treeIndex(tree.tree), [tree]);
  const changedMode = filter === "changed" && changedIds.size > 0;
  const foldedWithoutChanges = () => new Set(shape.keys.filter(key => !(shape.screensUnder.get(key) ?? []).some(id => changedIds.has(id))));
  const storageKey = `explore:screens-folded:${props.map.run.id}`;
  const [foldedAll, setFoldedAll] = useState<ReadonlySet<string>>(() => readFolded(storageKey));
  const [foldedChanged, setFoldedChanged] = useState<ReadonlySet<string>>(foldedWithoutChanges);
  useEffect(() => writeFolded(storageKey, foldedAll), [foldedAll, storageKey]);
  // While a find is on, every row stays open: the pruned tree is the result, and folding it would hide matches.
  const folded = matches ? new Set<string>() : changedMode ? foldedChanged : foldedAll;
  const setFolded = changedMode ? setFoldedChanged : setFoldedAll;
  const toggleFold = (key: string, deep: boolean) => {
    // The find's open rows are not the reader's folds; a fold tried there would replace them all.
    if (matches) return;
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
  const foldAll = shape.keys.length && !matches ? (
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
  const jumpTo = (id: string) => {
    setTreeOpen(false);
    if (!inFilter.has(id)) setFilter("all");
    (props.onPickScreen ?? props.onSelectScreen)(id);
    // The filmstrip brings the screen to its middle itself.
    if (!filmstrip) requestAnimationFrame(() => document.getElementById(cardId(id))?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  const findField = useRef<HTMLDivElement>(null);
  const focusFind = () => findField.current?.querySelector("input")?.focus();
  // `/` focuses the field, deferred a frame so the key itself is not typed into it. A folded sidebar opens first.
  const findOnOpen = useRef(false);
  const openFind = () => {
    if (!sideCollapsed) {
      requestAnimationFrame(focusFind);
      return;
    }
    findOnOpen.current = true;
    setSideCollapsed(false);
  };
  useEffect(() => {
    if (sideCollapsed || !findOnOpen.current) return;
    findOnOpen.current = false;
    requestAnimationFrame(focusFind);
  }, [sideCollapsed]);
  const closeFind = () => {
    setQuery("");
    // The field took the keyboard; hand it back to the page so its arrows work again.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  // `/` from another canvas lands here with the field focused.
  useEffect(() => {
    if (props.findRequest === undefined) return;
    if (!props.phone) openFind();
    props.onFindRequestDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new request focuses it once
  }, [props.findRequest]);
  // The find field heads the tree on desktop.
  const findSearch = props.phone ? null : (
    <div ref={findField} className="screens-find">
      <PanelSearch
        value={query}
        placeholder="Search"
        ariaLabel="Find screens"
        clearLabel="Clear find query"
        name="screens-find"
        hint={<kbd className="screens-find-key" aria-hidden="true">{FIND_KEY}</kbd>}
        onEscape={() => (query ? setQuery("") : closeFind())}
        onChange={setQuery}
      />
    </div>
  );
  const filterChips = changedIds.size > 0 ? (
    <div className="screens-filter" role="group" aria-label="Show">
      {(["changed", "all"] as const).map((value) => (
        <button key={value} type="button" className="screens-chip" aria-pressed={filter === value}
          onClick={() => {
            if (value === "changed" && filter !== "changed") setFoldedChanged(foldedWithoutChanges());
            setFilter(value);
          }}>
          {value === "changed" ? "Changed" : "All"}
          <span className="screens-chip-count">{value === "changed" ? changedIds.size : screens.length}</span>
        </button>
      ))}
    </div>
  ) : null;

  // A selection made elsewhere (search, the map, the Inspector) scrolls its card to the middle of
  // the page, as a pick in the tree does; a card already in view stays put.
  const scroller = useRef<HTMLElement>(null);
  const cardClick = useRef<{ id: string; at: number; x: number; y: number } | undefined>(undefined);
  const selected = props.selectedScreenId;
  const focusKey = props.focusRequest?.id === selected ? props.focusRequest?.key : undefined;
  const selectedShown = selected !== undefined && shown.has(selected);
  const selectedShownRef = useRef(selectedShown);
  selectedShownRef.current = selectedShown;
  // A screen selected elsewhere that Changed hides shows every screen instead, as a pick in the tree does.
  // Only a new selection or request switches it; choosing Changed afterwards is the reader's call.
  useEffect(() => {
    if (!selected || selectedShownRef.current) return;
    setFilter("all");
    setQuery("");
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
    if (!selected || !selectedShown || filmstrip) return;
    const card = document.getElementById(cardId(selected));
    if (!card || !scroller.current) return;
    const bounds = card.getBoundingClientRect();
    const view = scroller.current.getBoundingClientRect();
    if (bounds.top < view.top || bounds.bottom > view.bottom) card.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected, selectedShown, focusKey, filmstrip]);

  // On desktop the arrow keys move through the cards: ← and → in their order on the page (`order`), as the arrows step
  // through screens in Compare, and ↑ and ↓ to the card above or below, by where the cards sit, so they follow the grid
  // at any width. A step picks the screen as the tree does, leaving the Inspector as it is, and focus follows it; with
  // nothing picked, → and ↓ start at the first card, and a pick that Changed hides steps from where it sits in the tree.
  // The tree's rows keep their arrow keys, and so do the Inspector's controls. Phones are left as they were.
  // Held, an arrow keeps stepping as Compare's do (key-hold.ts). Return opens the picked screen in the Inspector, as a
  // click on its card does; on the card itself the button already does. In the filmstrip, ← and → step from the screen
  // in the middle and Return opens it.
  const orderRef = useRef(order);
  orderRef.current = order;
  const treeOrderRef = useRef(treeOrder);
  treeOrderRef.current = treeOrder;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // In the filmstrip the arrows step from the screen in the middle, which is the pick once there is one.
  const stripFocusRef = useRef(stripFocus);
  stripFocusRef.current = stripFocus;
  const pickRef = useRef(props.onPickScreen ?? props.onSelectScreen);
  pickRef.current = props.onPickScreen ?? props.onSelectScreen;
  const openRef = useRef(props.onSelectScreen);
  openRef.current = props.onSelectScreen;
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  useEffect(() => {
    if (props.phone) return;
    /** The card an arrow moves to from `from` (the pick, or the last card a hold stepped to). */
    const next = (code: string, from: string | undefined): string | undefined => {
      const ids = orderRef.current;
      const vertical = code === "ArrowUp" || code === "ArrowDown";
      const forward = code === "ArrowRight" || code === "ArrowDown";
      // The filmstrip is one row.
      if (vertical && stripFocusRef.current !== undefined) return undefined;
      if (from && ids.includes(from)) return vertical ? cardInNextRow(from, ids, forward) : ids[ids.indexOf(from) + (forward ? 1 : -1)];
      if (from && treeOrderRef.current.includes(from)) {
        // Picked, but hidden by Changed: the nearest shown card past it in the tree's order.
        const shownIds = new Set(ids);
        const all = treeOrderRef.current;
        const at = all.indexOf(from);
        return (forward ? all.slice(at + 1) : all.slice(0, at).reverse()).find(candidate => shownIds.has(candidate));
      }
      return forward ? ids[0] : ids[ids.length - 1];
    };
    const go = (id: string) => {
      pickRef.current(id);
      requestAnimationFrame(() => document.getElementById(cardId(id))?.querySelector<HTMLElement>(".screen-screenshot-target, .screens-strip-target")?.focus({ preventScroll: true }));
    };
    // A held arrow keeps stepping from the card the last step landed on, not the lagging pick.
    const hold = createKeyHold();
    const beginHold = (code: string, at: string) => {
      hold.begin(code, () => {
        const id = next(code, at);
        if (!id) return false;
        at = id;
        go(id);
        return true;
      });
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      hold.interrupt(event);
      if (isFindKey(event)) {
        if (event.defaultPrevented || !shortcutsLive(event)) return;
        event.preventDefault();
        openFindRef.current();
        return;
      }
      const arrow = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code);
      if (!arrow && event.key !== "Enter") return;
      // In the find field the results below are the field's: ↓ and ↑ step the pick through them in page order while
      // the field keeps the keyboard, and Return opens the picked one (the first match before any step).
      // Its clear button keeps its own Return, and an input method's Return confirms the text being composed.
      if (event.target instanceof Element && event.target.matches(".screens-find input")) {
        if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.code === "ArrowLeft" || event.code === "ArrowRight") return;
        const ids = orderRef.current;
        // In the filmstrip they step from the screen in the middle, as the page's arrows do.
        const picked = stripFocusRef.current ?? (selectedRef.current && ids.includes(selectedRef.current) ? selectedRef.current : undefined);
        const id = !arrow ? picked ?? ids[0] : next(event.code === "ArrowDown" ? "ArrowRight" : "ArrowLeft", picked);
        if (!id) return;
        event.preventDefault();
        if (!arrow) { openRef.current(id); return; }
        pickRef.current(id);
        // The filmstrip brings the screen to its middle itself; scrolling its frame would move the page under it.
        if (stripFocusRef.current === undefined) requestAnimationFrame(() => document.getElementById(cardId(id))?.scrollIntoView({ block: "nearest" }));
        return;
      }
      // The browser's own repeat of a held arrow would scroll the page under the hold.
      if (event.repeat && hold.holding(event.code)) { event.preventDefault(); return; }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented || !shortcutsLive(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!arrow) {
        // Return on a button or a link presses it; elsewhere on the page it opens the pick.
        const selectedId = stripFocusRef.current ?? selectedRef.current;
        if (target?.closest("button, a, [role=\"button\"]") || !target?.closest("body") || !selectedId || !orderRef.current.includes(selectedId)) return;
        if (target !== document.body && !target.closest(".screens-page")) return;
        event.preventDefault();
        openRef.current(selectedId);
        return;
      }
      // The page, or the bottom toolbar that Screens was just opened from, or the layout switch just used; their buttons
      // have no arrow keys of their own.
      const onPage = !target || target === document.body || target.closest(".screens-page, .canvas-toolbar, .screens-layout-switch") !== null;
      if (!onPage || target?.closest(".screens-tree-list")) return;
      const id = next(event.code, stripFocusRef.current ?? selectedRef.current);
      if (!id) return;
      event.preventDefault();
      go(id);
      beginHold(event.code, id);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (hold.holding(event.code)) hold.end();
    };
    const endHold = hold.end;
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", endHold);
    return () => {
      endHold();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endHold);
    };
  }, [props.phone]);

  // A double-click on a card's screenshot opens that screen in the filmstrip. The first click selects it and opens the
  // Inspector, which narrows the grid and can slide over the card, so the second click may land on another card or on
  // the Inspector: the double-click is heard on the whole document, and the screen opened is the one the first click
  // picked. The route under a screenshot copies a link and is no click on the card.
  const openFilmstripRef = useRef<((id: string) => void) | undefined>(undefined);
  openFilmstripRef.current = !props.phone && !filmstrip && props.onChangeLayout ? (id: string) => {
    (props.onPickScreen ?? props.onSelectScreen)(id);
    props.onChangeLayout!("filmstrip");
  } : undefined;
  useEffect(() => {
    const onDoubleClick = (event: MouseEvent) => {
      const first = cardClick.current;
      // A double-click elsewhere, or later, is not this card's.
      if (!first || event.timeStamp - first.at > DOUBLE_CLICK_MS
        || Math.hypot(event.clientX - first.x, event.clientY - first.y) > DOUBLE_CLICK_SLOP_PX) return;
      cardClick.current = undefined;
      openFilmstripRef.current?.(first.id);
    };
    document.addEventListener("dblclick", onDoubleClick);
    return () => document.removeEventListener("dblclick", onDoubleClick);
  }, []);

  // The Inspector floats over the right edge; the page keeps its content clear of it.
  const { visibleFrame } = useCanvasVisibleFrame();
  const style = !props.phone && visibleFrame
    ? ({ "--screens-right-inset": `calc(100% - ${visibleFrame.x + visibleFrame.width}px)` } as CSSProperties)
    : undefined;

  if (screens.length === 0) return <NoScreens map={props.map} />;

  // Grid or Filmstrip, in words, at the top right where the Map keeps its camera: outside the page, so it stays put
  // as the grid scrolls, and clear of the Inspector.
  // A canvas narrowed by the Inspector keeps the switch's icons only, clear of the pill; one too narrow for even those
  // hides it, as the Map's camera hides (camera-controls.tsx). Esc, a double-click and closing the Inspector remain.
  const frameWidth = visibleFrame?.width ?? Infinity;
  const layoutSwitch = !props.phone && props.onChangeLayout && frameWidth >= SWITCH_MINIMUM_FRAME_WIDTH ? (
    <div className={`screens-layout-switch${frameWidth < SWITCH_LABELLED_FRAME_WIDTH ? " compact" : ""}`} role="group" aria-label="Screens layout"
      style={visibleFrame ? ({ "--screens-switch-right": `calc(100% - ${visibleFrame.x + visibleFrame.width}px)` } as CSSProperties) : undefined}>
      {([
        ["grid", "Grid", <LayoutGrid key="grid" aria-hidden="true" />, SHORTCUTS.screens.grid],
        ["filmstrip", "Filmstrip", <GalleryHorizontal key="filmstrip" aria-hidden="true" />, SHORTCUTS.screens.filmstrip],
      ] as const)
        .map(([value, label, icon, shortcut]) => (
          <Tooltip key={value} label={label} shortcut={formatShortcut(shortcut)} placement="bottom">
            <button type="button" aria-label={label} aria-pressed={(filmstrip ? "filmstrip" : "grid") === value}
              onClick={() => props.onChangeLayout!(value)}>
              {icon}<span aria-hidden="true">{label}</span>
            </button>
          </Tooltip>
        ))}
    </div>
  ) : null;

  const dimmed = (id: string) => Boolean(props.focus?.length) && !props.focus!.some((state) => state === focusStatusOf(props.diff?.screens.get(id)));
  const cell = (id: string) => {
    const screen = props.index.screens.get(id);
    return screen ? (
      <ScreenCell key={id} screen={screen} index={props.index} diff={props.diff}
        elsewhere={isChanged(props.diff, id) ? undefined : props.changedElsewhere?.get(id)}
        via={tree.via.get(id)}
        typicalSize={typicalSize}
        phone={props.phone}
        selected={props.selectedScreenId === id}
        dimmed={dimmed(id)}
        onSelect={(event) => {
          // The second click of a double-click selects nothing: it may land on another card the first click's Inspector
          // moved under the pointer. The first click is kept with its place, for the double-click that follows.
          if (event.detail >= 2) return;
          cardClick.current = { id, at: event.timeStamp, x: event.clientX, y: event.clientY };
          props.onSelectScreen(id);
        }} />
    ) : null;
  };

  // A find inside Changed can match only screens Changed hides; the empty state says so and offers All.
  const noMatch = `No ${inChanged ? "changed " : ""}screens match “${findQuery.trim()}”`;
  const matchedElsewhere = matches && inChanged ? [...matches].filter(id => !inFilter.has(id)).length : 0;

  const treeRows = (
    <ul className="screens-tree-list" onKeyDown={onTreeKey}>
      <TreeRows nodes={matches ? pruneTree(tree.tree, matches) : tree.tree} depth={0} index={props.index} diff={props.diff} elsewhere={props.changedElsewhere}
        visible={shown} selectedScreenId={props.selectedScreenId} folded={folded}
        onToggle={toggleFold} onSelect={jumpTo} />
    </ul>
  );

  return (
    <>
    {layoutSwitch}
    <main ref={scroller} className={`screens-page${props.phone ? " phone" : ""}${filmstrip ? " filmstrip" : ""}`} aria-label="Screens" style={style}
      onClick={(event) => {
        // The filmstrip always shows a screen; clearing the pick there would only jump it back to the first.
        if (!props.onClearSelection || !props.selectedScreenId || filmstrip) return;
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
        {props.phone ? null : sideCollapsed ? (
          <aside className="screens-side collapsed">
            <button type="button" className={`screens-side-toggle${inChanged ? " narrowed" : ""}`} aria-expanded={false}
              aria-label={inChanged ? "Show sidebar, showing changed screens only" : "Show sidebar"}
              title={inChanged ? "Show sidebar · Changed only" : "Show sidebar"}
              onClick={() => toggleSide(false)}>
              <PanelLeftOpen aria-hidden="true" />
            </button>
          </aside>
        ) : (
          <aside className="screens-side">
            <nav className="screens-tree" aria-label={tree.mode === "source" ? "Route files" : "Navigation"}>
              {/* The find field heads the tree with fold-all and the sidebar's own fold beside it, so a report without
                  changes has no empty row; Changed / All follows under it, the whole width, when there are changes. */}
              <div className="screens-tree-head">
                {findSearch}{foldAll}
                {/* Folding the sidebar away clears its find, which would otherwise narrow the screens out of sight. */}
                <button type="button" className="screens-side-toggle" aria-label="Hide sidebar" title="Hide sidebar" aria-expanded
                  onClick={() => { setQuery(""); toggleSide(true); }}>
                  <PanelLeftClose aria-hidden="true" />
                </button>
              </div>
              {filterChips}
              {matches && order.length === 0
                ? <p className="screens-find-empty" role="status">{noMatch}</p>
                : treeRows}
              {props.diff ? <Legend others={others} /> : null}
            </nav>
          </aside>
        )}
        <div className="screens-sections">
          {props.phone ? sections.map(section => (
            <section key={section.id} id={sectionAnchor(section.id)} className="screens-section" aria-label={section.name ?? section.title}>
              <header className="screens-section-head">
                <h2>{section.name ?? section.title}</h2>
                {section.path ? <span className="path">{breakAfterSlashes(section.title)}</span>
                  : section.subtitle ? <span>{section.subtitle}</span> : null}
              </header>
              <div className="screens-grid">{section.screenIds.map(cell)}</div>
            </section>
          )) : (
            // On desktop the tree beside the page already shows the folders, so every screen sits in one evenly
            // spaced grid in the tree's order, without headings between them.
            matches && order.length === 0
              ? <div className="page-empty compact-empty screens-empty" role="status"><h2>{noMatch}</h2>{matchedElsewhere
                ? <p>{matchedElsewhere === 1 ? "1 screen outside Changed matches." : `${matchedElsewhere} screens outside Changed match.`}{" "}
                  <button type="button" className="screens-empty-all" onPointerDown={(event) => event.preventDefault()}
                    onClick={() => { setFilter("all"); focusFind(); }}>Show all</button></p>
                : <p>Try part of a route, or press Esc to show every {inChanged ? "changed " : ""}screen.</p>}</div>
              : stripFocus ? (
                <ScreensFilmstrip order={order} focusedId={stripFocus} selectedId={props.selectedScreenId}
                  index={props.index} diff={props.diff} tree={tree} shape={shape}
                  typicalSize={typicalSize} frameId={cardId} dimmed={dimmed}
                  dot={(id) => dotClass(props.diff, props.changedElsewhere, id)}
                  onPick={props.onPickScreen ?? props.onSelectScreen} onOpen={props.onSelectScreen} />
              )
              : <div className="screens-grid">{order.map(cell)}</div>
          )}
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
    </>
  );
}
