import { useEffect, useId, useMemo, useRef, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { DEFAULT_SCREENSHOT_RATIO, ScreenshotImage, ScreenshotPlaceholder } from "../shared/screenshot-image";
import {
  artifactUrl,
  screenshotForScreen,
  screenshotForVariant,
  reviewableVariantsForScreen,
  type MapIndex,
  type Screen,
  type ScreenVariant,
} from "../../utils/model";

type ScreenVariantCarouselProps = {
  screen: Screen;
  index: MapIndex;
  selectedVariantId?: string | undefined;
  onSelectVariant: (variantId: string) => void;
  variants?: readonly ScreenVariant[];
  showNames?: boolean;
  /** Why there is no screenshot, when the report says. */
  placeholder?: string | undefined;
  /** A second, quieter line under the placeholder: the run's reason for the missing image. */
  placeholderDetail?: string | undefined;
};

function variantName(name: string | undefined, position: number, captured = false): string {
  return name?.trim() || (captured ? `Captured state ${position + 1}` : position === 0 ? "Default" : `Variant ${position + 1}`);
}

export function ScreenVariantCarousel(props: ScreenVariantCarouselProps) {
  const variants = useMemo(
    () => props.variants ?? reviewableVariantsForScreen(props.screen, props.index),
    [props.index, props.screen, props.variants],
  );
  const selectedIndex = Math.max(
    0,
    variants.findIndex((variant) => variant.id === props.selectedVariantId),
  );
  const selected = variants[selectedIndex];
  const selectedArtifact = selected
    ? screenshotForVariant(selected, props.index)
    : screenshotForScreen(props.screen, props.index);
  const selectedScreenshot = artifactUrl(selectedArtifact);
  // A missing screenshot keeps a phone-shaped frame instead of shrinking to its label.
  const screenshotRatio = selectedArtifact?.width && selectedArtifact.height
    ? selectedArtifact.width / selectedArtifact.height
    : selectedScreenshot ? undefined : DEFAULT_SCREENSHOT_RATIO;
  const previewStyle = screenshotRatio
    ? {
        "--preview-width-vh": `${53 * screenshotRatio}vh`,
        "--preview-width-max": `${468 * screenshotRatio}px`,
        "--preview-aspect": String(screenshotRatio),
        aspectRatio: String(screenshotRatio),
      } as CSSProperties
    : undefined;
  const multiple = variants.length > 1;
  const tabsRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    const strip = tabsRef.current;
    const selectedTab = strip?.querySelector<HTMLElement>("[aria-selected='true']");
    if (!strip || !selectedTab) return;

    // scrollIntoView also moves every scrollable ancestor, which can unexpectedly jump the
    // Inspector back to the carousel. Only reveal the tab along this strip's horizontal axis.
    const stripBounds = strip.getBoundingClientRect();
    const tabBounds = selectedTab.getBoundingClientRect();
    const horizontalDelta = tabBounds.left < stripBounds.left
      ? tabBounds.left - stripBounds.left
      : tabBounds.right > stripBounds.right
        ? tabBounds.right - stripBounds.right
        : 0;
    if (horizontalDelta !== 0) strip.scrollLeft += horizontalDelta;
  }, [selected?.id]);

  const selectAt = (position: number, focusTab = false) => {
    const variant = variants[position];
    if (!variant) return;
    props.onSelectVariant(variant.id);
    if (focusTab) {
      requestAnimationFrame(() => {
        tabsRef.current
          ?.querySelector<HTMLElement>(`[data-variant-position="${position}"]`)
          ?.focus({ preventScroll: true });
      });
    }
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = (selectedIndex - 1 + variants.length) % variants.length;
    if (event.key === "ArrowRight") nextIndex = (selectedIndex + 1) % variants.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = variants.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectAt(nextIndex, true);
  };

  const preview = (
    <div
      id={`${panelId}-panel`}
      className={`inspector-preview variant-preview${screenshotRatio ? " has-image-ratio" : ""}`}
      style={previewStyle}
      role={multiple ? "tabpanel" : undefined}
      aria-labelledby={multiple && selected ? `${panelId}-tab-${selectedIndex}` : undefined}>
      {selectedScreenshot ? (
        <ScreenshotImage
          src={selectedScreenshot}
          alt={`${props.screen.title}${multiple || props.showNames ? ` — ${variantName(selected?.name, selectedIndex, props.showNames)}` : ""}`}
          {...(selectedArtifact?.width ? { width: selectedArtifact.width } : {})}
          {...(selectedArtifact?.height ? { height: selectedArtifact.height } : {})}
          decoding="async"
          loading="eager"
          indicator="spinner"
          fallback={<ScreenshotPlaceholder />}
        />
      ) : (
        <ScreenshotPlaceholder {...(props.placeholder ? { label: props.placeholder } : {})} {...(props.placeholderDetail ? { detail: props.placeholderDetail } : {})} />
      )}
    </div>
  );

  if (!multiple) return props.showNames ? <figure className="captured-variant-single">
    {preview}
    <figcaption>{variantName(selected?.name, selectedIndex, true)}</figcaption>
  </figure> : preview;

  return (
    <div className="screen-variant-carousel">
      <div className="variant-stage">
        <button
          type="button"
          className="variant-arrow"
          aria-label="Previous screen variant"
          disabled={selectedIndex === 0}
          onClick={() => selectAt(selectedIndex - 1)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        {preview}
        <button
          type="button"
          className="variant-arrow"
          aria-label="Next screen variant"
          disabled={selectedIndex === variants.length - 1}
          onClick={() => selectAt(selectedIndex + 1)}>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>

      <div
        ref={tabsRef}
        className="variant-thumbnails"
        role="tablist"
        aria-label={`${props.screen.title} screen variants`}
        onKeyDown={onTabKeyDown}>
        {variants.map((variant, position) => {
          const screenshot = artifactUrl(screenshotForVariant(variant, props.index));
          const name = variantName(variant.name, position, props.showNames);
          const isSelected = position === selectedIndex;
          return (
            <button
              key={variant.id}
              id={`${panelId}-tab-${position}`}
              type="button"
              role="tab"
              aria-controls={`${panelId}-panel`}
              aria-label={`${name}, variant ${position + 1} of ${variants.length}`}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              title={name}
              className={`variant-thumbnail${props.showNames ? " has-name" : ""}`}
              data-variant-position={position}
              onClick={() => selectAt(position)}>
              {screenshot ? (
                <ScreenshotImage src={screenshot} alt="" loading="lazy" decoding="async"
                  fallback={<ImageOff aria-hidden="true" />} />
              ) : <ImageOff aria-hidden="true" />}
              {props.showNames ? <span className="variant-thumbnail-name" aria-hidden="true">{name}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
