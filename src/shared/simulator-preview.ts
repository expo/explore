/** Hostname of a session's serve-sim server, as EAS names them. */
export const SIMULATOR_PREVIEW_HOST = /^web-preview-[0-9a-f]{16,64}\.eas-simulator\.ngrok\.dev$/;

/**
 * The serve-sim server an expo.dev preview page frames: `expo.dev/simulator-preview/<id>` frames
 * `web-preview-<id>.eas-simulator.ngrok.dev`. Undefined for any other URL, including a server named
 * directly, which is what sessions published before the page existed.
 */
export function framedSimulatorPreviewServer(preview: URL): string | undefined {
  if (preview.hostname !== "expo.dev") return undefined;
  const id = /^\/simulator-preview\/([0-9a-f]{16,64})\/?$/.exec(preview.pathname)?.[1];
  return id ? `https://web-preview-${id}.eas-simulator.ngrok.dev/` : undefined;
}
