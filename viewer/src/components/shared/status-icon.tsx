import { Minus, Plus } from "lucide-react";
import { diffClass, type DiffStatus } from "../../utils/build-diff";

/**
 * A screen's diff status as a bare glyph in the status colour: + added, − removed, a dot for the
 * rest. The Changes list marks its rows with it; a header that names the same screen uses it too.
 * With a label it is an image of that name; without one it is decoration beside text that says it.
 * An accessibility-only change is a square in its own colour, so it does not rest on colour alone.
 */
export function StatusGlyph(props: { status: DiffStatus; accessibilityOnly?: boolean | undefined; label?: string; className?: string }) {
  const glyph = props.status === "added" ? <Plus />
    : props.status === "removed" ? <Minus />
      : <span className="status-glyph-dot" />;
  return (
    <span className={`status-glyph ${diffClass({ status: props.status, ...(props.accessibilityOnly ? { accessibilityOnly: true as const } : {}) })}${props.className ? ` ${props.className}` : ""}`}
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": true })}>
      {glyph}
    </span>
  );
}
