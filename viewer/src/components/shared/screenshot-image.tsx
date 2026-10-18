import { useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode, type SyntheticEvent } from "react";
import { ImageOff, LoaderCircle } from "lucide-react";
import { isEmbeddedArtifactUrl, releaseEmbeddedArtifactUrl, resolveEmbeddedArtifactUrl } from "../../utils/embedded-report";

/** A phone screen's width over height; frames size to it until a screenshot supplies its own. */
export const DEFAULT_SCREENSHOT_RATIO = 9 / 19.5;
/** The size a screenshot without a recorded one waits at: a phone screen at that ratio. */
export const DEFAULT_SCREENSHOT_SIZE = { width: 390, height: Math.round(390 / DEFAULT_SCREENSHOT_RATIO) } as const;

type ScreenshotImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  /** Large previews centre a spinner while an embedded screenshot resolves; small images wait as a quiet empty frame. */
  indicator?: "spinner";
  /** Stands in for an embedded screenshot that cannot be read: the caller's own no-screenshot state. */
  fallback?: ReactNode;
  /**
   * Keeps the picture of the source before on screen until the new one has decoded: for a map card, whose source
   * changes only when the report's other appearance or target swaps every screenshot at once. Never for a view that
   * steps between screens or draws changes over the picture, where it would show the screen before under the new one.
   */
  holdPrevious?: boolean;
};

type ScreenshotState = "loading" | "ready" | "failed";

function dimension(value: number | string | undefined): number | undefined {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * A transparent image of the screenshot's size. Chrome draws an `<img>` without a source as a
 * broken-image icon beside its alt text; this stand-in keeps the element measurable for the
 * intersection observer and its frame (the caller's border and background) in place instead.
 */
function waitingSource(width: number | string | undefined, height: number | string | undefined): string {
  const w = dimension(width) ?? DEFAULT_SCREENSHOT_SIZE.width;
  const h = dimension(height) ?? Math.round(w / DEFAULT_SCREENSHOT_RATIO);
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/%3E`;
}

/**
 * Decode embedded evidence near the viewport; ordinary image URLs keep native loading. While an
 * embedded screenshot resolves, the image shows an empty frame (and, with `indicator`, a spinner)
 * and never its alt text; a screenshot that cannot be read shows `fallback`.
 */
export function ScreenshotImage({ src, loading, indicator, fallback, holdPrevious, onLoad, onError, ...props }: ScreenshotImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [resolved, setResolved] = useState<{ source: string; url: string }>();
  const [failed, setFailed] = useState<string>();
  const [shown, setShown] = useState<string>();
  const [lastSource, setLastSource] = useState(src);
  // With `holdPrevious`, the picture of the source before, kept on screen until the new one has decoded.
  const [held, setHeld] = useState<string>();
  const embedded = typeof src === "string" && isEmbeddedArtifactUrl(src);
  // A new source starts over: a fresh attempt, even for one that failed before, and never a URL
  // resolved on an earlier visit, which was released on leaving and may since have been revoked.
  if (lastSource !== src) {
    setLastSource(src);
    // A source that failed has no picture of its own to hand on, and drops the one it held.
    setHeld(holdPrevious && failed !== lastSource ? shown ?? held : undefined);
    setResolved(undefined);
    setShown(undefined);
    setFailed(undefined);
  }

  useEffect(() => {
    if (!embedded || !src) return;
    const image = imageRef.current;
    if (!image) return;
    let disposed = false;
    let requested = false;
    let generation = 0;
    let observer: IntersectionObserver | undefined;
    const load = () => {
      if (disposed || requested) return;
      requested = true;
      const current = ++generation;
      void (async () => {
        try {
          const url = await resolveEmbeddedArtifactUrl(src, loading === "eager" ? "eager" : "lazy");
          if (disposed || generation !== current) return;
          setResolved({ source: src, url });
          // A fresh URL gets its own chance to decode.
          setFailed(undefined);
        } catch {
          if (disposed || generation !== current) return;
          // A failed load holds no reference, so nothing is released for it later.
          requested = false;
          observer?.disconnect();
          image.dispatchEvent(new Event("error"));
          setFailed(src);
        }
      })();
    };
    if (loading === "eager" || typeof IntersectionObserver === "undefined") load();
    else {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) load();
        else if (requested && releaseEmbeddedArtifactUrl(src)) {
          requested = false;
          generation++;
          setResolved(undefined);
          setShown(undefined);
        }
      }, { rootMargin: "200px" });
      observer.observe(image);
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      if (requested) releaseEmbeddedArtifactUrl(src);
    };
  }, [embedded, src, loading]);

  const url = embedded && resolved?.source === src ? resolved.url : undefined;
  const state: ScreenshotState = failed === src ? "failed" : url && shown === url ? "ready" : "loading";
  const displayed = state !== "failed" ? url ?? held : undefined;

  // Re-committing the URL the image already shows (it left the viewport and came back before a
  // render, and the report still held the URL) fires no load event: the decoded image is ready.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!displayed || displayed !== url || shown === displayed || !image || image.getAttribute("src") !== displayed) return;
    if (image.complete && image.naturalWidth > 0) {
      setShown(displayed);
      setHeld(undefined);
    }
  }, [displayed, url, shown]);

  if (!embedded) return <img {...props} ref={imageRef} loading={loading} src={src} onLoad={onLoad} onError={onError} />;
  if (state === "failed" && fallback !== undefined) return <>{fallback}</>;
  // The caller hears the screenshot's own load and error events and a failed resolve (dispatched
  // above, so untrusted), never the stand-in's.
  const isScreenshot = (event: SyntheticEvent<HTMLImageElement>) => Boolean(url) && event.currentTarget.getAttribute("src") === url;
  return (
    <>
      <img {...props} ref={imageRef} loading={loading}
        src={displayed ?? waitingSource(props.width, props.height)}
        data-screenshot-src={src}
        data-screenshot-state={state}
        aria-busy={state === "loading" || undefined}
        onLoad={event => {
          if (!isScreenshot(event)) return;
          setShown(url);
          setHeld(undefined);
          onLoad?.(event);
        }}
        onError={event => {
          if (event.nativeEvent.isTrusted) {
            // The held picture's URL was revoked since (the report let it go): nothing to show until the new one.
            if (held && !url && event.currentTarget.getAttribute("src") === held) { setHeld(undefined); return; }
            if (!isScreenshot(event)) return;
            setFailed(src);
          }
          onError?.(event);
        }} />
      {indicator === "spinner" && state === "loading" ? (
        <span className="screenshot-loading" role="status" aria-label="Loading screenshot">
          <LoaderCircle aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
}

/**
 * The inspector's no-screenshot state, matching the canvas node placeholder and the page's empty
 * states: a quiet 20px icon above a short label, centred in whatever frame holds it.
 */
export function ScreenshotPlaceholder({ label = "No screenshot", detail, className }: { label?: string; detail?: string; className?: string }) {
  return (
    <span className={className ? `screenshot-placeholder ${className}` : "screenshot-placeholder"}>
      <ImageOff aria-hidden="true" size={20} />
      <span>{label}</span>
      {detail ? <small className="screenshot-placeholder-detail">{detail}</small> : null}
    </span>
  );
}
