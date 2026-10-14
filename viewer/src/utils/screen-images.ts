import type { Artifact, Observation, Screen } from "../../../src/types";
import type { MapIndex } from "./model";

/** The pixel size a screenshot was captured at, in the canvas card's prop names. */
export type ScreenshotSize = { imageWidth: number; imageHeight: number };

/**
 * A screenshot's recorded size, when the map has one. A canvas frame waiting for the image takes
 * this shape, so it stays put when the pixels arrive.
 */
export function screenshotSize(artifact: Artifact | undefined): ScreenshotSize | undefined {
  const width = artifact?.width;
  const height = artifact?.height;
  return width && height && width > 0 && height > 0 ? { imageWidth: width, imageHeight: height } : undefined;
}

function screenshotForObservation(
  observation: Observation | undefined,
  index: MapIndex,
): Artifact | undefined {
  if (!observation?.screenshotArtifactId) return undefined;
  return index.artifacts.get(observation.screenshotArtifactId);
}

function latestScreenshotObservation(
  observationIds: readonly string[],
  index: MapIndex,
  expected: { screenId: string; variantId?: string },
): Observation | undefined {
  return observationIds
    .map((id) => index.observations.get(id))
    .filter((observation): observation is Observation => Boolean(
      observation
        && observation.screenId === expected.screenId
        && (!expected.variantId || observation.variantId === expected.variantId)
        && screenshotForObservation(observation, index),
    ))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id))[0];
}

/**
 * Find the canonical owner of provenance references copied onto an alias screen.
 *
 * Imported alias screens can deliberately reuse their source screen's variants and
 * observations. We only allow that fallback when every resolved reference has
 * one alternate owner and is also authored by that owner's canonical screen.
 * Mixed-owner or merely dangling references therefore cannot borrow an
 * unrelated screenshot.
 */
function aliasedScreenOwner(
  screen: Screen,
  index: MapIndex,
): Screen | undefined {
  const variants = screen.variantIds
    .map((id) => index.variants.get(id))
    .filter((variant) => Boolean(variant));
  const observations = screen.observationIds
    .map((id) => index.observations.get(id))
    .filter((observation) => Boolean(observation));

  if (variants.length === 0 && observations.length === 0) return undefined;
  if (
    variants.length !== screen.variantIds.length
    || observations.length !== screen.observationIds.length
  ) return undefined;

  const ownerIds = new Set([
    ...variants.map((variant) => variant!.screenId),
    ...observations.map((observation) => observation!.screenId),
  ]);
  if (ownerIds.size !== 1) return undefined;

  const ownerId = ownerIds.values().next().value as string | undefined;
  if (!ownerId || ownerId === screen.id) return undefined;
  const owner = index.screens.get(ownerId);
  if (!owner) return undefined;

  const ownerVariantIds = new Set(owner.variantIds);
  const ownerObservationIds = new Set(owner.observationIds);
  if (
    variants.some((variant) => !ownerVariantIds.has(variant!.id))
    || observations.some((observation) => !ownerObservationIds.has(observation!.id))
    || variants.some((variant) => variant!.observationIds.some((observationId) => {
      const observation = index.observations.get(observationId);
      return !observation
        || observation.screenId !== owner.id
        || observation.variantId !== variant!.id
        || !ownerObservationIds.has(observation.id);
    }))
  ) return undefined;

  return owner;
}

function aliasedScreenshotForScreen(
  screen: Screen,
  index: MapIndex,
): Artifact | undefined {
  const owner = aliasedScreenOwner(screen, index);
  if (!owner) return undefined;

  for (const variantId of screen.variantIds) {
    const variant = index.variants.get(variantId);
    if (!variant || variant.screenId !== owner.id) continue;
    const observation = latestScreenshotObservation(variant.observationIds, index, {
      screenId: owner.id,
      variantId,
    });
    const screenshot = screenshotForObservation(observation, index);
    if (screenshot) return screenshot;
  }

  return screenshotForObservation(
    latestScreenshotObservation(screen.observationIds, index, { screenId: owner.id }),
    index,
  );
}

/**
 * Resolve the stable representative image for a canonical screen.
 *
 * The first authored variant is the primary variant. A newer observation from a
 * secondary variant must not silently change the image used by Map and Screens.
 */
export function primaryScreenshotForScreen(screen: Screen, index: MapIndex): Artifact | undefined {
  for (const variantId of screen.variantIds) {
    const variant = index.variants.get(variantId);
    if (!variant || variant.screenId !== screen.id) continue;
    const observation = latestScreenshotObservation(variant.observationIds, index, {
      screenId: screen.id,
      variantId,
    });
    const screenshot = screenshotForObservation(observation, index);
    if (screenshot) return screenshot;
  }

  // Keep malformed or legacy maps useful even when they have observations but
  // no usable variant references.
  return screenshotForObservation(
    latestScreenshotObservation(screen.observationIds, index, { screenId: screen.id }),
    index,
  ) ?? aliasedScreenshotForScreen(screen, index);
}
