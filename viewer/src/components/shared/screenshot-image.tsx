import { useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode, type SyntheticEvent } from "react";
import { ImageOff, LoaderCircle } from "lucide-react";
import { isEmbeddedArtifactUrl, leaseEmbeddedArtifactUrl } from "../../utils/embedded-report";

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
   * Keeps the picture of the source before on screen until the new one has decoded, and shows the new one without a
   * fade: for the app icon, which changes only when another target's report is shown and should not blink. Never for a
   * screenshot. A view that steps between screens or draws changes over the picture would show the screen before under
   * the new one, and a card would show the other target's or appearance's capture as this one's: a screenshot goes
   * blank while its replacement loads.
   */
  holdPrevious?: boolean;
};

/** How long a loaded screenshot waits for its decode before it is shown anyway. */
const DECODE_WAIT_MS = 300;

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
 * Calls `show` once `image` has decoded `picture`, so the picture fades in on its own pixels rather than on an empty
 * box its decode fills in partway; one whose decode does not settle soon is shown anyway. A rejected decode is a
 * broken image, whose error event follows, or a source replaced meanwhile, which is shown on its own load.
 */
function whenDecoded(image: HTMLImageElement, picture: string, show: () => void) {
  let settled = false;
  const settle = (shown: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (shown && image.isConnected && image.getAttribute("src") === picture) show();
  };
  const timer = setTimeout(() => settle(true), DECODE_WAIT_MS);
  image.decode().then(() => settle(true), () => settle(image.complete && image.naturalWidth > 0));
}

/**
 * Decode embedded evidence near the viewport; ordinary image URLs keep native loading. While a
 * screenshot loads, the image is hidden over its frame (an embedded one keeps its size and, with
 * `indicator`, shows a spinner) and never shows its alt text or the picture of the source before;
 * an embedded screenshot that cannot be read shows `fallback`. A picture that fills an empty frame
 * fades in, unless it lands inside `[data-screenshot-instant]` (Compare stepping under a held key,
 * Flip's hidden side), where it appears at once.
 */
export function ScreenshotImage({ src, loading, indicator, fallback, holdPrevious, onLoad, onError, ...props }: ScreenshotImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [resolved, setResolved] = useState<{ source: string; url: string }>();
  const [failed, setFailed] = useState<string>();
  const [shown, setShown] = useState<string>();
  // The picture shown, when it fades in: it filled an empty frame outside an instant stage.
  const [revealed, setRevealed] = useState<string>();
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
    setRevealed(undefined);
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
    // Released against the report that resolved it: a hosted preview's other target can hold the same screenshot,
    // so this image can outlive its report without its source changing.
    let lease: ReturnType<typeof leaseEmbeddedArtifactUrl> | undefined;
    const load = () => {
      if (disposed || requested) return;
      requested = true;
      const current = ++generation;
      const leased = leaseEmbeddedArtifactUrl(src, loading === "eager" ? "eager" : "lazy");
      lease = leased;
      void (async () => {
        try {
          const url = await leased.url;
          if (disposed || generation !== current) return;
          setResolved({ source: src, url });
          // A fresh URL gets its own chance to decode.
          setFailed(undefined);
        } catch {
          if (disposed || generation !== current) return;
          // A failed load holds no reference, so nothing is released for it later.
          requested = false;
          // The report it waited on was switched away from and let it go: ask the one shown now, which may hold it too.
          if (!leased.current()) {
            load();
            return;
          }
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
        else if (requested && lease?.release()) {
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
      if (requested) lease?.release();
    };
  }, [embedded, src, loading]);

  // An ordinary URL is its own picture; an embedded one is the URL its report resolved it to.
  const url = !embedded ? src : resolved?.source === src ? resolved.url : undefined;
  const state: ScreenshotState = failed === src ? "failed" : url && shown === url ? "ready" : "loading";
  const displayed = state !== "failed" ? url ?? held : undefined;
  // Shown once decoded. Replacing a held picture is no reveal: it stays up until the new one is there.
  const show = (image: HTMLImageElement, picture: string) => whenDecoded(image, picture, () => {
    setShown(picture);
    setRevealed(held || image.closest("[data-screenshot-instant]") ? undefined : picture);
    setHeld(undefined);
  });

  // Re-committing the URL the image already shows (it left the viewport and came back before a
  // render, and the report still held the URL) fires no load event: the loaded image is shown once
  // its decode settles, as a load would show it.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!displayed || displayed !== url || shown === displayed || !image || image.getAttribute("src") !== displayed) return;
    if (image.complete && image.naturalWidth > 0) show(image, displayed);
  });

  if (state === "failed" && fallback !== undefined && embedded) return <>{fallback}</>;
  // The caller hears the screenshot's own load and error events and a failed resolve (dispatched
  // above, so untrusted), never the stand-in's.
  const isScreenshot = (event: SyntheticEvent<HTMLImageElement>) => Boolean(url) && event.currentTarget.getAttribute("src") === url;
  const status = {
    "data-screenshot-state": state,
    // A held picture stays shown while the new one loads; every other waiting image is hidden at once.
    "data-screenshot-held": state === "loading" && held ? "" : undefined,
    "data-screenshot-reveal": state === "ready" && revealed === url ? "" : undefined,
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => {
      if (!isScreenshot(event)) return;
      show(event.currentTarget, url!);
      onLoad?.(event);
    },
  };
  // An ordinary URL loads natively. Each source is an image of its own, so the browser never paints the picture of
  // the source before while the new one loads; a held one keeps its element, which keeps painting it.
  if (!embedded) {
    return <img key={holdPrevious ? undefined : src} {...props} {...status} ref={imageRef} loading={loading} src={src}
      onError={event => {
        if (event.currentTarget.getAttribute("src") === src) { setFailed(src); setHeld(undefined); }
        onError?.(event);
      }} />;
  }
  return (
    <>
      <img {...props} {...status} ref={imageRef} loading={loading}
        src={displayed ?? waitingSource(props.width, props.height)}
        data-screenshot-src={src}
        aria-busy={state === "loading" || undefined}
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
