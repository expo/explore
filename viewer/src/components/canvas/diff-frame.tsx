import { diffClass, diffLabel, type DiffStatus } from "../../utils/build-diff";

/**
 * Colour ring + label chip around a screenshot item on any canvas. It sits outside the
 * item's box (negative margins) so layout geometry is untouched. Renders as a span so it can
 * sit inside a button.
 */
export function DiffFrame(props: { status?: DiffStatus | undefined; accessibilityOnly?: boolean | undefined; children: React.ReactNode }) {
  const status = props.status ?? "unchanged";
  const diff = { status, ...(props.accessibilityOnly ? { accessibilityOnly: true as const } : {}) };
  const label = diffLabel(diff);
  return (
    <span className={`diff-frame ${diffClass(diff)}`}>
      {status !== "unchanged" && (
        <span className="diff-label" aria-label={`${label} in this build`}>
          {label}
        </span>
      )}
      {props.children}
    </span>
  );
}
