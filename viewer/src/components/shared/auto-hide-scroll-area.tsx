import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type UIEventHandler,
} from "react";
import "./auto-hide-scroll-area.css";

const DEFAULT_HIDE_DELAY_MS = 650;

export type AutoHideScrollAreaProps = HTMLAttributes<HTMLDivElement> & {
  /** Styles the non-scrolling shell without changing the scrollable element's public class. */
  shellClassName?: string;
  /** Compatibility hooks for surfaces that previously owned their scrollbar markup. */
  scrollbarClassName?: string;
  scrollbarThumbClassName?: string;
  hideDelayMs?: number;
};

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/**
 * A list scroll area whose theme-aware overlay thumb fades away after scrolling. The overlay is
 * independent from the OS scrollbar, so it remains visible on macOS even when overlay scrollbars
 * are configured to appear only while scrolling. The native track stays transparent as a fallback.
 */
export const AutoHideScrollArea = forwardRef<HTMLDivElement, AutoHideScrollAreaProps>(
  function AutoHideScrollArea({
    shellClassName,
    scrollbarClassName,
    scrollbarThumbClassName,
    hideDelayMs = DEFAULT_HIDE_DELAY_MS,
    className,
    children,
    onScroll,
    ...bodyProps
  }, forwardedRef) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const hideTimerRef = useRef<number | undefined>(undefined);

    useImperativeHandle(forwardedRef, () => bodyRef.current as HTMLDivElement, []);

    const syncScrollbar = useCallback(() => {
      const body = bodyRef.current;
      const shell = shellRef.current;
      if (!body || !shell) return;

      const maxScroll = body.scrollHeight - body.clientHeight;
      const trackSize = Math.max(0, body.clientHeight - 4);
      const scrollable = maxScroll > 1 && trackSize > 0;
      shell.classList.toggle("is-scrollable", scrollable);
      if (!scrollable) {
        shell.style.setProperty("--auto-scroll-thumb-size", "0px");
        shell.style.setProperty("--auto-scroll-thumb-offset", "0px");
        return;
      }

      const thumbSize = Math.min(
        trackSize,
        Math.max(32, trackSize * (body.clientHeight / body.scrollHeight)),
      );
      const maxThumbOffset = Math.max(0, trackSize - thumbSize);
      const thumbOffset = maxThumbOffset * (body.scrollTop / maxScroll);
      shell.style.setProperty("--auto-scroll-thumb-size", `${thumbSize}px`);
      shell.style.setProperty("--auto-scroll-thumb-offset", `${thumbOffset}px`);
    }, []);

    useLayoutEffect(() => {
      const body = bodyRef.current;
      if (!body) return;

      let animationFrame = 0;
      const scheduleSync = () => {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = window.requestAnimationFrame(syncScrollbar);
      };
      const resizeObserver = new ResizeObserver(scheduleSync);
      const observeContent = () => {
        resizeObserver.disconnect();
        resizeObserver.observe(body);
        for (const child of body.children) {
          if (child instanceof HTMLElement) resizeObserver.observe(child);
        }
        scheduleSync();
      };
      const mutationObserver = new MutationObserver(observeContent);
      mutationObserver.observe(body, { childList: true, subtree: true, characterData: true });
      observeContent();

      return () => {
        window.cancelAnimationFrame(animationFrame);
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      };
    }, [syncScrollbar]);

    useLayoutEffect(() => () => {
      if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current);
    }, []);

    const handleScroll: UIEventHandler<HTMLDivElement> = (event) => {
      syncScrollbar();
      const shell = shellRef.current;
      if (shell) {
        shell.classList.add("is-scrolling");
        if (hideTimerRef.current !== undefined) window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = window.setTimeout(() => {
          shell.classList.remove("is-scrolling");
          hideTimerRef.current = undefined;
        }, hideDelayMs);
      }
      onScroll?.(event);
    };

    return (
      <div
        ref={shellRef}
        className={joinClassNames("auto-hide-scroll-area", shellClassName)}>
        <div
          {...bodyProps}
          ref={bodyRef}
          className={joinClassNames("auto-hide-scroll-body", className)}
          onScroll={handleScroll}>
          {children}
        </div>
        <div
          className={joinClassNames("auto-hide-scrollbar", scrollbarClassName)}
          aria-hidden="true">
          <span className={joinClassNames("auto-hide-scrollbar-thumb", scrollbarThumbClassName)} />
        </div>
      </div>
    );
  },
);
