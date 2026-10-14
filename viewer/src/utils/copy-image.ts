/** Re-encode a JPEG or WebP screenshot as PNG; the clipboard image API accepts PNG only. */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error("PNG encoding failed")), "image/png");
    });
  } finally {
    bitmap.close();
  }
}

/** True when this browser can place an image on the clipboard. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copy an image URL (same-origin http(s), blob: or data:) to the clipboard as PNG.
 * The ClipboardItem receives a promise so Safari keeps the user-gesture permission while the
 * bytes download and re-encode.
 */
export async function copyImageToClipboard(src: string): Promise<void> {
  if (!canCopyImages()) throw new Error("Image copy is unavailable in this browser");
  const png = (async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Screenshot request failed: ${response.status}`);
    return toPngBlob(await response.blob());
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
