import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GitCompareArrows, Search, X } from "lucide-react";
import { DIFF_LABELS, type BuildDiff } from "../../utils/build-diff";
import type { MapIndex } from "../../utils/model";
import { FOCUS_LABELS, type FocusStatus } from "../../utils/navigation";
import { displayPathForScreen } from "../../utils/screen-path";
import { AutoHideScrollArea } from "../shared/auto-hide-scroll-area";
import { PanelSearch } from "../shared/panel-search";
import { StatusGlyph } from "../shared/status-icon";
import { Tooltip } from "../shared/tooltip";
import { formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { changedScreens, compareText } from "../../utils/changed-screens";
import "./changes.css";

const STATUSES: FocusStatus[] = ["added", "modified", "removed", "needs-review", "source-affected"];

export type ChangesPanelProps = {
  diff: BuildDiff;
  index: MapIndex;
  active: FocusStatus[];
  counts: Record<FocusStatus, number>;
  selectedScreenId?: string;
  onChangeActive: (active: FocusStatus[]) => void;
  onOpenScreen: (id: string) => void;
};

export function ChangesPanel(props: ChangesPanelProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const allChanges = useMemo(() => changedScreens(props.diff, props.index), [props.diff, props.index]);
  // Source-unchanged screens captured in another runtime state: listed apart, never as changes.
  const variants = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const result: Array<{ id: string; title: string; route: string }> = [];
    for (const [id, screenDiff] of props.diff.screens) {
      if (screenDiff.status !== "variant") continue;
      const screen = props.index.screens.get(id);
      if (!screen) continue;
      const route = displayPathForScreen(screen);
      if (!normalizedQuery || route.toLocaleLowerCase().includes(normalizedQuery)) result.push({ id, title: screen.title, route });
    }
    return result.sort((left, right) => compareText(left.route, right.route) || compareText(left.id, right.id));
  }, [props.diff, props.index, query]);
  const statusChanges = useMemo(() => {
    if (props.active.length === 0) return allChanges;
    const active = new Set(props.active);
    return allChanges.filter((screen) => active.has(screen.status));
  }, [allChanges, props.active]);
  const changes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return statusChanges;
    return statusChanges.filter((screen) => (
      screen.route.toLocaleLowerCase().includes(normalizedQuery)
    ));
  }, [query, statusChanges]);
  // An empty URL filter is the canonical "show everything" state. The first chip pressed narrows
  // the list to its status; more chips add statuses; releasing the last one shows everything again.
  const chipStatuses = STATUSES.filter((status) => props.counts[status] > 0 || props.active.includes(status));
  const toggleStatus = (status: FocusStatus) => {
    const next = props.active.includes(status)
      ? props.active.filter((current) => current !== status)
      : STATUSES.filter((current) => props.active.includes(current) || current === status);
    props.onChangeActive(chipStatuses.every((current) => next.includes(current)) ? [] : next);
  };
  const hasQuery = query.trim().length > 0;
  const statusFiltered = statusChanges.length === 0 && allChanges.length > 0;
  const queryFiltered = changes.length === 0 && statusChanges.length > 0 && hasQuery;
  const hasUncompared = props.diff.counts["not-compared"] + props.diff.counts.unavailable > 0;

  useEffect(() => {
    const body = scrollBodyRef.current;
    if (body) body.scrollTop = 0;
  }, [changes]);

  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  return (
    <section className="changes-panel" aria-label="Review">
      <div className={`changes-panel-heading${searchOpen ? " searching" : ""}`}>
        {searchOpen ? (
          <PanelSearch
            value={query}
            placeholder="Find…"
            ariaLabel="Find changed screens"
            clearLabel="Clear find query"
            name="changes-route-search"
            autoFocus
            onEscape={closeSearch}
            onChange={setQuery}
          />
        ) : (
          <h2 className="changes-panel-title">
            Changes{allChanges.length > 0 ? <span className="changes-panel-count">{allChanges.length}</span> : null}
          </h2>
        )}
        <div className="changes-panel-actions">
          {!searchOpen && (
            <Tooltip label="Find changes" placement="bottom-end">
              <button
                type="button"
                className="icon-button icon-button-sm changes-search-button"
                aria-label="Find changes"
                onClick={() => setSearchOpen(true)}>
                <Search aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          {searchOpen && (
            <Tooltip label="Close find" shortcut={formatShortcut(SHORTCUTS.find.close)} placement="bottom-end">
              <button
                type="button"
                className="icon-button icon-button-sm changes-search-close"
                aria-label="Close find"
                onClick={closeSearch}>
                <X aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="changes-panel-content">
        {chipStatuses.length > 0 ? (
          <div className={`changes-status-chips${props.active.length > 0 ? " filtering" : ""}`} role="group" aria-label="Filter changes">
            {chipStatuses.map((status) => (
              <button
                key={status}
                type="button"
                className={`changes-status-chip diff-${status}`}
                aria-pressed={props.active.includes(status)}
                onClick={() => toggleStatus(status)}>
                <span className="changes-status-chip-dot" aria-hidden="true" />
                {FOCUS_LABELS[status]} {props.counts[status]}
              </button>
            ))}
          </div>
        ) : null}
        <AutoHideScrollArea
          ref={scrollBodyRef}
          shellClassName="changes-panel-scroll-shell"
          className="changes-panel-body"
          scrollbarClassName="changes-panel-scrollbar"
          scrollbarThumbClassName="changes-panel-scrollbar-thumb">
            {changes.length === 0 ? (
              <div className="panel-empty changes-panel-empty" role="status">
                <GitCompareArrows size={20} aria-hidden="true" />
                <strong>
                  {statusFiltered
                    ? "No matching changes"
                    : queryFiltered
                      ? "No matching router paths"
                      : hasUncompared ? "No compared screen changes" : "No screen changes"}
                </strong>
                <span>
                  {statusFiltered
                    ? "Choose another status to see changed screens."
                    : queryFiltered
                      ? "Try a different router path."
                      : hasUncompared
                        ? "Screens without capture evidence remain Not compared."
                        : "This build matches the selected baseline."}
                </span>
              </div>
            ) : (
              <ul className="changes-screen-list">
                {changes.map((screen) => (
                  <li key={screen.id}>
                    <button
                      type="button"
                      className={`changes-screen-row diff-${screen.status}`}
                      aria-label={`Open ${screen.title}, ${DIFF_LABELS[screen.status]}, ${screen.route}`}
                      aria-current={screen.id === props.selectedScreenId ? "true" : undefined}
                      onClick={() => props.onOpenScreen(screen.id)}>
                      <StatusGlyph status={screen.status} />
                      <code className="changes-screen-path" title={screen.title}>{screen.route}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {variants.length > 0 ? (
              <section className="changes-variants" aria-labelledby="changes-variants-title">
                <h3 id="changes-variants-title" className="changes-variants-title">
                  Screen variants <span className="changes-variants-count">{variants.length}</span>
                </h3>
                <p className="changes-variants-note">Source unchanged; captured in a different runtime state.</p>
                <ul className="changes-screen-list">
                  {variants.map((screen) => (
                    <li key={screen.id}>
                      <button
                        type="button"
                        className="changes-screen-row diff-variant"
                        aria-label={`Open ${screen.title}, ${DIFF_LABELS.variant}, ${screen.route}`}
                        aria-current={screen.id === props.selectedScreenId ? "true" : undefined}
                        onClick={() => props.onOpenScreen(screen.id)}>
                        <StatusGlyph status="variant" />
                        <code className="changes-screen-path" title={screen.title}>{screen.route}</code>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
        </AutoHideScrollArea>
      </div>
    </section>
  );
}
