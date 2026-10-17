import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, writeFile, chmod } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { Reader, Uint8ArrayWriter, ZipReader, configure } from "@zip.js/zip.js";
import { CiError } from "../shared/ci-errors.js";
import { APP_ICON_SOURCE_LIMIT, isWebp, shrinkAppIcon, webpSize } from "../capture/app-icon.js";
import { resolveResourceStrings } from "./android-resources.js";
import type { Platform } from "../types.js";

export type ArchiveKind = "ios-app" | "ios-tgz" | "ios-ipa" | "android-apk";

/** What Explore learned about a prebuilt application archive before any session or model work. */
export type InspectedArchive = {
  path: string;
  kind: ArchiveKind;
  platform: Platform;
  bundleId: string;
  appName: string;
  version?: string;
  buildNumber?: string;
  minimumOsVersion?: string;
  /** iOS: the archive targets the simulator SDK (`DTPlatformName` names a simulator). Android: always true. */
  simulator: boolean;
  /** Android native library ABIs; empty for pure JavaScript/Kotlin apps that run on any emulator. */
  abis: string[];
  /** Android: libraries another ABI ships that lib/x86_64 lacks; the app loads on the emulator and then dies in dlopen. */
  missingLibs?: string[];
  /** Android: the APK carries a v1 certificate or an APK Signing Block; an unsigned APK cannot be installed. */
  signed?: boolean;
  /** URL schemes the app registers (iOS CFBundleURLTypes); `open` is confined to these when known. Empty when unknown. */
  urlSchemes: string[];
  /** Android: the files the manifest's `android:icon` resolves to, one per density; the icon is read from the largest PNG among them. */
  iconPaths?: string[];
  sha256: string;
  bytes: number;
};

export const DEFAULT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_RESOURCE_TABLE_BYTES = 32 * 1024 * 1024;

export function archiveError(code: string, message: string, nextAction: string, details?: Record<string, unknown>): CiError {
  return new CiError({ code, stage: "archive", message, nextAction, ...(details ? { details } : {}) });
}

/** The archive kind from its name; the content check follows and may still reject it. */
export function archiveKind(path: string): ArchiveKind {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".app")) return "ios-app";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return "ios-tgz";
  if (name.endsWith(".ipa")) return "ios-ipa";
  if (name.endsWith(".apk")) return "android-apk";
  if (name.endsWith(".aab")) throw archiveError("ARCHIVE_AAB_UNSUPPORTED", "Android App Bundles cannot be installed on an emulator.",
    "Build an APK (for example an EAS profile with buildType apk, or bundletool build-apks --mode universal) and pass that .apk.");
  throw archiveError("ARCHIVE_KIND_UNKNOWN", `Unsupported archive: ${basename(path)}`,
    "Pass an iOS simulator .app directory, a .tar.gz of one, a simulator .ipa, or an Android .apk.");
}

