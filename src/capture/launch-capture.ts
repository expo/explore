import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { statusBarBandPercent, type BundleLaunchCapture, type LaunchFrame } from "../contracts/capture.js";
import { assertDecodedPng } from "../shared/png-evidence.js";
import { controllerData } from "./controller.js";

/** `screenshot` observes the launch and keeps its frames; `video` also keeps the recording; `off` skips it. */
export type LaunchSetting = "screenshot" | "video" | "off";
export const LAUNCH_SETTINGS: readonly LaunchSetting[] = ["screenshot", "video", "off"];

export function parseLaunchSetting(value: unknown, path: string): LaunchSetting {
  if (value === undefined) return "screenshot";
  if (!LAUNCH_SETTINGS.includes(value as LaunchSetting)) throw new Error(`${path} must be "screenshot", "video", or "off".`);
  return value as LaunchSetting;
}

/** Bundle directory that holds one appearance's launch evidence. */
export function launchDirectory(scheme: string): string {
  return `launch/${scheme}`;
}

/** The recording is sampled at this rate; a frame span shorter than the minimum is a transition, not a splash. */
export const LAUNCH_FRAME_MS = 100;
export const MIN_SPLASH_MS = 700;
/** The splash counts as steady once it held without a visible change for this many frames; anything shorter is its entry animation. */
const STEADY_SPLASH_FRAMES = 3;
/** A screen held this briefly before the first screen is a step of the crossfade, not a screen of its own. */
const TRANSITION_MAX_FRAMES = 2;
const MAX_BURST_FRAMES = 12;
const BURST_BUDGET_MS = 20_000;
const BURST_UNCHANGED_MS = 8_000;

/**
 * Frames sampled from a lossy recording never match exactly, so each is reduced to a grayscale thumbnail. Two frames
 * count as the same screen while few pixels moved by more than the compression noise: the status bar clock or a
 * one-frame brightness flicker stays under that share, a launch transition or the splash crossfade is far above it.
 * Within one screen a far smaller change still counts as the screen changing: a home indicator appearing or a few
 * cells lighting up moves about 0.2% of the pixels by well over the noise, while a static frame re-encoded moves none.
 * The status bar band is left out of that finer comparison because its clock ticks.
 */
export const THUMB_WIDTH = 108;
export const THUMB_HEIGHT = 192;
const PIXEL_NOISE = 16;
const SAME_SCREEN_MAX_CHANGED_PERCENT = 5;
const CHANGE_PIXEL_NOISE = 24;
const UNCHANGED_MAX_CHANGED_PERCENT = 0.1;
/** Two lossless screenshots show the same screen while, below the status bar, almost no pixels differ (the clock may tick between them). */
const SCREENSHOT_SAME_MAX_CHANGED_PERCENT = 1;

export type GrayFrame = Buffer;

/** Split raw grayscale video into one thumbnail per sampled frame. */
export function grayFrames(raw: Buffer, width = THUMB_WIDTH, height = THUMB_HEIGHT): GrayFrame[] {
  const size = width * height;
  const frames: GrayFrame[] = [];
  for (let offset = 0; offset + size <= raw.length; offset += size) frames.push(raw.subarray(offset, offset + size));
  return frames;
}

/** The share of pixels (from `from` on) that differ between two thumbnails by more than `noise`. */
export function changedPercent(a: GrayFrame, b: GrayFrame, noise = PIXEL_NOISE, from = 0): number {
  let changed = 0;
  for (let pixel = from; pixel < a.length; pixel += 1) if (Math.abs(a[pixel]! - b[pixel]!) > noise) changed += 1;
  return a.length > from ? (changed * 100) / (a.length - from) : 0;
}

const sameScreen = (a: GrayFrame, b: GrayFrame) => changedPercent(a, b) <= SAME_SCREEN_MAX_CHANGED_PERCENT;

