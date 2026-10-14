import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isWithin } from "./fs-safety.js";
import { assertDecodedPng, type DecodedFrame } from "../shared/png-evidence.js";
import type { CaptureBundle } from "../contracts/capture.js";

/** The Viewer draws the icon at 22 points; 128 pixels stays sharp on dense displays. */
export const APP_ICON_MAX_SIZE = 128;
export const APP_ICON_SOURCE_LIMIT = 2 * 1024 * 1024;
export const APP_ICON_FILE = "app-icon.png";

type Png = {
  sync: {
    read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame;
    write(png: DecodedFrame): Buffer;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pngPath(value: unknown): string | undefined {
  return typeof value === "string" && /\.png$/i.test(value.trim()) ? value.trim() : undefined;
}

/**
 * The icon the app config declares for the platform when it is a PNG, else the shared one. Android
 * prefers `android.icon`, then the adaptive icon's foreground image.
 */
export function appIconSource(appConfig: Record<string, unknown>, platform: "ios" | "android" = "ios"): string | undefined {
  if (platform === "android") {
    const android = isRecord(appConfig.android) ? appConfig.android : undefined;
    const adaptive = isRecord(android?.adaptiveIcon) ? android.adaptiveIcon : undefined;
    return pngPath(android?.icon) ?? pngPath(adaptive?.foregroundImage) ?? pngPath(appConfig.icon);
  }
  const ios = isRecord(appConfig.ios) ? appConfig.ios : undefined;
  return pngPath(ios?.icon) ?? pngPath(appConfig.icon);
}

/**
 * The background an Android adaptive icon's foreground is drawn on, when the icon comes from
 * `adaptiveIcon.foregroundImage` (no `android.icon`) and the config gives a hex `backgroundColor`.
 */
export function adaptiveIconBackground(appConfig: Record<string, unknown>): [number, number, number] | undefined {
  const android = isRecord(appConfig.android) ? appConfig.android : undefined;
  const adaptive = isRecord(android?.adaptiveIcon) ? android.adaptiveIcon : undefined;
  if (pngPath(android?.icon) || !pngPath(adaptive?.foregroundImage)) return undefined;
  const hex = typeof adaptive?.backgroundColor === "string" ? adaptive.backgroundColor.trim() : "";
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!match) return undefined;
  const digits = match[1]!.length === 3 ? [...match[1]!].map(digit => digit + digit).join("") : match[1]!;
  return [0, 2, 4].map(start => Number.parseInt(digits.slice(start, start + 2), 16)) as [number, number, number];
}

/**
 * An adaptive icon as a launcher shows it: the central 72 of the foreground's 108 units (the rest is
 * margin for the launcher's mask and motion), drawn over the background colour, fully opaque.
 */
export function adaptiveIconFrame(foreground: DecodedFrame, background: [number, number, number]): DecodedFrame {
  const inset = (side: number) => Math.round(side / 6);
  const left = inset(foreground.width); const top = inset(foreground.height);
  const width = foreground.width - 2 * left; const height = foreground.height - 2 * top;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((y + top) * foreground.width + x + left) * 4;
      const target = (y * width + x) * 4;
      const alpha = foreground.data[source + 3]! / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        data[target + channel] = Math.round(foreground.data[source + channel]! * alpha + background[channel]! * (1 - alpha));
      }
      data[target + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * Shrinks a frame so neither side exceeds `max`, averaging each block of source pixels. Colour
 * is weighted by alpha, so transparent pixels do not darken the edges of a rounded icon.
 */
export function downscaleFrame(frame: DecodedFrame, max = APP_ICON_MAX_SIZE): DecodedFrame {
  const scale = Math.min(1, max / Math.max(frame.width, frame.height));
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  if (width === frame.width && height === frame.height) return frame;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const top = Math.floor((y * frame.height) / height);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * frame.height) / height));
    for (let x = 0; x < width; x += 1) {
      const left = Math.floor((x * frame.width) / width);
      const right = Math.max(left + 1, Math.floor(((x + 1) * frame.width) / width));
      let red = 0; let green = 0; let blue = 0; let alpha = 0; let count = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const offset = (sy * frame.width + sx) * 4;
          const a = frame.data[offset + 3]!;
          red += frame.data[offset]! * a;
          green += frame.data[offset + 1]! * a;
          blue += frame.data[offset + 2]! * a;
          alpha += a;
          count += 1;
        }
      }
      const target = (y * width + x) * 4;
      data[target] = alpha ? Math.round(red / alpha) : 0;
      data[target + 1] = alpha ? Math.round(green / alpha) : 0;
      data[target + 2] = alpha ? Math.round(blue / alpha) : 0;
      data[target + 3] = Math.round(alpha / count);
    }
  }
  return { width, height, data };
}