export async function inspectArchive(input: string, options: { maxBytes?: number } = {}): Promise<InspectedArchive> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const kind = archiveKind(input);
  const path = await realpath(resolve(input)).catch(() => { throw archiveError("ARCHIVE_NOT_FOUND", `Archive not found: ${input}`, "Check the path and rerun."); });
  const info = await lstat(path);
  if (kind === "ios-app") {
    if (!info.isDirectory()) throw archiveError("ARCHIVE_INVALID", "An iOS .app must be a directory (the simulator bundle), not a file.", "Pass the unpacked .app directory or its .tar.gz.");
    const digest = await hashDirectory(path, maxBytes);
    const plist = parsePlist(await readFile(join(path, "Info.plist")).catch(() => { throw archiveError("ARCHIVE_INVALID", "The .app has no Info.plist.", "Pass a complete iOS simulator .app bundle."); }));
    return { path, kind, platform: "ios", ...iosMetadata(plist, path), abis: [], ...digest };
  }
  if (!info.isFile()) throw archiveError("ARCHIVE_INVALID", `${basename(path)} is not a regular file.`, "Pass a regular archive file.");
  if (info.size > maxBytes) throw archiveError("ARCHIVE_TOO_LARGE", `${basename(path)} is ${info.size} bytes; the limit is ${maxBytes}.`, "Pass a smaller archive or raise the archive size limit.", { bytes: info.size, maxBytes });
  const sha256 = await hashFile(path);
  const digest = { sha256, bytes: info.size };
  if (kind === "ios-tgz") {
    const plist = await tarEntry(path, name => /^(\.\/)?[^/]+\.app\/Info\.plist$/.test(name));
    if (!plist) throw archiveError("ARCHIVE_INVALID", "The tarball has no top-level <name>.app/Info.plist.", "Pass an EAS iOS simulator build archive (.tar.gz containing one .app).");
    return { path, kind, platform: "ios", ...iosMetadata(parsePlist(plist.contents), path), abis: [], ...digest };
  }
  if (kind === "ios-ipa") {
    const entries = await zipEntries(path);
    const plistEntry = entries.find(entry => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.filename));
    if (!plistEntry) throw archiveError("ARCHIVE_INVALID", "The .ipa has no Payload/<name>.app/Info.plist.", "Pass a complete iOS archive.");
    return { path, kind, platform: "ios", ...iosMetadata(parsePlist(Buffer.from(await readZipEntry(plistEntry))), path), abis: [], ...digest };
  }
  const entries = await zipEntries(path);
  const manifest = entries.find(entry => entry.filename === "AndroidManifest.xml");
  if (!manifest) throw archiveError("ARCHIVE_INVALID", "The .apk has no AndroidManifest.xml.", "Pass a complete Android APK.");
  const parsed = parseAndroidManifest(Buffer.from(await readZipEntry(manifest)));
  if (!parsed.package) throw archiveError("ARCHIVE_INVALID", "The APK manifest names no package.", "Pass a complete Android APK.");
  const abis = [...new Set(entries.map(entry => /^lib\/([^/]+)\//.exec(entry.filename)?.[1]).filter((abi): abi is string => !!abi))].sort();
  const missingLibs = missingEmulatorLibs(entries.map(entry => entry.filename));
  const signed = entries.some(entry => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(entry.filename)) || await apkSigningBlockPresent(path);
  // A release APK names and draws itself by resource reference; the table resolves them, and a broken table costs only the fallbacks.
  const resources = entries.find(entry => entry.filename === "resources.arsc");
  const table = resources && (parsed.labelRef !== undefined || parsed.iconRef !== undefined) && resources.uncompressedSize <= MAX_RESOURCE_TABLE_BYTES
    ? Buffer.from(await readZipEntry(resources, MAX_RESOURCE_TABLE_BYTES)) : undefined;
  const label = table && parsed.labelRef !== undefined ? resolveResourceStrings(table, parsed.labelRef).find(value => value.trim()) : undefined;
  const iconPaths = table && parsed.iconRef !== undefined ? resolveResourceStrings(table, parsed.iconRef) : [];
  return { path, kind, platform: "android", bundleId: parsed.package, appName: label?.trim() ?? parsed.label ?? parsed.package, ...(iconPaths.length ? { iconPaths } : {}),
    ...(parsed.versionName ? { version: parsed.versionName } : {}), ...(parsed.versionCode ? { buildNumber: parsed.versionCode } : {}),
    ...(parsed.minSdkVersion ? { minimumOsVersion: parsed.minSdkVersion } : {}), simulator: true, abis, ...(missingLibs.length ? { missingLibs } : {}), signed, urlSchemes: [], ...digest };
}

/** An APK signed with scheme v2 or later carries an APK Signing Block right before the ZIP central directory, ending in this magic. */
export async function apkSigningBlockPresent(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 65_557));
    await handle.read(tail, 0, tail.length, size - tail.length);
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) !== 0x06054b50) continue;
      const centralDirectory = tail.readUInt32LE(at + 16);
      if (centralDirectory < 16 || centralDirectory > size) return false;
      const magic = Buffer.alloc(16);
      await handle.read(magic, 0, 16, centralDirectory - 16);
      return magic.toString("latin1") === "APK Sig Block 42";
    }
    return false;
  } catch {
    return false;
  } finally { await handle.close(); }
}