export type LaunchDetection = {
  /** The last frame of the recording's final stable screen, and where that screen first appeared. */
  settled: { index: number; start: number };
  /** The first frame that differs from what was on screen before the relaunch: the system launch transition begins. */
  launchStart?: number;
  /**
   * The splash: a stable screen that is neither the pre-launch state nor the first screen, held at least MIN_SPLASH_MS.
   * `steady` is the run of frames in it without any visible change (absent when it animated throughout), `changed`
   * the first frame that visibly altered it (absent when it left unchanged), and `index` the frame to keep as its image.
   */
  splash?: { start: number; end: number; index: number; frames: number; steady?: { start: number; end: number }; changed?: number };
  /** From the launch transition to the first settled frame. */
  firstScreenMs?: number;
};

export type LaunchDetectionOptions = {
  frameMs?: number;
  /** Thumbnail width; the height follows from the frame size. */
  width?: number;
  /** The top share of each frame to leave out of the within-screen comparison (the status bar). */
  statusBarPercent?: number;
};

/**
 * Where the launch sits in a relaunch recording. The recording shows the previous app state, the launcher, the system
 * launch transition, the splash, and finally the settled first screen. Working backwards from the end: the settled
 * screen is the final run of frames that match the last one; the splash is the screen held just before the transition
 * into it, extended over every earlier frame that still matches it (a one-frame flicker or a status bar change does
 * not end it). Both the launcher pause behind the launch animation and a fast launch leave no splash long enough.
 * Inside the splash, the finer comparison finds how long it stayed exactly as it appeared and the first frame that
 * changed it: a native launch screen handing over to an app-drawn one or an animation starting on it.
 */
export function detectLaunch(frames: readonly GrayFrame[], options: LaunchDetectionOptions = {}): LaunchDetection | undefined {
  if (!frames.length) return undefined;
  const frameMs = options.frameMs ?? LAUNCH_FRAME_MS;
  const last = frames.at(-1)!;
  let settledStart = frames.length - 1;
  while (settledStart > 0 && sameScreen(frames[settledStart - 1]!, last)) settledStart -= 1;
  const result: LaunchDetection = { settled: { index: frames.length - 1, start: settledStart } };
  const first = frames[0]!;
  const launchStart = frames.findIndex(frame => !sameScreen(frame, first));
  if (launchStart > 0 && launchStart <= settledStart) {
    result.launchStart = launchStart;
    result.firstScreenMs = (settledStart - launchStart) * frameMs;
  }
  // Where the screen shown at `index` first appeared, allowing a single-frame flicker inside the run.
  const runStart = (index: number): number => {
    let start = index;
    while (start > 0) {
      if (sameScreen(frames[start - 1]!, frames[index]!)) start -= 1;
      else if (start > 1 && sameScreen(frames[start - 2]!, frames[index]!)) start -= 2;
      else break;
    }
    return start;
  };
  // The transition into the first screen: frames before the settled run that match neither neighbour screen, including
  // a crossfade that pauses on one or two frames. A screen held longer than that is a screen of its own, and when it is
  // too short to be a splash there is none: the launcher pause before it must not be taken for one.
  let anchor = settledStart - 1;
  let start = anchor;
  while (anchor > 0) {
    start = runStart(anchor);
    if (anchor - start + 1 > TRANSITION_MAX_FRAMES) break;
    anchor = start - 1;
  }
  if (anchor <= 0 || sameScreen(frames[anchor]!, last) || sameScreen(frames[anchor]!, first)) return result;
  const spanFrames = anchor - start + 1;
  if (start === 0 || spanFrames * frameMs < MIN_SPLASH_MS) return result;
  const { steady, changed } = steadySpan(frames, start, anchor, options);
  const shown = steady ?? { start, end: anchor };
  result.splash = { start, end: anchor, index: shown.start + Math.floor((shown.end - shown.start) / 2), frames: spanFrames,
    ...(steady ? { steady } : {}), ...(changed !== undefined ? { changed } : {}) };
  return result;
}