/**
 * Reads the app's icon and shrinks it for the Viewer header. An icon that is missing, not a PNG,
 * unreadable, outside the project or too large is skipped: the Viewer then shows the Expo mark,
 * and a capture never fails over a header image.
 */
export async function loadAppIcon(project: string, appConfig: Record<string, unknown>, platform: "ios" | "android" = "ios"): Promise<Buffer | undefined> {
  const source = appIconSource(appConfig, platform);
  if (!source) return undefined;
  try {
    const root = await realpath(project);
    const path = await realpath(resolve(root, source));
    if (!isWithin(root, path) || path === root) return undefined;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > APP_ICON_SOURCE_LIMIT) return undefined;
    const background = platform === "android" ? adaptiveIconBackground(appConfig) : undefined;
    return shrinkAppIcon(await readFile(path), background);
  } catch {
    return undefined;
  }
}

/** RIFF....WEBP: a WebP container. */
export function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
}

/** The canvas size of a WebP from its first chunk (VP8X extended, VP8L lossless or VP8 lossy); undefined when the header is not one of those. */
export function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (!isWebp(bytes)) return undefined;
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

/**
 * Decodes a PNG icon and re-encodes it at header size; throws when the bytes are not a PNG. With an
 * adaptive background, the bytes are an adaptive foreground and are drawn as the launcher shows them.
 */
export function shrinkAppIcon(bytes: Buffer, adaptiveBackground?: [number, number, number]): Buffer {
  assertDecodedPng(bytes, "App icon");
  // tsx namespaces import.meta.url with a query string that createRequire cannot resolve.
  const { PNG } = createRequire(import.meta.url.replace(/\?.*$/, ""))("pngjs") as { PNG: Png };
  const frame = PNG.sync.read(bytes, { checkCRC: true });
  return PNG.sync.write(downscaleFrame(adaptiveBackground ? adaptiveIconFrame(frame, adaptiveBackground) : frame));
}

/** Re-reads a cached icon, keeping it only when its bytes still match the recorded hash. */
export async function loadCachedAppIcon(
  cacheRoot: string,
  icon: CaptureBundle["appIcon"],
): Promise<Buffer | undefined> {
  if (!icon || icon.path !== APP_ICON_FILE) return undefined;
  try {
    const bytes = await readFile(join(cacheRoot, APP_ICON_FILE));
    return createHash("sha256").update(bytes).digest("hex") === icon.sha256 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the icon next to the capture's screenshots and describes it for the bundle. */
export async function storeAppIcon(outputDirectory: string, icon: Buffer): Promise<NonNullable<CaptureBundle["appIcon"]>> {
  assertDecodedPng(icon, "App icon");
  await writeFile(join(outputDirectory, APP_ICON_FILE), icon, { flag: "wx" });
  return {
    path: APP_ICON_FILE,
    sha256: createHash("sha256").update(icon).digest("hex"),
    width: icon.readUInt32BE(16),
    height: icon.readUInt32BE(20),
  };
}
