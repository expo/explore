import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Route, Search, X } from "lucide-react";
import { searchItems, type SearchItem } from "../utils/search";
import { AutoHideScrollArea } from "./shared/auto-hide-scroll-area";
import { useModalDialog } from "../hooks/use-modal-dialog";

const KIND_LABELS: Record<SearchItem["kind"], string> = {
  screen: "Screen",
};

function ResultIcon() {
  return <Route strokeWidth={1.75} />;
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
    () => query.trim() ? searchItems(props.items, query) : [...props.suggestions],
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
    }
  };

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
            aria-label="Search screens"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            {...(results.length > 0
              ? { "aria-activedescendant": `${listboxId}-option-${activeIndex}` }
              : {})}
            autoComplete="off"
            spellCheck="false"
            placeholder="Search screens"
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

        <div className="search-command-section-label">
          {query.trim() ? "Results" : "Suggested"}
        </div>
        {results.length > 0 ? (
          <AutoHideScrollArea
            id={listboxId}
            shellClassName="search-command-results-shell"
            className="search-command-results"
            role="listbox">
            {results.map((item, index) => (
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
                  <ResultIcon />
                </span>
                <span className="search-command-result-copy">
                  <strong>{item.kind === "screen" ? <code>{item.title}</code> : item.title}</strong>
                  {item.context && <small>{item.context}</small>}
                </span>
                <span className="search-command-result-kind">{KIND_LABELS[item.kind]}</span>
                {activeIndex === index && <CornerDownLeft className="search-command-enter" aria-hidden="true" />}
              </button>
            ))}
          </AutoHideScrollArea>
        ) : (
          <div className="search-command-empty" role="status">
            <Search aria-hidden="true" />
            <strong>No results</strong>
            <span>Try another screen.</span>
          </div>
        )}
      </div>
    </div>
  );
}