/** The frames of a splash span during which nothing visible changed, and the first frame that persistently changed it. */
function steadySpan(frames: readonly GrayFrame[], start: number, end: number, options: LaunchDetectionOptions): { steady?: { start: number; end: number }; changed?: number } {
  const width = options.width ?? THUMB_WIDTH;
  const masked = Math.round((frames[0]!.length / width) * ((options.statusBarPercent ?? 0) / 100)) * width;
  const unchanged = (a: GrayFrame, b: GrayFrame) => changedPercent(a, b, CHANGE_PIXEL_NOISE, masked) <= UNCHANGED_MAX_CHANGED_PERCENT;
  const steadyFrom = (index: number) => frames.slice(index + 1, index + STEADY_SPLASH_FRAMES).every(frame => unchanged(frames[index]!, frame));
  let steadyStart = start;
  while (steadyStart + STEADY_SPLASH_FRAMES - 1 <= end && !steadyFrom(steadyStart)) steadyStart += 1;
  if (steadyStart + STEADY_SPLASH_FRAMES - 1 > end) return {};
  const reference = frames[steadyStart]!;
  for (let index = steadyStart + 1; index <= end; index += 1) {
    // A change must outlast one frame: a single-frame encoder artefact does not end the steady run.
    if (!unchanged(reference, frames[index]!) && (index === end || !unchanged(reference, frames[index + 1]!))) {
      return { steady: { start: steadyStart, end: index - 1 }, changed: index };
    }
  }
  return { steady: { start: steadyStart, end } };
}

export type LaunchController = (args: string[], options?: { allowFailure?: boolean; timeoutMs?: number }) => { stdout: string };

/** Decoding a launch recording; absent when no decoder is available, so the capture falls back to its screenshots. */
export type RecordingTools = {
  /** One grayscale THUMB_WIDTH x THUMB_HEIGHT thumbnail per frame, sampled every LAUNCH_FRAME_MS. */
  frames(recording: string): Promise<GrayFrame[]>;
  extractFrame(recording: string, seconds: number, width: number, height: number, output: string): Promise<void>;
  /** Rewrite a retained recording in place as browser-playable H.264 (simulators record HEVC, which no browser demuxes), cut to the given window. */
  normalize?(recording: string, window?: { startMs: number; endMs: number }): Promise<void>;
  /** One PNG row of the sampled frames at the given indices, each labelled with its time relative to `originMs`. */
  filmstrip?(recording: string, indices: readonly number[], originMs: number, output: string): Promise<void>;
};

