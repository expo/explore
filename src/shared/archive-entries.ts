import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import { createGunzip } from "node:zlib";
import { Reader, Uint8ArrayWriter, ZipReader, configure } from "@zip.js/zip.js";
import { CiError } from "./ci-errors.js";

/**
 * Reads the entries of tar.gz and zip archives without unpacking them: a prebuilt app, a downloaded controller, a
 * baseline artifact. Nothing here writes a file; callers place entries themselves, through safeRelativePath.
 */

export const MAX_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 200_000;

export function archiveError(code: string, message: string, nextAction: string, details?: Record<string, unknown>): CiError {
  return new CiError({ code, stage: "archive", message, nextAction, ...(details ? { details } : {}) });
}

// ---- tar.gz -------------------------------------------------------------------------------------

type TarVisitor = (entry: { name: string; type: string; size: number; mode: number }, contents: () => Promise<Buffer>, skip: () => Promise<void>) => Promise<boolean | void>;

/** Walk a gzip tarball once; `visit` returns true to stop. Long GNU names are honoured; nothing is written. */
export async function walkTar(path: string, visit: TarVisitor): Promise<void> {
  const stream = createReadStream(path).pipe(createGunzip());
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let done = false;
  const fill = async (needed: number) => {
    while (buffer.length < needed && !done) {
      const next = await iterator.next();
      if (next.done) { done = true; break; }
      buffer = Buffer.concat([buffer, next.value as Buffer]);
    }
  };
  const take = async (count: number): Promise<Buffer> => {
    await fill(count);
    if (buffer.length < count) throw archiveError("ARCHIVE_INVALID", "The tarball ended unexpectedly.", "Pass a complete .tar.gz archive.");
    const out = buffer.subarray(0, count); buffer = buffer.subarray(count); return Buffer.from(out);
  };
  const drop = async (count: number) => {
    let remaining = count;
    while (remaining > 0) {
      await fill(Math.min(remaining, 1 << 20));
      const step = Math.min(remaining, buffer.length);
      if (!step) throw archiveError("ARCHIVE_INVALID", "The tarball ended unexpectedly.", "Pass a complete .tar.gz archive.");
      buffer = buffer.subarray(step); remaining -= step;
    }
  };
  let longName: string | undefined;
  let entries = 0;
  try {
    for (;;) {
      await fill(512);
      if (buffer.length < 512 || buffer.subarray(0, 512).every(byte => byte === 0)) return;
      const header = await take(512);
      const field = (offset: number, length: number) => header.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(field(124, 12).trim() || "0", 8);
      const type = field(156, 1) || "0";
      const prefix = field(345, 155);
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = undefined;
      const padded = Math.ceil(size / 512) * 512;
      if (type === "L") { longName = (await take(padded)).subarray(0, size).toString("utf8").replace(/\0+$/, ""); continue; }
      if (++entries > MAX_ARCHIVE_ENTRIES) throw archiveError("ARCHIVE_TOO_LARGE", "The tarball has too many entries.", "Pass a smaller archive.");
      let consumed = false;
      const stop = await visit({ name, type, size, mode: parseInt(field(100, 8).trim() || "0", 8) },
        async () => { consumed = true; return (await take(padded)).subarray(0, size); },
        async () => { consumed = true; await drop(padded); });
      if (!consumed) await drop(padded);
      if (stop) return;
    }
  } finally { await iterator.return?.(undefined); }
}

export function safeRelativePath(name: string): string | undefined {
  const parts = name.replace(/^\.\//, "").split("/").filter(part => part.length);
  if (!parts.length || parts.some(part => part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) return undefined;
  return parts.join("/");
}

// ---- zip ----------------------------------------------------------------------------------------

export type ZipEntry = Awaited<ReturnType<ZipReader<unknown>["getEntries"]>>[number];

/** zip.js reads the central directory and entries by range, so a 200 MB APK is never loaded whole. */
class FileRangeReader extends Reader<unknown> {
  constructor(private readonly path: string) { super(path); }
  override async init(): Promise<void> {
    this.size = (await lstat(this.path)).size;
  }
  /** Each range opens its own descriptor: nothing stays open after the entries are read, so no handle leaks when a caller stops early. */
  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    const handle = await open(this.path, "r");
    try {
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(out, offset, length - offset, index + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return offset === length ? out : out.subarray(0, offset);
    } finally { await handle.close(); }
  }
}

const readers = new WeakMap<object, FileRangeReader>();

/** The ABIs an APK ships native libraries for (`lib/<abi>/`), without reading its manifest. */
export async function apkAbis(path: string): Promise<string[]> {
  return [...new Set((await zipEntries(path)).map(entry => /^lib\/([^/]+)\//.exec(entry.filename)?.[1]).filter((abi): abi is string => !!abi))].sort();
}

export async function zipEntries(path: string): Promise<ZipEntry[]> {
  configure({ useWebWorkers: false });
  const reader = new FileRangeReader(path);
  const zip = new ZipReader(reader, { useWebWorkers: false });
  try {
    const entries = await zip.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw archiveError("ARCHIVE_TOO_LARGE", "The archive has too many entries.", "Pass a smaller archive.");
    for (const entry of entries) readers.set(entry, reader);
    return entries;
  } catch (error) {
    if (error instanceof CiError) throw error;
    throw archiveError("ARCHIVE_INVALID", `${basename(path)} is not a readable ZIP archive: ${error instanceof Error ? error.message : String(error)}`, "Pass a valid .ipa or .apk.");
  }
}

export async function readZipEntry(entry: ZipEntry, maxBytes = MAX_METADATA_BYTES): Promise<Uint8Array> {
  if (entry.directory || !entry.getData) throw archiveError("ARCHIVE_INVALID", `${entry.filename} is not a file entry.`, "Pass a valid archive.");
  if (entry.uncompressedSize > maxBytes) throw archiveError("ARCHIVE_INVALID", `${entry.filename} is too large.`, "Pass a valid archive.");
  return entry.getData(new Uint8ArrayWriter(), { checkSignature: true, useWebWorkers: false });
}
