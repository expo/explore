import { diffLabel, type DiffStatus } from "../../utils/build-diff";

/**
 * Colour ring + label chip around a screenshot item on any canvas. It sits outside the
 * item's box (negative margins) so layout geometry is untouched. Renders as a span so it can
 * sit inside a button.
 */
export function DiffFrame(props: { status?: DiffStatus | undefined; notVisible?: boolean | undefined; children: React.ReactNode }) {
  const status = props.status ?? "unchanged";
  const label = diffLabel({ status, ...(props.notVisible ? { notVisible: true as const } : {}) });
  return (
    <span className={`diff-frame diff-${status}`}>
      {status !== "unchanged" && (
        <span className="diff-label" aria-label={`${label} in this build`}>
          {label}
        </span>
      )}
      {props.children}
    </span>
  );
}
