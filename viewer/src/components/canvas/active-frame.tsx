import type { ReactNode } from "react";

/**
 * Shared canvas selection feedback. The wrapper fills, but does not resize, its canvas node;
 * an absolute overlay gives Map and Screens the same accent border without changing fit.
 */
export function CanvasActiveFrame(props: {
  as?: "div" | "span" | undefined;
  selected?: boolean | undefined;
  highlighted?: boolean | undefined;
  children: ReactNode;
}) {
  const Element = props.as ?? "span";
  const className = [
    "canvas-active-frame",
    props.selected ? "is-selected" : undefined,
    props.highlighted ? "is-highlighted" : undefined,
  ].filter(Boolean).join(" ");
  return (
    <Element className={className}>
      {props.children}
    </Element>
  );
}
