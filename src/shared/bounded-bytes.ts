/** Read a response body with a hard byte ceiling, cancelling the stream once it is exceeded. */
export async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("Empty response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) throw new Error("Response exceeds the size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
