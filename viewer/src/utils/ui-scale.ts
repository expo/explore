/**
 * On large windows the floating chrome grows with the window, so it does not read as small and
 * far apart: 1× up to 1728 × 1000, rising to 1.25× at 2560 × 1440. The smaller of the width and
 * height scales wins, so a wide but short window keeps its chrome at 1×.
 */
const MIN = { width: 1728, height: 1000 };
const MAX = { width: 2560, height: 1440 };
const MAX_SCALE = 1.25;

function axisScale(size: number, min: number, max: number): number {
  const progress = Math.min(1, Math.max(0, (size - min) / (max - min)));
  return 1 + progress * (MAX_SCALE - 1);
}

export function uiScaleFor(width: number, height: number): number {
  return Math.min(axisScale(width, MIN.width, MAX.width), axisScale(height, MIN.height, MAX.height));
}

/** Keeps `--ui-scale` on the root element in step with the window. */
export function trackUiScale(): void {
  const apply = () => {
    const scale = uiScaleFor(window.innerWidth, window.innerHeight);
    document.documentElement.style.setProperty("--ui-scale", scale.toFixed(3));
  };
  apply();
  window.addEventListener("resize", apply);
}
