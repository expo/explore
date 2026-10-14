import { useMemo } from "react";
import { artifactUrl, latestObservationForVariant, variantsForScreen, type MapIndex, type Screen } from "../../utils/model";
import { ScreenVariantCarousel } from "./screen-variant-carousel";
import "./captured-screen-variants.css";

/** Only authored variants with a linked, displayable screenshot are reviewable states. */
export function CapturedScreenVariants(props: {
  screen: Screen;
  index: MapIndex;
  selectedVariantId?: string | undefined;
  onSelectVariant: (variantId: string) => void;
}) {
  const variants = useMemo(() => variantsForScreen(props.screen, props.index).filter(variant => {
    if (variant.screenId !== props.screen.id) return false;
    const observation = latestObservationForVariant(variant, props.index);
    if (!observation || observation.screenId !== props.screen.id || observation.variantId !== variant.id
      || !props.screen.observationIds.includes(observation.id) || !observation.screenshotArtifactId) return false;
    const artifact = props.index.artifacts.get(observation.screenshotArtifactId);
    return artifact?.kind === "screenshot" && Boolean(artifactUrl(artifact));
  }), [props.index, props.screen]);
  // A single captured state is already shown in the comparison above.
  if (variants.length < 2) return null;
  return <section className="inspector-section captured-screen-variants" aria-label="Captured screen variants">
    <div className="section-title"><h3>Variants</h3></div>
    <ScreenVariantCarousel {...props} variants={variants} showNames />
  </section>;
}