export function ffmpegRecordingTools(command = "ffmpeg"): RecordingTools | undefined {
  const probe = spawnSync(command, ["-version"], { encoding: "utf8", timeout: 10_000 });
  if (probe.error || probe.status !== 0) return undefined;
  function run(args: string[]): string;
  function run(args: string[], encoding: "buffer"): Buffer;
  function run(args: string[], encoding?: "buffer"): string | Buffer {
    const result = spawnSync(command, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], { encoding: encoding ?? "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ffmpeg ${args[0] === "-i" ? "decode" : "extract"} failed: ${String(result.stderr).trim().split("\n").at(-1) ?? ""}`);
    return result.stdout;
  }
  return {
    async frames(recording) {
      const output = run(["-i", recording, "-vf", `fps=${1000 / LAUNCH_FRAME_MS},scale=${THUMB_WIDTH}:${THUMB_HEIGHT},format=gray`, "-f", "rawvideo", "-"], "buffer");
      return grayFrames(output);
    },
    async extractFrame(recording, seconds, width, height, output) {
      run(["-ss", seconds.toFixed(3), "-i", recording, "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-y", output]);
    },
    async normalize(recording, window) {
      const output = `${recording}.h264.mp4`;
      run(["-i", recording, ...(window ? ["-ss", (window.startMs / 1000).toFixed(3), "-to", (window.endMs / 1000).toFixed(3)] : []), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", output]);
      await rename(output, recording);
    },
    async filmstrip(recording, indices, originMs, output) {
      const select = indices.map(index => `eq(n\\,${index})`).join("+");
      // Each tile gets a caption band under the frame so the label never covers the status bar or the splash.
      const band = `pad=iw:ih+${FILMSTRIP_CAPTION_HEIGHT}:0:0:color=${FILMSTRIP_BACKGROUND}`;
      const label = `drawtext=text='%{eif\\:(t*1000-${Math.round(originMs)})\\:d} ms':x=(w-text_w)/2:y=h-${FILMSTRIP_CAPTION_HEIGHT}+11:fontsize=20:fontcolor=0xd0d0d6`;
      const filter = (labelled: boolean) =>
        `fps=${1000 / LAUNCH_FRAME_MS},select='${select}',scale=-2:${FILMSTRIP_TILE_HEIGHT},${labelled ? `${band},${label},` : ""}tile=${indices.length}x1:padding=6:color=${FILMSTRIP_BACKGROUND}`;
      // Selected frames must not be duplicated into a constant rate: `-fps_mode` since ffmpeg 5.1, `-vsync` before it (removed later).
      // drawtext needs a libfreetype build; the strip is still useful without the labels.
      const attempts = [true, false].flatMap(labelled => [["-fps_mode", "vfr"], ["-vsync", "vfr"]].map(rate => ({ labelled, rate })));
      for (const [index, { labelled, rate }] of attempts.entries()) {
        try {
          run(["-i", recording, "-vf", filter(labelled), "-frames:v", "1", ...rate, "-y", output]);
          return;
        } catch (error) {
          if (index === attempts.length - 1) throw error;
        }
      }
    },
  };
}

const FILMSTRIP_TILE_HEIGHT = 480;
const FILMSTRIP_CAPTION_HEIGHT = 40;
const FILMSTRIP_BACKGROUND = "0x1b1b1f";

/**
 * The frames worth a glance: what was on screen before the launch, the start of the system transition, the splash as
 * it appeared, the first frame that changed it, the splash just before it left, the crossfade into the app, and the
 * first settled frame.
 */
export function filmstripIndices(detected: LaunchDetection, frameCount: number): number[] {
  const picks = [0, detected.launchStart, detected.splash?.start, detected.splash?.changed, detected.splash?.end];
  const lastBeforeSettled = detected.splash?.end ?? detected.launchStart ?? 0;
  if (detected.settled.start - lastBeforeSettled >= 2) picks.push(Math.floor((lastBeforeSettled + detected.settled.start) / 2));
  picks.push(detected.settled.start);
  return [...new Set(picks.filter((index): index is number => index !== undefined && index >= 0 && index < frameCount))].sort((a, b) => a - b);
}

export type LaunchCaptureOptions = {
  controller: LaunchController;
  bundleId: string;
  /** Absolute directory for this appearance's files and its bundle-relative path. */
  directory: string; relativeDirectory: string;
  keepVideo: boolean;
  /** Decides which top band of the frames holds the status bar; iOS when absent. */
  platform?: "ios" | "android";
  recordingTools?: RecordingTools;
  now?: () => number;
};

type DecodedPng = { width: number; height: number; data: Buffer };
function decodePng(png: Buffer): DecodedPng {
  const { PNG } = createRequire(import.meta.url.replace(/\?.*$/, ""))("pngjs") as { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedPng } } };
  return PNG.sync.read(png, { checkCRC: true });
}

async function frameRecord(path: string, relativePath: string, capturedAt: string): Promise<LaunchFrame> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 30 * 1024 * 1024) throw new Error("Launch capture did not produce a bounded regular PNG file.");
  const png = await readFile(path);
  assertDecodedPng(png, "Launch frame");
  return { path: relativePath, sha256: createHash("sha256").update(png).digest("hex"), width: png.readUInt32BE(16), height: png.readUInt32BE(20), capturedAt };
}

