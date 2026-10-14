import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { inspectArchive, assertEmulatorCompatible, archiveKind, extractIosBundle, parsePlist, readArchiveIcon, missingEmulatorLibs } = await tsImport("../../src/binary/archive.ts", import.meta.url);

const plist = (platform) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.example.app</string>
<key>CFBundleDisplayName</key><string>Example</string>
<key>CFBundleShortVersionString</key><string>1.2.0</string>
<key>CFBundleVersion</key><string>7</string>
<key>MinimumOSVersion</key><string>16.4</string>
<key>DTPlatformName</key><string>${platform}</string>
</dict></plist>`;

async function appBundle(root, name, platform = "iphonesimulator") {
  const app = join(root, name);
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "Info.plist"), plist(platform));
  await writeFile(join(app, "Example"), Buffer.from("binary"));
  return app;
}

function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136); header.write("        ", 148); header.write("0", 156);
  header.write("ustar\0", 257); header.write("00", 263);
  let sum = 0; for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512); body.copy(padded);
  return Buffer.concat([header, padded]);
}
const tgz = (entries) => gzipSync(Buffer.concat([...entries.map(([name, body]) => tarEntry(name, Buffer.from(body))), Buffer.alloc(1024)]));

test("an iOS simulator .app is identified from its Info.plist", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-archive-"));
  const archive = await inspectArchive(await appBundle(root, "Example.app"));
  assert.equal(archive.kind, "ios-app"); assert.equal(archive.platform, "ios");
  assert.equal(archive.bundleId, "dev.example.app"); assert.equal(archive.appName, "Example");
  assert.equal(archive.version, "1.2.0"); assert.equal(archive.buildNumber, "7"); assert.equal(archive.simulator, true);
  assert.match(archive.sha256, /^[a-f0-9]{64}$/); assert.ok(archive.bytes > 0);
  assert.doesNotThrow(() => assertEmulatorCompatible(archive));
});

test("a device build is rejected before any session starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-archive-"));
  const archive = await inspectArchive(await appBundle(root, "Device.app", "iphoneos"));
  assert.equal(archive.simulator, false);
  assert.throws(() => assertEmulatorCompatible(archive), error => /simulator/i.test(error.message) && /^ARCHIVE_/.test(error.code));
});

test("unsupported archive kinds fail fast with a next action", () => {
  assert.throws(() => archiveKind("/tmp/app.aab"), error => error.code === "ARCHIVE_AAB_UNSUPPORTED" && /apk/i.test(error.nextAction));
  assert.throws(() => archiveKind("/tmp/app.exe"), error => error.code === "ARCHIVE_KIND_UNKNOWN");
  assert.equal(archiveKind("/tmp/app.APK"), "android-apk"); assert.equal(archiveKind("/tmp/app.tar.gz"), "ios-tgz"); assert.equal(archiveKind("/tmp/app.ipa"), "ios-ipa");
});

test("missing paths and oversized archives are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-archive-"));
  await assert.rejects(inspectArchive(join(root, "missing.apk")), error => /^ARCHIVE_/.test(error.code));
  const app = await appBundle(root, "Big.app");
  await assert.rejects(inspectArchive(app, { maxBytes: 4 }), error => /^ARCHIVE_/.test(error.code) && /\bMB\b|size|large|exceed/i.test(error.message));
});

test("an APK without an emulator ABI is rejected; a universal one passes", () => {
  const base = { path: "/tmp/app.apk", kind: "android-apk", platform: "android", bundleId: "dev.example.app", appName: "Example", simulator: true, sha256: "0".repeat(64), bytes: 10 };
  assert.throws(() => assertEmulatorCompatible({ ...base, abis: ["arm64-v8a", "armeabi-v7a"] }), error => error.code === "ARCHIVE_ABI_UNSUPPORTED");
  assert.throws(() => assertEmulatorCompatible({ ...base, abis: ["x86"] }), error => error.code === "ARCHIVE_ABI_UNSUPPORTED" && /x86_64/.test(error.message));
  assert.doesNotThrow(() => assertEmulatorCompatible({ ...base, abis: ["arm64-v8a", "x86_64"] }));
  assert.doesNotThrow(() => assertEmulatorCompatible({ ...base, abis: [] }));
  assert.throws(() => assertEmulatorCompatible({ ...base, abis: ["x86_64"], signed: false }), error => error.code === "ARCHIVE_UNSIGNED" && /sign/i.test(error.nextAction));
  assert.doesNotThrow(() => assertEmulatorCompatible({ ...base, abis: ["x86_64"], signed: true }));
});

test("a .tar.gz simulator build is inspected without extraction and extracted safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-archive-"));
  const path = join(root, "Example.tar.gz");
  await writeFile(path, tgz([["Example.app/Info.plist", plist("iphonesimulator")], ["Example.app/Example", "binary"]]));
  const archive = await inspectArchive(path);
  assert.equal(archive.kind, "ios-tgz"); assert.equal(archive.bundleId, "dev.example.app"); assert.equal(archive.simulator, true);
  const extracted = await extractIosBundle(archive, join(root, "out"));
  assert.match(extracted, /Example\.app$/);
});

test("a tarball that escapes its directory is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-archive-"));
  const path = join(root, "Evil.tar.gz");
  await writeFile(path, tgz([["Example.app/Info.plist", plist("iphonesimulator")], ["Example.app/../../evil", "pwned"]]));
  await assert.rejects(async () => { const archive = await inspectArchive(path); await extractIosBundle(archive, join(root, "out")); });
});

test("malformed binary plists fail as archive errors, and URL schemes are read from CFBundleURLTypes", async () => {
  for (const bytes of [Buffer.from("bplist00"), Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(40, 0xff)])]) {
    assert.throws(() => parsePlist(bytes), error => error.code === "ARCHIVE_INVALID");
  }
  const root = await mkdtemp(join(tmpdir(), "explore-archive-"));
  const app = await appBundle(root, "Schemes.app");
  await writeFile(join(app, "Info.plist"), plist("iphonesimulator").replace("</dict></plist>",
    "<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>Euxy</string><string>exp+euxy</string><string>bad scheme</string></array></dict></array></dict></plist>"));
  const archive = await inspectArchive(app);
  assert.deepEqual(archive.urlSchemes, ["euxy", "exp+euxy"]);
});

const ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("the app icon is read from an iOS bundle's AppIcon PNG and skipped when only Assets.car ships it", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-archive-icon-"));
  const withIcon = await appBundle(root, "Icon.app");
  await writeFile(join(withIcon, "AppIcon60x60@2x.png"), ICON_PNG);
  await writeFile(join(withIcon, "AppIcon76x76@2x~ipad.png"), Buffer.from("not a png"));
  const icon = await readArchiveIcon(await inspectArchive(withIcon));
  assert.ok(icon, "icon expected"); assert.equal(icon.readUInt32BE(16), 1); assert.equal(icon.subarray(1, 4).toString(), "PNG");
  const carOnly = await appBundle(root, "Car.app");
  await writeFile(join(carOnly, "Assets.car"), Buffer.from("car"));
  assert.equal(await readArchiveIcon(await inspectArchive(carOnly)), undefined);
});

test("a universal APK whose x86_64 libraries are incomplete is flagged", () => {
  const status = ["lib/arm64-v8a/libgojni.so", "lib/arm64-v8a/libhermes.so", "lib/armeabi-v7a/libgojni.so", "lib/x86_64/libhermes.so", "lib/x86/libhermes.so", "classes.dex"];
  assert.deepEqual(missingEmulatorLibs(status), ["libgojni.so"]);
  assert.deepEqual(missingEmulatorLibs(["lib/arm64-v8a/libhermes.so", "lib/x86_64/libhermes.so"]), []);
  assert.deepEqual(missingEmulatorLibs(["lib/arm64-v8a/libgojni.so"]), [], "no x86_64 at all is the ABI check's job");
});
