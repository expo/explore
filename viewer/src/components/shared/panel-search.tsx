import { useRef } from "react";
import { Search, X } from "lucide-react";
import "./panel-search.css";

type PanelSearchProps = {
  value: string;
  placeholder: string;
  ariaLabel: string;
  clearLabel: string;
  name?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
  onChange: (value: string) => void;
};

/** Canonical compact search field shared by panel inventories and floating navigators. */
export function PanelSearch(props: PanelSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="panel-search">
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        {...(props.name ? { name: props.name } : {})}
        autoFocus={props.autoFocus}
        autoComplete="off"
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        value={props.value}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !props.onEscape) return;
          event.preventDefault();
          props.onEscape();
        }}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.value && (
        <button
          type="button"
          className="panel-search-clear"
          aria-label={props.clearLabel}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            props.onChange("");
            inputRef.current?.focus();
          }}>
          <X strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
