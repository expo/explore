import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { STATUS_BAR_BAND_PERCENT } from "../contracts/capture.js";

export { STATUS_BAR_BAND_PERCENT };

/** Decoded RGBA pixels of one frame, as pngjs returns them (four bytes per pixel, row by row). */
export type DecodedFrame = { width: number; height: number; data: Buffer };

/**
 * Whether a screenshot is a single flat colour: a capture-protected screen (black on Android), or a display that is lit
 * but not drawn (an iPhone Duo's inner panel after its first fold on EAS). Every 97th pixel is enough to tell.
 */
export function solidColour(png: Buffer): boolean {
  let frame: DecodedFrame;
  try { frame = createRequire(import.meta.url.replace(/\?.*$/, ""))("pngjs").PNG.sync.read(png, { checkCRC: false }) as DecodedFrame; }
  catch { return false; }
  const { data } = frame;
  if (data.length < 4) return false;
  for (let offset = 0; offset + 3 < data.length; offset += 4 * 97) {
    if (data[offset] !== data[0] || data[offset + 1] !== data[1] || data[offset + 2] !== data[2]) return false;
  }
  return true;
}

/**
 * Whether a coordinate tap at normalized height `y` would act on a changed frame. Differences inside
 * the status-bar band are ignored only when the tap lands below the band: a tap inside it acts on
 * whatever is drawn there (content drawn under the status bar, or a landscape frame without one),
 * so there every pixel counts. Frames of different sizes always differ.
 */
export function frameChangedForTap(first: DecodedFrame, second: DecodedFrame, y: number, bandPercent: number = STATUS_BAR_BAND_PERCENT): boolean {
  if (first.width !== second.width || first.height !== second.height || first.data.length !== second.data.length) return true;
  // Whole rows that lie inside the band; a row that crosses its edge still counts as app content.
  const bandRows = Math.floor((first.height * bandPercent) / 100);
  const start = y * first.height < bandRows ? 0 : bandRows * first.width * 4;
  return !first.data.subarray(start).equals(second.data.subarray(start));
}

export function assertDecodedPng(contents: Buffer, label: string): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contents.length < 45 || !contents.subarray(0, 8).equals(signature)) {
    throw new Error(`${label} is not PNG evidence`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];
  for (let chunkCount = 0; offset < contents.length && chunkCount < 100_000; chunkCount += 1) {
    if (offset + 12 > contents.length) throw new Error(`${label} has a truncated PNG chunk`);
    const length = contents.readUInt32BE(offset);
    const type = contents.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const nextOffset = dataStart + length + 4;
    if (!/^[A-Za-z]{4}$/.test(type) || nextOffset > contents.length) {
      throw new Error(`${label} has an invalid PNG chunk`);
    }
    const data = contents.subarray(dataStart, dataStart + length);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error(`${label} lacks a valid PNG header`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (
        width <= 0 || height <= 0 || width > 32_768 || height > 32_768
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0
      ) {
        throw new Error(`${label} has unsupported PNG dimensions or encoding`);
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      throw new Error(`${label} contains duplicate PNG headers`);
    }
    if (type === "IDAT") imageData.push(data);
    if (type === "IEND") {
      if (length !== 0 || nextOffset !== contents.length) {
        throw new Error(`${label} has an invalid PNG end chunk`);
      }
      sawEnd = true;
    }
    offset = nextOffset;
    if (sawEnd) break;
  }
  const channelCount = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  const validDepths = new Map<number, readonly number[]>([
    [0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]],
  ]).get(colorType);
  if (!sawHeader || !sawEnd || imageData.length === 0 || !channelCount || !validDepths?.includes(bitDepth)) {
    throw new Error(`${label} is not a complete supported PNG`);
  }
  const rowBytes = Math.ceil((width * channelCount * bitDepth) / 8);
  const expectedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > 200 * 1024 * 1024) {
    throw new Error(`${label} decoded PNG is too large`);
  }
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedBytes });
  } catch (error) {
    throw new Error(`${label} PNG pixels could not be decoded`, { cause: error });
  }
  if (decoded.length !== expectedBytes) throw new Error(`${label} decoded PNG size is invalid`);
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)]! > 4) throw new Error(`${label} has an invalid PNG row filter`);
  }
}