const IOS_ICON = /(?:^|\/)AppIcon[^/]*\.png$/;
const ANDROID_ICON = /^res\/(?:mipmap|drawable)-[^/]+\/ic_launcher(?:_round)?\.(?:png|webp)$/;

/**
 * The app's own icon for the Viewer header, shrunk to header size: the largest `AppIcon*.png` in an iOS bundle, the
 * largest PNG or WebP the manifest's `android:icon` resolves to in an APK (else `ic_launcher.png`/`.webp`). A PNG is shrunk; a WebP (what Expo
 * and Android Studio emit) is kept as is, since the browser decodes it. Icons that only live in `Assets.car` or an adaptive-icon XML are skipped
 * (the Viewer then shows the Expo mark); an icon never fails an exploration.
 */
export async function readArchiveIcon(archive: InspectedArchive): Promise<Buffer | undefined> {
  try {
    const largest = <T>(items: T[], size: (item: T) => number): T | undefined => items.reduce<T | undefined>((best, item) => !best || size(item) > size(best) ? item : best, undefined);
    let bytes: Buffer | undefined;
    if (archive.kind === "ios-app") {
      const names = (await readdir(archive.path)).filter(name => IOS_ICON.test(name));
      const sized = await Promise.all(names.map(async name => ({ name, size: (await lstat(join(archive.path, name))).size })));
      const pick = largest(sized.filter(item => item.size <= APP_ICON_SOURCE_LIMIT), item => item.size);
      bytes = pick ? await readFile(join(archive.path, pick.name)) : undefined;
    } else if (archive.kind === "ios-tgz") {
      const found: Array<{ name: string; contents: Buffer }> = [];
      await walkTar(archive.path, async (entry, contents) => {
        if (/^(\.\/)?[^/]+\.app\/[^/]+$/.test(entry.name) && IOS_ICON.test(entry.name) && entry.size <= APP_ICON_SOURCE_LIMIT) found.push({ name: entry.name, contents: await contents() });
      });
      bytes = largest(found, item => item.contents.length)?.contents;
    } else {
      const declared = new Set((archive.iconPaths ?? []).filter(path => /\.(?:png|webp)$/i.test(path)));
      const entries = (await zipEntries(archive.path)).filter(entry => archive.kind === "ios-ipa"
        ? /^Payload\/[^/]+\.app\/[^/]+$/.test(entry.filename) && IOS_ICON.test(entry.filename)
        : declared.size ? declared.has(entry.filename) : ANDROID_ICON.test(entry.filename));
      const pick = largest(entries.filter(entry => entry.uncompressedSize <= APP_ICON_SOURCE_LIMIT), entry => entry.uncompressedSize);
      bytes = pick ? Buffer.from(await readZipEntry(pick, APP_ICON_SOURCE_LIMIT)) : undefined;
    }
    if (!bytes) return undefined;
    return isWebp(bytes) ? (webpSize(bytes) ? bytes : undefined) : shrinkAppIcon(bytes);
  } catch {
    return undefined;
  }
}

