import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const { resolveResourceStrings } = await tsImport("../../src/binary/android-resources.ts", import.meta.url);

const chunk = (type, header, body) => {
  const out = Buffer.alloc(8 + header.length + body.length);
  out.writeUInt16LE(type, 0); out.writeUInt16LE(8 + header.length, 2); out.writeUInt32LE(out.length, 4);
  header.copy(out, 8); body.copy(out, 8 + header.length);
  return out;
};
const stringPool = (strings) => {
  const encoded = strings.map(value => { const bytes = Buffer.from(value, "utf8"); return Buffer.concat([Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0])]); });
  const offsets = Buffer.alloc(strings.length * 4);
  let at = 0; encoded.forEach((bytes, i) => { offsets.writeUInt32LE(at, i * 4); at += bytes.length; });
  const header = Buffer.alloc(20);
  header.writeUInt32LE(strings.length, 0); header.writeUInt32LE(0, 4); header.writeUInt32LE(1 << 8, 8); header.writeUInt32LE(28 + offsets.length, 12); header.writeUInt32LE(0, 16);
  return chunk(0x0001, header, Buffer.concat([offsets, ...encoded]));
};
/** One type chunk: `entries` maps entry index to a global string index (or a complex entry when negative). */
const typeChunk = (typeId, count, entries, configSize = 64) => {
  const header = Buffer.alloc(12 + configSize);
  header[0] = typeId; header.writeUInt32LE(count, 4); header.writeUInt32LE(20 + configSize + count * 4, 8); header.writeUInt32LE(configSize, 12);
  const offsets = Buffer.alloc(count * 4, 0xff);
  const bodies = [];
  let at = 0;
  for (const [index, stringIndex] of Object.entries(entries)) {
    offsets.writeUInt32LE(at, Number(index) * 4);
    const entry = Buffer.alloc(16);
    entry.writeUInt16LE(8, 0); entry.writeUInt16LE(stringIndex < 0 ? 1 : 0, 2); entry.writeUInt32LE(0, 4);
    entry.writeUInt16LE(8, 8); entry[11] = 0x03; entry.writeUInt32LE(Math.abs(stringIndex), 12);
    bodies.push(entry); at += 16;
  }
  return chunk(0x0201, header, Buffer.concat([offsets, ...bodies]));
};
const table = (strings, types, packageId = 0x7f) => {
  const packageHeader = Buffer.alloc(0x110);
  packageHeader.writeUInt32LE(packageId, 0);
  const pkg = chunk(0x0200, packageHeader, Buffer.concat(types));
  const header = Buffer.alloc(4); header.writeUInt32LE(1, 0);
  return chunk(0x0002, header, Buffer.concat([stringPool(strings), pkg]));
};

test("a resource id resolves to its string in every configuration, in table order", () => {
  const bytes = table(["Bluesky", "res/mipmap-mdpi-v4/ic_launcher.png", "res/mipmap-xxhdpi-v4/ic_launcher.png", "res/mipmap-anydpi-v26/ic_launcher.xml"],
    [typeChunk(0x13, 0x30, { 0x21: 0 }), typeChunk(0x10, 0x20, { 0x16: 1 }), typeChunk(0x10, 0x20, { 0x16: 2 }), typeChunk(0x10, 0x20, { 0x16: 3 })]);
  assert.deepEqual(resolveResourceStrings(bytes, 0x7f130021), ["Bluesky"]);
  assert.deepEqual(resolveResourceStrings(bytes, 0x7f100016), ["res/mipmap-mdpi-v4/ic_launcher.png", "res/mipmap-xxhdpi-v4/ic_launcher.png", "res/mipmap-anydpi-v26/ic_launcher.xml"]);
});

test("missing entries, other packages, complex entries and garbage resolve to nothing", () => {
  const bytes = table(["Bluesky"], [typeChunk(0x13, 0x30, { 0x21: 0, 0x22: -0 })]);
  assert.deepEqual(resolveResourceStrings(bytes, 0x7f130023), []);
  assert.deepEqual(resolveResourceStrings(bytes, 0x7e130021), []);
  assert.deepEqual(resolveResourceStrings(Buffer.from("not a table at all"), 0x7f130021), []);
  assert.deepEqual(resolveResourceStrings(bytes.subarray(0, 40), 0x7f130021), []);
  const complex = table(["x"], [typeChunk(0x13, 0x30, { 0x21: -1 })]);
  assert.deepEqual(resolveResourceStrings(complex, 0x7f130021), []);
});
