/**
 * PROTOTYPE: a per-pixel difference of two screenshots, as a PNG mask (an object URL) that tints the
 * pixels that differ and leaves the rest transparent. Computed in the page from the decoded images.
 */

export type PixelDiffOptions = {
  /** Bands at the top and bottom, in percent of the height, left out (status bar, home indicator). */
  ignoreTopPercent?: number | undefined;
  ignoreBottomPercent?: number | undefined;
  /** The tint, as CSS color. */
  color?: string | undefined;
};

export type PixelDiffResult = { url: string; changedPercent: number; width: number; height: number };

const cache = new Map<string, Promise<PixelDiffResult | undefined>>();

/** Pixels whose channels differ by more than this, summed over R, G and B, count as changed. Antialiasing stays under it. */
const THRESHOLD = 60;
/** The most pixels to compare; larger screenshots are scaled down first. */
const MAX_PIXELS = 3_000_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (!src.startsWith("blob:") && !src.startsWith("data:")) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
}

function parseColor(color: string): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

export function pixelDiff(before: string, after: string, options: PixelDiffOptions = {}): Promise<PixelDiffResult | undefined> {
  const key = `${before}|${after}|${options.ignoreTopPercent ?? 0}|${options.ignoreBottomPercent ?? 0}|${options.color ?? ""}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = compute(before, after, options).catch(() => undefined);
    cache.set(key, pending);
  }
  return pending;
}

async function compute(beforeSrc: string, afterSrc: string, options: PixelDiffOptions): Promise<PixelDiffResult | undefined> {
  const [before, after] = await Promise.all([loadImage(beforeSrc), loadImage(afterSrc)]);
  let width = Math.min(before.naturalWidth, after.naturalWidth);
  let height = Math.min(before.naturalHeight, after.naturalHeight);
  if (width === 0 || height === 0) return undefined;
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const read = (image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  };
  const a = read(before), b = read(after);

  const top = Math.round(((options.ignoreTopPercent ?? 0) / 100) * height);
  const bottom = height - Math.round(((options.ignoreBottomPercent ?? 0) / 100) * height);
  const mask = new Uint8Array(width * height);
  let changed = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const delta = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
      if (delta > THRESHOLD) { mask[y * width + x] = 1; changed += 1; }
    }
  }

  // Grow each changed pixel by a radius that reads at any zoom: hairlines become visible strokes.
  const radius = Math.max(1, Math.round(width / 500));
  const grown = dilate(mask, width, height, radius);

  const [r, g, bl] = parseColor(options.color ?? "#ea580c");
  const out = new ImageData(width, height);
  const data = out.data;
  for (let p = 0; p < width * height; p += 1) {
    if (!grown[p]) continue;
    const i = p * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = bl;
    // The pixel itself is solid; the grown halo is softer.
    data[i + 3] = mask[p] ? 230 : 150;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(out, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return undefined;
  return { url: URL.createObjectURL(blob), changedPercent: (changed / (width * height)) * 100, width, height };
}

/** A separable max filter: a square of side 2r+1 around every set pixel. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const pass = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[row + x]) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) pass[row + nx] = 1;
      }
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!pass[row + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny >= 0 && ny < height) out[ny * width + x] = 1;
      }
    }
  }
  return out;
}
