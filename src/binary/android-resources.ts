/**
 * Just enough of Android's compiled resource table (`resources.arsc`) to turn the `@string`/`@mipmap` references the
 * manifest holds for `android:label` and `android:icon` into their values. A release APK names its app by reference, so
 * without this the report pill reads `xyz.blueskyweb.app`.
 */

const RES_STRING_POOL = 0x0001;
const RES_TABLE = 0x0002;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE = 0x0201;
const TYPE_STRING = 0x03;
const FLAG_COMPLEX = 0x0001;
const FLAG_SPARSE = 0x01;
const NO_ENTRY = 0xffffffff;
const MAX_STRINGS = 500_000;

function readStringPool(bytes: Buffer, offset: number): string[] {
  const count = bytes.readUInt32LE(offset + 8), flags = bytes.readUInt32LE(offset + 16), stringsStart = bytes.readUInt32LE(offset + 20);
  if (count > MAX_STRINGS) throw new Error("string pool too large");
  const utf8 = (flags & (1 << 8)) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    let at = offset + stringsStart + bytes.readUInt32LE(offset + 28 + i * 4);
    if (utf8) {
      const length = (position: number) => { const first = bytes[position]!; return first & 0x80 ? { value: ((first & 0x7f) << 8) | bytes[position + 1]!, size: 2 } : { value: first, size: 1 }; };
      at += length(at).size;
      const encoded = length(at); at += encoded.size;
      strings.push(bytes.subarray(at, at + encoded.value).toString("utf8"));
    } else {
      let length = bytes.readUInt16LE(at); at += 2;
      if (length & 0x8000) { length = ((length & 0x7fff) << 16) | bytes.readUInt16LE(at); at += 2; }
      strings.push(bytes.subarray(at, at + length * 2).toString("utf16le"));
    }
  }
  return strings;
}

/**
 * Every string value the table holds for a resource id, one per configuration (densities for an icon, locales for a
 * label), in table order; the default configuration comes first in practice. Empty when the id is not a string resource.
 * A malformed table yields nothing rather than throwing: the caller has a fallback either way.
 */
export function resolveResourceStrings(bytes: Buffer, resourceId: number): string[] {
  const values: string[] = [];
  try {
    if (bytes.length < 12 || bytes.readUInt16LE(0) !== RES_TABLE) return values;
    const packageId = (resourceId >>> 24) & 0xff, typeId = (resourceId >>> 16) & 0xff, entryIndex = resourceId & 0xffff;
    let pool: string[] | undefined;
    let offset = bytes.readUInt16LE(2);
    while (offset + 8 <= bytes.length) {
      const chunkType = bytes.readUInt16LE(offset), headerSize = bytes.readUInt16LE(offset + 2), chunkSize = bytes.readUInt32LE(offset + 4);
      if (chunkSize < 8 || headerSize > chunkSize || offset + chunkSize > bytes.length) break;
      if (chunkType === RES_STRING_POOL && !pool) pool = readStringPool(bytes, offset);
      else if (chunkType === RES_TABLE_PACKAGE && pool && bytes.readUInt32LE(offset + 8) === packageId) {
        let at = offset + headerSize;
        while (at + 8 <= offset + chunkSize) {
          const type = bytes.readUInt16LE(at), size = bytes.readUInt16LE(at + 2), length = bytes.readUInt32LE(at + 4);
          if (length < 8 || size > length || at + length > offset + chunkSize) break;
          if (type === RES_TABLE_TYPE && bytes[at + 8] === typeId) {
            const flags = bytes[at + 9]!, entryCount = bytes.readUInt32LE(at + 12), entriesStart = bytes.readUInt32LE(at + 16);
            let entryOffset: number | undefined;
            if (flags & FLAG_SPARSE) {
              for (let i = 0; i < entryCount; i++) {
                const index = bytes.readUInt16LE(at + size + i * 4);
                if (index === entryIndex) { entryOffset = bytes.readUInt16LE(at + size + i * 4 + 2) * 4; break; }
              }
            } else if (entryIndex < entryCount) {
              const raw = bytes.readUInt32LE(at + size + entryIndex * 4);
              entryOffset = raw === NO_ENTRY ? undefined : raw;
            }
            if (entryOffset !== undefined) {
              const entry = at + entriesStart + entryOffset;
              if (entry + 16 <= at + length && !(bytes.readUInt16LE(entry + 2) & FLAG_COMPLEX) && bytes[entry + 11] === TYPE_STRING) {
                const value = pool[bytes.readUInt32LE(entry + 12)];
                if (value !== undefined) values.push(value);
              }
            }
          }
          at += length;
        }
      }
      offset += chunkSize;
    }
  } catch { /* a hostile or truncated table resolves to nothing */ }
  return values;
}
