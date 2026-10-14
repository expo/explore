import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CanvasVisibleFrame } from "./camera";
import {
  calculateCanvasVisibleFrame,
  type CanvasFrameRect,
  type CanvasHardOccluder,
} from "./visible-frame";

export type CanvasVisibleFrameContextValue = {
  visibleFrame: CanvasVisibleFrame | undefined;
};

export type CanvasVisibleFrameProviderProps = {
  children: ReactNode;
  className?: string;
  /** Changes when panels are mounted, unmounted, expanded, or collapsed. */
  layoutKey: string | number;
  onFrameChange?: (
    frame: CanvasVisibleFrame,
    previous: CanvasVisibleFrame | undefined,
  ) => void;
};

const CanvasVisibleFrameContext = createContext<CanvasVisibleFrameContextValue | undefined>(
  undefined,
);

function rectOf(element: Element): CanvasFrameRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function sameGeometry(
  previous: CanvasVisibleFrame | undefined,
  next: { x: number; y: number; width: number; height: number },
) {
  if (!previous) return false;
  // Browser layout can report tiny floating-point fluctuations for the same settled pixels.
  const tolerance = 0.01;
  return Math.abs(previous.x - next.x) < tolerance
    && Math.abs(previous.y - next.y) < tolerance
    && Math.abs(previous.width - next.width) < tolerance
    && Math.abs(previous.height - next.height) < tolerance;
}

function hardOccluders(root: HTMLElement) {
  const document = root.ownerDocument;
  const occluders: CanvasHardOccluder[] = [];
  const observed = new Set<Element>();

  const append = (
    selector: string,
    side: CanvasHardOccluder["side"],
    trailingGap = 0,
  ) => {
    for (const element of document.querySelectorAll(selector)) {
      observed.add(element);
      const rect = rectOf(element);
      occluders.push({
        side,
        rect: side === "left" && trailingGap > 0
          ? { ...rect, right: rect.right + trailingGap, width: rect.width + trailingGap }
          : rect,
      });
    }
  };

  // Relative desktop siblings end at the app-content edge and therefore have no intersection.
  // Their responsive fixed variants overlap the root and are included by the geometry helper.
  append(".right-panel", "right");

  return { occluders, observed };
}

export function CanvasVisibleFrameProvider({
  children,
  className = "app-content",
  layoutKey,
  onFrameChange,
}: CanvasVisibleFrameProviderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const revisionRef = useRef(0);
  const frameRef = useRef<CanvasVisibleFrame | undefined>(undefined);
  const measuredLayoutKeyRef = useRef(layoutKey);
  const callbackRef = useRef(onFrameChange);
  const [visibleFrame, setVisibleFrame] = useState<CanvasVisibleFrame>();

  useLayoutEffect(() => {
    callbackRef.current = onFrameChange;
  }, [onFrameChange]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let firstFrame = 0;
    let secondFrame = 0;
    let disposed = false;

    const publishMeasurement = () => {
      if (disposed) return;
      const { occluders } = hardOccluders(root);
      const geometry = calculateCanvasVisibleFrame(rectOf(root), occluders);
      if (!geometry) return;
      if (sameGeometry(frameRef.current, geometry)) {
        if (measuredLayoutKeyRef.current !== layoutKey) {
          measuredLayoutKeyRef.current = layoutKey;
          // The geometry may be numerically identical across two layouts. Publish a fresh state
          // object so children can stop treating the previous layout's frame as unavailable,
          // without inventing a geometry revision or another camera command.
          if (frameRef.current) setVisibleFrame({ ...frameRef.current });
        }
        return;
      }

      const previous = frameRef.current;
      const next: CanvasVisibleFrame = {
        ...geometry,
        revision: revisionRef.current + 1,
      };
      revisionRef.current = next.revision;
      measuredLayoutKeyRef.current = layoutKey;
      frameRef.current = next;
      setVisibleFrame(next);
      callbackRef.current?.(next, previous);
    };

    // ResizeObserver can fire once per transition frame. Cancelling and restarting this pair means
    // geometry is only published after two animation frames without a newer layout notification.
    const scheduleMeasurement = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(publishMeasurement);
      });
    };

    // The opening camera runs in a layout effect too. Publish once during this commit so its first
    // fit uses the real unobscured frame instead of fitting full-width and correcting after paint.
    publishMeasurement();

    const observer = new ResizeObserver(scheduleMeasurement);
    observer.observe(root);
    const { observed } = hardOccluders(root);
    for (const element of observed) observer.observe(element);

    const ownerWindow = root.ownerDocument.defaultView ?? window;
    ownerWindow.addEventListener("resize", scheduleMeasurement);
    root.ownerDocument.addEventListener("transitionend", scheduleMeasurement);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      observer.disconnect();
      ownerWindow.removeEventListener("resize", scheduleMeasurement);
      root.ownerDocument.removeEventListener("transitionend", scheduleMeasurement);
    };
  }, [layoutKey]);

  // Never let a newly mounted canvas consume geometry measured for the previous panel layout.
  // The layout effect above republishes the settled frame during this commit.
  const currentVisibleFrame = measuredLayoutKeyRef.current === layoutKey
    ? visibleFrame
    : undefined;
  const value = useMemo<CanvasVisibleFrameContextValue>(
    () => ({ visibleFrame: currentVisibleFrame }),
    [currentVisibleFrame],
  );

  return (
    <CanvasVisibleFrameContext.Provider value={value}>
      <div ref={rootRef} className={className}>
        {children}
      </div>
    </CanvasVisibleFrameContext.Provider>
  );
}

export function useCanvasVisibleFrame() {
  const context = useContext(CanvasVisibleFrameContext);
  if (!context) {
    throw new Error("useCanvasVisibleFrame must be used within CanvasVisibleFrameProvider");
  }
  return context;
}
