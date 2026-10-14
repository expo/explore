import { useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "./tooltip";

export type ToggleOption<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
  /** Shown beside the label; a zero count is left off rather than drawn as "0". */
  count?: number;
  disabled?: boolean;
  /** Shown as a tooltip; icon-only options use it as the accessible name. */
  title?: string;
  /** The option's key, shown in its tooltip. */
  shortcut?: string;
};

type ToggleGroupProps<T extends string> = {
  value: T;
  options: ToggleOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `pill` is the inspector-tab style; `flat` drops the container for inline use. */
  variant?: "pill" | "flat";
  iconOnly?: boolean;
  /** Off as a whole: every option is disabled and none shows as the current one. */
  disabled?: boolean;
  /**
   * Arrow keys move the choice, as in a radio group (the default). Set false where the arrows
   * belong to the page: the options become pressed buttons, each one reached with Tab.
   */
  arrowKeys?: boolean;
};

/**
 * Segmented control. The `pill` variant draws its active state as a second, identical row of
 * labels clipped to the active option with `clip-path`, so switching slides the highlight (and
 * the label colour with it) instead of snapping — the technique from
 * emilkowal.ski/ui/the-magic-of-clip-path. The `flat` variant carries no chip at all: colour is
 * the only state, for both hover and active.
 */
export function ToggleGroup<T extends string>(props: ToggleGroupProps<T>) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState<{ left: number; right: number }>();
  const activeIndex = props.options.findIndex((option) => option.id === props.value);
  const sliding = (props.variant ?? "pill") === "pill";
  const arrowKeys = props.arrowKeys ?? true;

  useLayoutEffect(() => {
    const base = baseRef.current;
    if (!base || !sliding) return;
    const measure = () => {
      const buttons = base.querySelectorAll<HTMLElement>(".toggle-button");
      const active = buttons[activeIndex];
      if (!active || base.clientWidth === 0) {
        setClip(undefined);
        return;
      }
      const baseBox = base.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      // Boxes are in screen pixels; a zoomed ancestor (the large-window chrome scale) draws the
      // clip in its own, unzoomed pixels.
      const zoom = base.offsetWidth > 0 ? baseBox.width / base.offsetWidth : 1;
      setClip({
        left: (box.left - baseBox.left) / zoom,
        right: (baseBox.right - box.right) / zoom,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(base);
    return () => observer.disconnect();
  }, [activeIndex, props.options.length, sliding]);

  const moveSelection = (event: React.KeyboardEvent<HTMLButtonElement>, optionIndex: number) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    const enabled = props.options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !props.disabled && !option.disabled);
    if (enabled.length === 0) return;
    const current = Math.max(0, enabled.findIndex(({ index }) => index === optionIndex));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? enabled.length - 1
        : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + enabled.length)
          % enabled.length;
    const next = enabled[nextIndex];
    if (!next) return;
    event.preventDefault();
    props.onChange(next.option.id);
    requestAnimationFrame(() => {
      baseRef.current
        ?.querySelector<HTMLButtonElement>(`[data-toggle-index="${next.index}"]`)
        ?.focus();
    });
  };

  const renderOptions = (overlay: boolean) => props.options.map((option, optionIndex) => {
    const active = !props.disabled && option.id === props.value;
    const disabled = Boolean(props.disabled || option.disabled);
    const button = (
      <button
        key={option.id}
        type="button"
        role={overlay || !arrowKeys ? undefined : "radio"}
        tabIndex={overlay ? -1 : active || !arrowKeys ? 0 : -1}
        data-toggle-index={overlay ? undefined : optionIndex}
        className={`toggle-button${active ? " active" : ""}`}
        aria-checked={overlay || !arrowKeys ? undefined : active}
        aria-pressed={overlay || arrowKeys ? undefined : active}
        aria-label={!overlay && props.iconOnly ? option.title ?? option.label : undefined}
        disabled={disabled}
        onKeyDown={overlay || !arrowKeys ? undefined : (event) => moveSelection(event, optionIndex)}
        onClick={overlay ? undefined : () => props.onChange(option.id)}>
        {option.icon}
        {!props.iconOnly && <span className="toggle-label">{option.label}</span>}
        {option.count !== undefined && option.count > 0 && (
          <span className="toggle-count">{option.count}</span>
        )}
      </button>
    );
    if (overlay || !option.title) return button;
    return (
      <Tooltip key={option.id} label={option.title} shortcut={option.shortcut} placement="bottom">
        {button}
      </Tooltip>
    );
  });

  return (
    <div
      className={`toggle-group toggle-${props.variant ?? "pill"}${props.disabled ? " disabled" : ""}`}
      role={arrowKeys ? "radiogroup" : "group"}
      aria-label={props.ariaLabel}>
      <div ref={baseRef} className="toggle-row">
        {renderOptions(false)}
      </div>
      {sliding && clip && (
        <div
          className="toggle-row toggle-overlay"
          aria-hidden="true"
          style={{ clipPath: `inset(0 ${clip.right}px 0 ${clip.left}px round 6px)` }}>
          {renderOptions(true)}
        </div>
      )}
    </div>
  );
}
