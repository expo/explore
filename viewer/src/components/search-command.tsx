import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Command, CornerDownLeft, Route, Search, X } from "lucide-react";
import { searchItems, type SearchItem, type SearchItemKind } from "../utils/search";
import { AutoHideScrollArea } from "./shared/auto-hide-scroll-area";
import { useModalDialog } from "../hooks/use-modal-dialog";

/** Screens are labelled; a command's key, or nothing, sits where the label would. */
const KIND_LABELS: Record<SearchItemKind, string> = {
  screen: "Screen",
  command: "Command",
};

function ResultIcon({ kind }: { kind: SearchItemKind }) {
  return kind === "screen" ? <Route strokeWidth={1.75} /> : <Command strokeWidth={1.75} />;
}

/** The results grouped by kind, in the order the first result sets, so ↑ and ↓ step through the rows as they read. */
function groupedByKind(results: readonly SearchItem[]): SearchItem[] {
  return [...new Set(results.map((item) => item.kind))].flatMap((kind) => results.filter((item) => item.kind === kind));
}

/** Grouped results in their sections, with each item's place in the flat list. */
function sections(results: readonly SearchItem[], suggested: boolean): { label: string; entries: { item: SearchItem; index: number }[] }[] {
  const byKind = new Map<SearchItemKind, { item: SearchItem; index: number }[]>();
  results.forEach((item, index) => {
    const entries = byKind.get(item.kind) ?? [];
    entries.push({ item, index });
    byKind.set(item.kind, entries);
  });
  return [...byKind].map(([kind, entries]) => ({
    label: kind === "command" ? (suggested ? "Suggested" : "Commands") : suggested ? "Selected screen" : "Screens",
    entries,
  }));
}

type SearchCommandProps = {
  open: boolean;
  items: readonly SearchItem[];
  suggestions: readonly SearchItem[];
  onClose: () => void;
  onSelectScreen: (screenId: string) => void;
};

export function SearchCommand(props: SearchCommandProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog(props.open, props.onClose);
  const listboxId = useId();
  const results = useMemo(
    () => groupedByKind(query.trim() ? searchItems(props.items, query) : props.suggestions),
    [props.items, props.suggestions, query],
  );

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex < results.length) return;
    setActiveIndex(Math.max(results.length - 1, 0));
  }, [activeIndex, results.length]);

  useEffect(() => {
    if (!props.open || results.length === 0) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId, props.open, results.length]);

  if (!props.open) return null;

  const select = (item: SearchItem) => {
    props.onClose();
    if (item.kind === "screen" && item.screenId) {
      props.onSelectScreen(item.screenId);
    } else if (item.kind === "command") {
      item.run?.();
    }
  };
  const suggested = !query.trim();

  const moveActive = (delta: number) => {
    if (results.length === 0) return;
    setActiveIndex((current) => (current + delta + results.length) % results.length);
  };

  return (
    <div className="dialog-backdrop search-command-backdrop" onPointerDown={(event) => {
      if (event.target !== event.currentTarget) return;
      // Swallow the tap: without this the click that follows lands on whatever is under the backdrop.
      event.preventDefault();
      props.onClose();
    }}>
      <div
        ref={dialogRef}
        className="search-command"
        role="dialog"
        aria-modal="true"
        aria-label="Search Explore">
        <div className="search-command-input-row">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search screens and commands"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            {...(results.length > 0
              ? { "aria-activedescendant": `${listboxId}-option-${activeIndex}` }
              : {})}
            autoComplete="off"
            spellCheck="false"
            placeholder="Search screens and commands"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Enter" && results[activeIndex]) {
                event.preventDefault();
                select(results[activeIndex]);
              }
            }}
          />
          <kbd>Esc</kbd>
          <button type="button" className="search-command-close" aria-label="Close search" onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </div>

        {results.length > 0 ? (
          <AutoHideScrollArea
            id={listboxId}
            shellClassName="search-command-results-shell"
            className="search-command-results"
            role="listbox">
            {sections(results, suggested).map((section) => (
              <div key={section.label} className="search-command-section" role="group" aria-label={section.label}>
                <div className="search-command-section-label">{section.label}</div>
                {section.entries.map(({ item, index }) => (
                  <button
                    key={item.id}
                    id={`${listboxId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={activeIndex === index}
                    className={`search-command-result${activeIndex === index ? " active" : ""}`}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => select(item)}>
                    <span className={`search-command-result-icon result-${item.kind}`} aria-hidden="true">
                      <ResultIcon kind={item.kind} />
                    </span>
                    <span className="search-command-result-copy">
                      <strong>{item.kind === "screen" ? <code>{item.title}</code> : item.title}</strong>
                      {item.context && <small>{item.context}</small>}
                    </span>
                    {item.shortcut
                      ? <kbd className="search-command-result-key">{item.shortcut}</kbd>
                      : item.kind === "screen" ? <span className="search-command-result-kind">{KIND_LABELS[item.kind]}</span> : null}
                    {activeIndex === index && <CornerDownLeft className="search-command-enter" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            ))}
          </AutoHideScrollArea>
        ) : (
          <div className="search-command-empty" role="status">
            <Search aria-hidden="true" />
            <strong>No results</strong>
            <span>Try a route, or a command such as “dark” or “fit”.</span>
          </div>
        )}
      </div>
    </div>
  );
}