/** Explore's EAS Android emulator is x86_64 with no 32-bit support; an APK that ships only ARM or x86 libraries fails to install there. */
export function assertEmulatorCompatible(archive: InspectedArchive, emulatorAbis: readonly string[] = ["x86_64"]): void {
  if (archive.platform === "ios") {
    if (!archive.simulator) throw archiveError("ARCHIVE_NOT_SIMULATOR", `${basename(archive.path)} is an iOS device build; it cannot run on the EAS Simulator.`,
      "Build for the simulator (an EAS profile with ios.simulator: true) and pass that .app, .tar.gz, or simulator .ipa.");
    return;
  }
  if (archive.signed === false) {
    throw archiveError("ARCHIVE_UNSIGNED", `${basename(archive.path)} is not signed, so Android refuses to install it (INSTALL_PARSE_FAILED_NO_CERTIFICATES).`,
      "Sign the APK first (apksigner sign --ks ~/.android/debug.keystore app.apk) or pass a signed debug or release build.");
  }
  if (archive.abis.length && !archive.abis.some(abi => emulatorAbis.includes(abi))) {
    throw archiveError("ARCHIVE_ABI_UNSUPPORTED", `The APK ships native libraries only for ${archive.abis.join(", ")}; the emulator needs ${emulatorAbis.join(" or ")}.`,
      "Build a universal APK or one that includes x86_64 native libraries.", { abis: archive.abis, emulatorAbis: [...emulatorAbis] });
  }
}

function iosMetadata(plist: unknown, path: string): Pick<InspectedArchive, "bundleId" | "appName" | "version" | "buildNumber" | "minimumOsVersion" | "simulator" | "urlSchemes"> {
  const dict = plist && typeof plist === "object" && !Array.isArray(plist) ? plist as Record<string, unknown> : {};
  const text = (key: string) => typeof dict[key] === "string" && (dict[key] as string).trim() ? (dict[key] as string).trim() : undefined;
  const bundleId = text("CFBundleIdentifier");
  if (!bundleId || !/^[A-Za-z0-9.-]{1,255}$/.test(bundleId)) throw archiveError("ARCHIVE_INVALID", "Info.plist has no valid CFBundleIdentifier.", "Pass a complete iOS app bundle.", { path });
  const platformName = text("DTPlatformName") ?? "";
  const supported = Array.isArray(dict.CFBundleSupportedPlatforms) ? dict.CFBundleSupportedPlatforms.map(String) : [];
  const simulator = platformName.toLowerCase().includes("simulator") || supported.some(name => /simulator/i.test(name));
  const version = text("CFBundleShortVersionString"), buildNumber = text("CFBundleVersion"), minimumOsVersion = text("MinimumOSVersion");
  const urlTypes = Array.isArray(dict.CFBundleURLTypes) ? dict.CFBundleURLTypes : [];
  const urlSchemes = [...new Set(urlTypes.flatMap(entry => entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).CFBundleURLSchemes)
    ? ((entry as Record<string, unknown>).CFBundleURLSchemes as unknown[]).flatMap(scheme => typeof scheme === "string" && /^[A-Za-z][A-Za-z0-9+.-]{0,63}$/.test(scheme) ? [scheme.toLowerCase()] : []) : []))].sort();
  return { bundleId, appName: text("CFBundleDisplayName") ?? text("CFBundleName") ?? bundleId,
    ...(version ? { version } : {}), ...(buildNumber ? { buildNumber } : {}), ...(minimumOsVersion ? { minimumOsVersion } : {}), simulator, urlSchemes };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A stable digest of a bundle directory: every regular file's relative path and bytes, in sorted order. */
