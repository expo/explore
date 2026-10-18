/**
 * Reads a report ZIP (deploy, the local report server, the agent API): a ZIP written by `zipReportDirectory`
 * (review.json or exploration.json deflated, assets/<sha256>.png stored). Only the central directory
 * is trusted for sizes and offsets, every offset is bounds-checked, and entries are inflated on demand.
 */

export type ZipEntry = { name: string; method: 0 | 8; compressedSize: number; size: number; offset: number };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_ENTRIES = 50_000;

/** The archive's entries by name, or undefined when the bytes are not a ZIP this reader accepts. */
export function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = 22;
  if (bytes.byteLength < minimum) return undefined;
  let end = -1;
  for (let index = bytes.byteLength - minimum; index >= Math.max(0, bytes.byteLength - minimum - 0xffff); index -= 1) {
    if (view.getUint32(index, true) === END_OF_CENTRAL_DIRECTORY) { end = index; break; }
  }
  if (end === -1) return undefined;
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES || directoryOffset + directorySize > end) return undefined;
  const entries = new Map<string, ZipEntry>();
  let cursor = directoryOffset;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== CENTRAL_FILE_HEADER) return undefined;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > end || (method !== 0 && method !== 8)) return undefined;
    let name: string;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); } catch { return undefined; }
    if (offset + 30 > bytes.byteLength || entries.has(name)) return undefined;
    entries.set(name, { name, method, compressedSize, size, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, inflated when needed; undefined when the local header or sizes disagree with the directory. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<Uint8Array | undefined> {
  if (entry.size > maxBytes) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LOCAL_FILE_HEADER) return undefined;
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > bytes.byteLength) return undefined;
  const compressed = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed.byteLength === entry.size ? compressed : undefined;
  try {
    // Inflated in chunks and abandoned once past the declared size, so a header that lies cannot exhaust memory.
    const reader = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const inflated = new Uint8Array(entry.size);
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > entry.size) { await reader.cancel(); return undefined; }
      inflated.set(value, length);
      length += value.byteLength;
    }
    return length === entry.size ? inflated : undefined;
  } catch { return undefined; }
}
