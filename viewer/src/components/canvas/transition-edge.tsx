import { useEffect, useRef, useState } from "react";
import {
  BaseEdge,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export type TransitionEdgeData = {
  /** The tapped control or navigation kind; the hover title when the edge has no richer tooltip. */
  label: string;
  transitionCount: number;
  active: boolean;
  primary: boolean;
  /** Another screen is selected: the edge steps back to a hairline, so the selection's own stand out. */
  quiet: boolean;
  sourceOnly?: boolean;
  previousSource?: boolean;
  tooltip?: string;
};

export type TransitionGraphEdge = Edge<TransitionEdgeData, "transition">;

/** The map draws arrows only; each connection keeps its evidence in the arrow's hover title. */
export function TransitionEdge(props: EdgeProps<TransitionGraphEdge>) {
  const [hovered, setHovered] = useState(false);
  const hitArea = useRef<SVGPathElement>(null);
  // React Flow marks every edge wrapper `nopan`, so a drag that starts on an edge would never pan
  // the map. Edges here are only hover and click targets, so the wrapper gives that class up.
  useEffect(() => {
    hitArea.current?.parentElement?.classList.remove("nopan");
  });
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.24,
  });
  const emphasized = Boolean(props.data?.active || props.selected || hovered);
  const quiet = Boolean(props.data?.quiet && !emphasized);
  const stroke = emphasized
    ? "var(--accent)"
    : quiet ? "var(--border-subtle)"
    : props.data?.previousSource ? "var(--danger)" : props.data?.primary ? "var(--graph-line)" : "var(--graph-line-soft)";

  return (
    <>
      <path
        ref={hitArea}
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        className="transition-edge-hitarea"
        data-navigation-provenance={props.data?.sourceOnly ? "source" : "observed"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>
        {(props.data?.tooltip || props.data?.label) && <title>{props.data.tooltip || props.data.label}</title>}
      </path>
      <BaseEdge
        path={path}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        interactionWidth={0}
        className="transition-edge-path"
        style={{
          ...props.style,
          stroke,
          strokeWidth: emphasized ? 2.5 : quiet ? 1 : props.data?.primary ? 1.15 : 0.9,
          strokeDasharray: props.data?.sourceOnly ? "6 5" : emphasized || props.data?.primary ? undefined : "4 7",
        }}
      />
    </>
  );
}