async function hashDirectory(root: string, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw archiveError("ARCHIVE_INVALID", `The .app contains a symbolic link: ${relative(root, path)}`, "Pass a bundle without symbolic links.");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      if (files.length > MAX_ARCHIVE_ENTRIES) throw archiveError("ARCHIVE_TOO_LARGE", "The .app has too many files.", "Pass a smaller bundle.");
    }
  };
  await walk(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const info = await lstat(file);
    bytes += info.size;
    if (bytes > maxBytes) throw archiveError("ARCHIVE_TOO_LARGE", `The .app exceeds ${maxBytes} bytes.`, "Pass a smaller bundle or raise the archive size limit.");
    hash.update(`${relative(root, file).split(sep).join("/")}\0${info.size}\0`);
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
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

async function tarEntry(path: string, match: (name: string) => boolean): Promise<{ name: string; contents: Buffer } | undefined> {
  let found: { name: string; contents: Buffer } | undefined;
  await walkTar(path, async (entry, contents) => {
    if (entry.type !== "0" || !match(entry.name)) return false;
    if (entry.size > MAX_METADATA_BYTES) throw archiveError("ARCHIVE_INVALID", `${entry.name} is too large to be metadata.`, "Pass a valid archive.");
    found = { name: entry.name, contents: await contents() };
    return true;
  });
  return found;
}

export function safeRelativePath(name: string): string | undefined {
  const parts = name.replace(/^\.\//, "").split("/").filter(part => part.length);
  if (!parts.length || parts.some(part => part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) return undefined;
  return parts.join("/");
}

/**
 * Unpack the iOS bundle out of a .tar.gz or simulator .ipa into `destination` for installation.
 * Paths are confined to the destination; symbolic and hard links are rejected (an app bundle has none).
 */
export async function extractIosBundle(archive: InspectedArchive, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await realpath(destination);
  let appDirectory: string | undefined;
  let bytes = 0;
  const place = async (name: string, type: string, mode: number, contents: () => Promise<Buffer>) => {
    const rel = safeRelativePath(name);
    if (!rel) throw archiveError("ARCHIVE_INVALID", `Unsafe archive path: ${name}`, "Pass an archive without path traversal.");
    const appMatch = /^((?:Payload\/)?[^/]+\.app)(\/|$)/.exec(rel);
    if (!appMatch) return;
    const app = join(root, appMatch[1]!);
    if (appDirectory && appDirectory !== app) throw archiveError("ARCHIVE_INVALID", "The archive contains more than one .app bundle.", "Pass an archive with a single app.");
    appDirectory = app;
    const target = resolve(root, rel);
    if (relative(root, target).startsWith("..")) throw archiveError("ARCHIVE_INVALID", `Unsafe archive path: ${name}`, "Pass an archive without path traversal.");
    if (type === "5" || rel.endsWith("/")) { await mkdir(target, { recursive: true, mode: 0o700 }); return; }
    if (type !== "0") throw archiveError("ARCHIVE_INVALID", `Unsupported archive entry type for ${name}.`, "Pass an archive that contains only files and directories.");
    const data = await contents();
    bytes += data.length;
    if (bytes > DEFAULT_MAX_ARCHIVE_BYTES) throw archiveError("ARCHIVE_TOO_LARGE", "The archive expands past the size limit.", "Pass a smaller archive.");
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { flag: "wx", mode: 0o600 });
    if (mode & 0o111) await chmod(target, 0o700);
  };
  if (archive.kind === "ios-tgz") {
    await walkTar(archive.path, async (entry, contents, skip) => {
      if (entry.type === "0" || entry.type === "5") await place(entry.name, entry.type, entry.mode, contents); else await skip();
    });
  } else if (archive.kind === "ios-ipa") {
    for (const entry of await zipEntries(archive.path)) {
      if (entry.directory) await place(entry.filename, "5", 0, async () => Buffer.alloc(0));
      else await place(entry.filename, "0", ((entry.externalFileAttributes ?? 0) >>> 16) & 0o777, async () => Buffer.from(await readZipEntry(entry)));
    }
  } else throw new Error(`extractIosBundle does not apply to ${archive.kind}`);
  if (!appDirectory) throw archiveError("ARCHIVE_INVALID", "The archive contains no .app bundle.", "Pass an iOS simulator build archive.");
  return appDirectory;
}

// ---- zip ----------------------------------------------------------------------------------------

type ZipEntry = Awaited<ReturnType<ZipReader<unknown>["getEntries"]>>[number];

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

async function zipEntries(path: string): Promise<ZipEntry[]> {
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

async function readZipEntry(entry: ZipEntry, maxBytes = MAX_METADATA_BYTES): Promise<Uint8Array> {
  if (entry.directory || !entry.getData) throw archiveError("ARCHIVE_INVALID", `${entry.filename} is not a file entry.`, "Pass a valid archive.");
  if (entry.uncompressedSize > maxBytes) throw archiveError("ARCHIVE_INVALID", `${entry.filename} is too large.`, "Pass a valid archive.");
  return entry.getData(new Uint8ArrayWriter(), { checkSignature: true, useWebWorkers: false });
}

// ---- plist --------------------------------------------------------------------------------------

/** Property list reader for Info.plist: XML (Xcode default) or binary (`bplist00`). */
export function parsePlist(bytes: Buffer): unknown {
  if (bytes.subarray(0, 8).toString("latin1") === "bplist00") return parseBinaryPlist(bytes);
  const text = bytes.toString("utf8");
  if (!/<plist/i.test(text)) throw archiveError("ARCHIVE_INVALID", "Info.plist is neither XML nor binary.", "Pass a complete iOS app bundle.");
  const tokens = [...text.matchAll(/<\/?([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g)];
  let index = 0;
  const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&");
  const skipText = () => { while (index < tokens.length && tokens[index]![4] !== undefined) index++; };
  const textUntilClose = (tag: string): string => {
    let value = "";
    while (index < tokens.length) {
      const token = tokens[index++]!;
      if (token[1] === tag && token[0].startsWith("</")) return unescape(value);
      if (token[4] !== undefined) value += token[4];
    }
    throw new Error(`Unterminated <${tag}>`);
  };
  const parseValue = (): unknown => {
    skipText();
    const token = tokens[index++];
    if (!token || token[0].startsWith("</")) throw new Error("Unexpected plist token");
    const tag = token[1]!.toLowerCase(), selfClosing = token[3] === "/";
    switch (tag) {
      case "dict": {
        const out: Record<string, unknown> = {};
        if (selfClosing) return out;
        for (;;) {
          skipText();
          const next = tokens[index]!;
          if (next[0].startsWith("</")) { index++; return out; }
          if (next[1] !== "key") throw new Error("Expected <key>");
          index++;
          const key = textUntilClose("key");
          out[key] = parseValue();
        }
      }
      case "array": {
        const out: unknown[] = [];
        if (selfClosing) return out;
        for (;;) {
          skipText();
          if (tokens[index]![0].startsWith("</")) { index++; return out; }
          out.push(parseValue());
        }
      }
      case "string": case "date": case "data": return selfClosing ? "" : textUntilClose(token[1]!);
      case "integer": case "real": return selfClosing ? 0 : Number(textUntilClose(token[1]!).trim());
      case "true": return true;
      case "false": return false;
      case "plist": return parseValue();
      default: throw new Error(`Unknown plist element <${tag}>`);
    }
  };
  try {
    skipText();
    while (index < tokens.length && (tokens[index]![0].startsWith("<?") || tokens[index]![0].startsWith("<!") || tokens[index]![4] !== undefined)) index++;
    return parseValue();
  } catch (error) {
    throw archiveError("ARCHIVE_INVALID", `Info.plist could not be parsed: ${error instanceof Error ? error.message : String(error)}`, "Pass a complete iOS app bundle.");
  }
}

function parseBinaryPlist(bytes: Buffer): unknown {
  if (bytes.length < 40) throw archiveError("ARCHIVE_INVALID", "Info.plist has an invalid binary layout.", "Pass a complete iOS app bundle.");
  const trailer = bytes.subarray(bytes.length - 32);
  const offsetSize = trailer[6]!, refSize = trailer[7]!;
  const objectCount = Number(trailer.readBigUInt64BE(8)), topObject = Number(trailer.readBigUInt64BE(16)), tableOffset = Number(trailer.readBigUInt64BE(24));
  if (!(offsetSize >= 1 && offsetSize <= 8) || !(refSize >= 1 && refSize <= 8) || objectCount > 1_000_000 || topObject >= objectCount || tableOffset >= bytes.length) {
    throw archiveError("ARCHIVE_INVALID", "Info.plist has an invalid binary layout.", "Pass a complete iOS app bundle.");
  }
  const readUInt = (offset: number, size: number): number => {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + i]!;
    return value;
  };
  const offsets = Array.from({ length: objectCount }, (_, i) => readUInt(tableOffset + i * offsetSize, offsetSize));
  let depth = 0;
  const parseObject = (id: number): unknown => {
    if (++depth > 512) throw new Error("Plist nesting is too deep");
    try {
      let offset = offsets[id]!;
      const marker = bytes[offset]!, type = marker >> 4;
      let count = marker & 0x0f;
      offset += 1;
      const readCount = () => {
        if (count === 0x0f) {
          const sizeMarker = bytes[offset]!; const size = 1 << (sizeMarker & 0x0f);
          count = readUInt(offset + 1, size); offset += 1 + size;
        }
      };
      switch (type) {
        case 0x0: return count === 0x08 ? false : count === 0x09 ? true : null;
        case 0x1: { const size = 1 << count; return size <= 6 ? readUInt(offset, size) : Number(bytes.readBigInt64BE(offset)); }
        case 0x2: return count === 2 ? bytes.readFloatBE(offset) : bytes.readDoubleBE(offset);
        case 0x3: return new Date((bytes.readDoubleBE(offset) + 978_307_200) * 1000).toISOString();
        case 0x4: readCount(); return bytes.subarray(offset, offset + count).toString("base64");
        case 0x5: readCount(); return bytes.subarray(offset, offset + count).toString("latin1");
        case 0x6: readCount(); return Buffer.from(bytes.subarray(offset, offset + count * 2)).swap16().toString("utf16le");
        case 0x8: return readUInt(offset, count + 1);
        case 0xa: { readCount(); return Array.from({ length: count }, (_, i) => parseObject(readUInt(offset + i * refSize, refSize))); }
        case 0xd: {
          readCount();
          const out: Record<string, unknown> = {};
          for (let i = 0; i < count; i++) {
            const key = parseObject(readUInt(offset + i * refSize, refSize));
            out[String(key)] = parseObject(readUInt(offset + (count + i) * refSize, refSize));
          }
          return out;
        }
        default: throw new Error(`Unsupported binary plist object type ${type}`);
      }
    } finally { depth--; }
  };
  try { return parseObject(topObject); }
  catch (error) { throw archiveError("ARCHIVE_INVALID", `Info.plist could not be parsed: ${error instanceof Error ? error.message : String(error)}`, "Pass a complete iOS app bundle."); }
}

// ---- Android binary XML -------------------------------------------------------------------------

export type AndroidManifest = { package?: string; versionName?: string; versionCode?: string; minSdkVersion?: string; label?: string; labelRef?: number; iconRef?: number };

/**
 * Read the `<manifest>` and `<uses-sdk>` attributes from Android's compiled (AXML) manifest.
 * Only the string pool and start-element chunks matter; resource ids are resolved for the few attributes used.
 */
export function parseAndroidManifest(bytes: Buffer): AndroidManifest {
  const result: AndroidManifest = {};
  try {
    if (bytes.readUInt16LE(0) !== 0x0003) throw new Error("not a binary XML document");
    const strings: string[] = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const chunkType = bytes.readUInt16LE(offset), headerSize = bytes.readUInt16LE(offset + 2), chunkSize = bytes.readUInt32LE(offset + 4);
      if (chunkSize < 8 || offset + chunkSize > bytes.length) throw new Error("truncated chunk");
      if (chunkType === 0x0001) {
        const stringCount = bytes.readUInt32LE(offset + 8), flags = bytes.readUInt32LE(offset + 16), stringsStart = bytes.readUInt32LE(offset + 20);
        const utf8 = (flags & (1 << 8)) !== 0;
        for (let i = 0; i < stringCount; i++) {
          let at = offset + stringsStart + bytes.readUInt32LE(offset + 28 + i * 4);
          if (utf8) {
            const lengthByte = (position: number) => { const first = bytes[position]!; return first & 0x80 ? { value: ((first & 0x7f) << 8) | bytes[position + 1]!, size: 2 } : { value: first, size: 1 }; };
            const chars = lengthByte(at); at += chars.size;
            const encoded = lengthByte(at); at += encoded.size;
            strings.push(bytes.subarray(at, at + encoded.value).toString("utf8"));
          } else {
            let length = bytes.readUInt16LE(at); at += 2;
            if (length & 0x8000) { length = ((length & 0x7fff) << 16) | bytes.readUInt16LE(at); at += 2; }
            strings.push(bytes.subarray(at, at + length * 2).toString("utf16le"));
          }
        }
      } else if (chunkType === 0x0102) {
        const name = strings[bytes.readUInt32LE(offset + 20)] ?? "";
        const attributeStart = bytes.readUInt16LE(offset + 24), attributeSize = bytes.readUInt16LE(offset + 26), attributeCount = bytes.readUInt16LE(offset + 28);
        if (name === "manifest" || name === "uses-sdk" || name === "application") {
          for (let i = 0; i < attributeCount; i++) {
            const at = offset + 16 + attributeStart + i * attributeSize;
            const attributeName = strings[bytes.readUInt32LE(at + 4)] ?? "";
            const rawValue = bytes.readUInt32LE(at + 8), dataType = bytes[at + 15]!, data = bytes.readUInt32LE(at + 16);
            const value = dataType === 0x03 ? strings[rawValue] : dataType === 0x10 ? String(data) : undefined;
            if (name === "manifest" && attributeName === "package" && value) result.package = value;
            else if (name === "manifest" && attributeName === "versionName" && value) result.versionName = value;
            else if (name === "manifest" && attributeName === "versionCode" && value) result.versionCode = value;
            else if (name === "uses-sdk" && attributeName === "minSdkVersion" && value) result.minSdkVersion = value;
            else if (name === "application" && attributeName === "label" && dataType === 0x03 && value) result.label = value;
            else if (name === "application" && attributeName === "label" && dataType === 0x01) result.labelRef = data;
            else if (name === "application" && attributeName === "icon" && dataType === 0x01) result.iconRef = data;
          }
        }
      }
      offset += chunkSize;
      if (headerSize > chunkSize) throw new Error("invalid chunk header");
    }
  } catch (error) {
    throw archiveError("ARCHIVE_INVALID", `AndroidManifest.xml could not be parsed: ${error instanceof Error ? error.message : String(error)}`, "Pass a complete Android APK.");
  }
  return result;
}

/**
 * A "universal" APK can still be incomplete for the emulator: Status ships libgojni.so for arm64-v8a and armeabi-v7a
 * only, so the x86_64 build installs, launches and dies in dlopen. These are the libraries some other ABI ships that
 * lib/x86_64 does not (empty when the APK has no x86_64 libraries at all; that case is ARCHIVE_ABI_UNSUPPORTED).
 */
export function missingEmulatorLibs(filenames: readonly string[]): string[] {
  const byAbi = new Map<string, Set<string>>();
  for (const filename of filenames) {
    const [, abi, lib] = /^lib\/([^/]+)\/([^/]+\.so)$/.exec(filename) ?? [];
    if (!abi || !lib) continue;
    const libs = byAbi.get(abi) ?? new Set<string>();
    libs.add(lib);
    byAbi.set(abi, libs);
  }
  const emulator = byAbi.get("x86_64");
  if (!emulator) return [];
  return [...new Set([...byAbi.values()].flatMap(set => [...set]))].filter(lib => !emulator.has(lib)).sort();
}