/**
 * Relaunch the app and observe its launch: a recording when the controller supports one, and a burst of screenshots
 * until the screen stops changing. The splash frame comes from the recording when it can be decoded, otherwise from
 * the first screenshot that shows neither what was on screen before the relaunch nor the settled first screen.
 */
export async function captureLaunch(options: LaunchCaptureOptions): Promise<BundleLaunchCapture> {
  const now = options.now ?? Date.now;
  const { controller, directory } = options;
  await mkdir(directory, { recursive: true });
  const recording = join(directory, "launch.mp4");
  let recorded = false;
  // A recorder left behind by an earlier session refuses the first start; stopping it frees the device for a retry.
  for (let attempt = 0; attempt < 2 && !recorded; attempt += 1) {
    try {
      controllerData(controller(["record", "start", recording, "--scope", "app", "--json"], { allowFailure: true }).stdout, "launch record start");
      recorded = true;
    } catch {
      if (attempt === 0) { try { controller(["record", "stop", "--json"], { allowFailure: true }); } catch { break; } }
    }
  }
  type Shot = { path: string; sha256: string; at: number; gray: GrayFrame; width: number; height: number };
  const screenshot = async (path: string): Promise<Shot> => {
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    controller(["screenshot", path, "--level", "full", "--json"]);
    const png = await readFile(path);
    assertDecodedPng(png, "Launch frame");
    const decoded = decodePng(png);
    const gray = Buffer.alloc(decoded.width * decoded.height);
    for (let pixel = 0; pixel < gray.length; pixel += 1) gray[pixel] = (decoded.data[pixel * 4]! * 299 + decoded.data[pixel * 4 + 1]! * 587 + decoded.data[pixel * 4 + 2]! * 114) / 1000;
    return { path, sha256: createHash("sha256").update(png).digest("hex"), at: now(), gray, width: decoded.width, height: decoded.height };
  };
  const statusBarPercent = statusBarBandPercent(options.platform);
  const sameScreenshot = (a: Shot, b: Shot) => a.width === b.width && a.height === b.height
    && changedPercent(a.gray, b.gray, PIXEL_NOISE, Math.round(a.height * (statusBarPercent / 100)) * a.width) <= SCREENSHOT_SAME_MAX_CHANGED_PERCENT;
  // The previous app state outlives `open --relaunch` for a moment; a screenshot of it tells those frames from the splash.
  const before = await screenshot(join(directory, "before.png"));
  await rm(before.path, { force: true });
  const relaunchedAt = now();
  controller(["open", options.bundleId, "--relaunch", "--level", "full", "--json"]);
  const frames: Shot[] = [];
  const last = () => frames.at(-1)!;
  for (;;) {
    frames.push(await screenshot(join(directory, `frame-${frames.length + 1}.png`)));
    const elapsed = now() - relaunchedAt;
    const stable = frames.length >= 2 && frames.at(-2)!.sha256 === last().sha256;
    // Settled: stable on a screen that is neither the previous app state nor the first new screen seen (the splash).
    const firstNew = frames.find(frame => !sameScreenshot(frame, before));
    const changed = firstNew !== undefined && !sameScreenshot(last(), before) && !sameScreenshot(last(), firstNew);
    if ((stable && (changed || elapsed >= BURST_UNCHANGED_MS)) || frames.length >= MAX_BURST_FRAMES || elapsed >= BURST_BUDGET_MS) break;
  }
  let sampled: GrayFrame[] | undefined;
  if (recorded) {
    try {
      controllerData(controller(["record", "stop", "--json"], { allowFailure: true }).stdout, "launch record stop");
      const info = await lstat(recording);
      if (!info.isFile() || info.size === 0) throw new Error("empty recording");
      sampled = await options.recordingTools?.frames(recording);
    } catch {
      recorded = false;
      sampled = undefined;
    }
  }
  const settledPath = join(directory, "settled.png");
  const settledShot = last();
  await rename(settledShot.path, settledPath);
  const settled = await frameRecord(settledPath, `${options.relativeDirectory}/settled.png`, new Date(last().at).toISOString());
  const splashPath = join(directory, "splash.png");
  let result: BundleLaunchCapture = { status: "not-observed", source: "screenshot", settled, relaunchedAt: new Date(relaunchedAt).toISOString() };
  const detected = sampled ? detectLaunch(sampled, { statusBarPercent: statusBarBandPercent(options.platform) }) : undefined;
  if (detected?.firstScreenMs !== undefined) result.firstScreenMs = detected.firstScreenMs;
  if (detected?.splash && options.recordingTools) {
    const { splash: span } = detected;
    await options.recordingTools.extractFrame(recording, span.index * LAUNCH_FRAME_MS / 1000, settled.width, settled.height, splashPath);
    const splash = await frameRecord(splashPath, `${options.relativeDirectory}/splash.png`, new Date(relaunchedAt).toISOString());
    const steadyFrames = span.steady ? span.steady.end - span.steady.start + 1 : span.frames;
    result = { ...result, status: "observed", source: "recording", splash, splashVisibleMs: steadyFrames * LAUNCH_FRAME_MS,
      ...(span.changed !== undefined && detected.launchStart !== undefined ? { splashChangedMs: (span.changed - detected.launchStart) * LAUNCH_FRAME_MS } : {}) };
  } else if (sampled) {
    result.source = "recording";
  } else {
    // Without a recording the splash is the first screenshot showing something new that did not stay as the first screen.
    const candidate = frames.find(frame => !sameScreenshot(frame, before) && !sameScreenshot(frame, settledShot));
    if (candidate) {
      await rename(candidate.path, splashPath);
      const splash = await frameRecord(splashPath, `${options.relativeDirectory}/splash.png`, new Date(candidate.at).toISOString());
      const lastSplashFrame = frames.filter(frame => sameScreenshot(frame, candidate)).at(-1)!;
      // A lower bound: on screen from the relaunch (when the first screenshot already showed it) or its first screenshot to its last.
      result = { ...result, status: "observed", splash, splashVisibleMs: Math.max(0, lastSplashFrame.at - (candidate === frames[0] ? relaunchedAt : candidate.at)) };
    }
  }
  for (const frame of frames) await rm(frame.path, { force: true });
  if (sampled && detected && options.recordingTools?.filmstrip) {
    const filmstripPath = join(directory, "filmstrip.png");
    const indices = filmstripIndices(detected, sampled.length);
    const originMs = (detected.launchStart ?? 0) * LAUNCH_FRAME_MS;
    try {
      await options.recordingTools.filmstrip(recording, indices, originMs, filmstripPath);
      const strip = await frameRecord(filmstripPath, `${options.relativeDirectory}/filmstrip.png`, new Date(relaunchedAt).toISOString());
      result.filmstrip = { ...strip, frameTimesMs: indices.map(index => index * LAUNCH_FRAME_MS - originMs) };
    } catch {
      await rm(filmstripPath, { force: true });
    }
  }
  if (recorded && options.keepVideo) {
    // Keep the launch itself: a moment before the transition through a second of the settled first screen.
    const window = sampled && detected?.launchStart !== undefined
      ? { startMs: Math.max(0, detected.launchStart - 3) * LAUNCH_FRAME_MS, endMs: Math.min(sampled.length, detected.settled.start + 10) * LAUNCH_FRAME_MS }
      : undefined;
    let trimmed = false;
    try {
      await options.recordingTools?.normalize?.(recording, window);
      trimmed = window !== undefined;
    } catch {
      await rm(`${recording}.h264.mp4`, { force: true });
    }
    const bytes = await readFile(recording);
    result.video = { path: `${options.relativeDirectory}/launch.mp4`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mimeType: "video/mp4",
      ...(trimmed && window ? { durationMs: window.endMs - window.startMs } : sampled ? { durationMs: sampled.length * LAUNCH_FRAME_MS } : {}) };
  } else await rm(recording, { force: true });
  return result;
}
