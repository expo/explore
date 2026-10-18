// The README's two animated SVGs, written by readme-screenshots.mjs. Each is a plain image: CSS keyframes on one loop,
// every picture inlined as a JPEG data URI (an SVG shown with <img> loads nothing), and with prefers-reduced-motion
// it shows its last frame, which is also what a viewer that does not animate SVG shows.
//
//   readme-hero    the Viewer's Map, built from real Viewer frames: the screens appear row by row, the transitions
//                  wipe in from the top, then a click selects a screen and the Inspector slides in
//   readme-compare one modified screen wiping from its base capture to its head capture, the changed regions pulsing
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

/** The soft stage the PR comment picture sits on too (stagedComment in readme-screenshots.mjs), and its accents. */
const STAGE = {
  light: { stage: "#F6F8FA", border: "#D1D9E0", shadow: "rgba(17,17,17,0.14)", text: "#1F2328", muted: "#59636E", accent: "#0969DA", region: "#D4520F" },
  dark: { stage: "#151B23", border: "#3D444D", shadow: "rgba(1,4,9,0.6)", text: "#F0F6FC", muted: "#9198A1", accent: "#4493F8", region: "#F0883E" },
};
const FONT = "-apple-system, BlinkMacSystemFont, &apos;Segoe UI&apos;, &apos;Noto Sans&apos;, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, &apos;SF Mono&apos;, Menlo, Consolas, monospace";
const JPEG_QUALITY = 82;

const dataUri = jpeg => `data:image/jpeg;base64,${jpeg.toString("base64")}`;
const escapeXml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const box = ({ x, y, width, height }) => `x="${x}" y="${y}" width="${width}" height="${height}"`;

/** Keyframes given in seconds on a shared loop, so every element stays in step. */
function keyframes(name, loop, frames) {
  return `@keyframes ${name}{${frames.map(([at, css]) => `${((at / loop) * 100).toFixed(2)}%{${css}}`).join("")}}`;
}

/**
 * Photographs the hero's states from a Viewer page whose Map has its camera set and nothing selected: the Map without
 * its screens, without its edges, and whole; then it clicks `select`, which opens the Inspector without moving the
 * camera, and photographs that. Returns the frames and where each screen card, the Inspector and the selected card are.
 */
export async function captureHeroFrames(page, { select, viewport }) {
  const shoot = () => page.screenshot({ type: "jpeg", quality: JPEG_QUALITY });
  const neutral = () => page.mouse.move(viewport.width - 4, viewport.height - 4);
  const rect = locator => locator.boundingBox().then(b => b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  const camera = () => page.locator(".react-flow__viewport").evaluate(el => el.style.transform);
  const target = page.locator(`.screen-screenshot-target[title="${select}"]`);

  // A card under the pointer dims the others and highlights its edges; let that fade before the first frame.
  await neutral();
  await page.waitForTimeout(1000);
  const at = await camera();
  const selected = await rect(target);
  if (!selected) throw new Error(`The hero needs ${select} on the Map.`);
  const cards = [];
  for (const node of await page.locator(".react-flow__node").all()) {
    const b = await rect(node);
    if (b && b.x < viewport.width && b.y < viewport.height && b.x + b.width > 0 && b.y + b.height > 0) cards.push(b);
  }
  const full = await shoot();
  const hide = async css => {
    const style = await page.addStyleTag({ content: `${css} { visibility: hidden !important; }` });
    await page.waitForTimeout(300);
    return style;
  };
  const edges = await hide(".react-flow__edges, .react-flow__edge, .react-flow__edgelabel-renderer");
  const screensOnly = await shoot();
  const nodes = await hide(".react-flow__node");
  const empty = await shoot();
  for (const style of [edges, nodes]) await style.evaluate(el => el.remove());

  await target.click();
  await neutral();
  await page.waitForTimeout(1500);
  const inspector = await rect(page.locator("aside.right-panel"));
  if (!inspector) throw new Error(`Selecting ${select} did not open the Inspector.`);
  if ((await camera()) !== at) throw new Error(`The Map's camera moved when ${select} was selected: ${at} → ${await camera()}.`);
  const inspecting = await shoot();
  return { viewport, empty, screensOnly, full, inspecting, cards, selected, inspector };
}

/**
 * The hero: the frames from captureHeroFrames as a window on a rounded 1600×900 stage. Each screen
 * card is a clip of the screens-only frame, so what appears is exactly what the Viewer draws.
 */
export function heroSvg(frames, theme, alt) {
  const t = STAGE[theme];
  const LOOP = 12;
  const W = 1600, H = 900;
  const { viewport: v } = frames;
  const wx = (W - v.width) / 2, wy = (H - v.height) / 2;
  const css = [];
  const defs = [];
  const layers = [];
  const image = (id, jpeg) => defs.push(`<image id="${id}" width="${v.width}" height="${v.height}" href="${dataUri(jpeg)}"/>`);
  image("empty", frames.empty);
  image("screens", frames.screensOnly);
  image("full", frames.full);
  image("inspecting", frames.inspecting);

  // Cards appear a row at a time, top to bottom, as the Map lays out taps from launch; a row's cards left to right.
  const PAD = 18;
  const rows = [...new Set(frames.cards.map(c => c.y))].sort((a, b) => a - b);
  frames.cards.forEach((card, i) => {
    const appear = 0.4 + rows.indexOf(card.y) * 0.35 + (card.x / v.width) * 0.3;
    const clip = { x: card.x - PAD, y: card.y - PAD, width: card.width + PAD * 2, height: card.height + PAD * 2 };
    defs.push(`<clipPath id="c${i}"><rect ${box(clip)}/></clipPath>`);
    css.push(`.c${i}{transform-origin:0 0;animation:c${i} ${LOOP}s cubic-bezier(.2,.8,.2,1) infinite}`);
    css.push(keyframes(`c${i}`, LOOP, [[0, "opacity:0;transform:scale(.92)"], [appear, "opacity:0;transform:scale(.92)"], [appear + 0.45, "opacity:1;transform:scale(1)"], [LOOP, "opacity:1;transform:scale(1)"]]));
    // Scaled about the card's centre: the class sits on a group whose origin is there.
    const cx = card.x + card.width / 2, cy = card.y + card.height / 2;
    layers.push(`<g transform="translate(${cx} ${cy})"><g class="c${i}"><g transform="translate(${-cx} ${-cy})" clip-path="url(#c${i})"><use href="#screens"/></g></g></g>`);
  });
  const settled = 0.4 + (rows.length - 1) * 0.35 + 0.75;

  // The transitions wipe in from the top: the full frame over the cards, which it draws in the same places.
  const EDGES = settled - 0.2, EDGES_END = EDGES + 1.3;
  css.push(`.full{animation:full ${LOOP}s cubic-bezier(.45,0,.25,1) infinite}`);
  css.push(keyframes("full", LOOP, [[0, "clip-path:inset(0 0 100% 0)"], [EDGES, "clip-path:inset(0 0 100% 0)"], [EDGES_END, "clip-path:inset(0 0 0 0)"], [LOOP, "clip-path:inset(0 0 0 0)"]]));
  layers.push(`<use class="full" href="#full"/>`);

  // A pointer glides to the selected card and clicks; the selection lands and the Inspector slides in.
  const { selected: s, inspector: p } = frames;
  const target = { x: s.x + s.width * 0.55, y: s.y + s.height * 0.45 };
  const start = { x: Math.min(v.width - 120, target.x + 260), y: Math.min(v.height - 60, target.y + 220) };
  const MOVE = EDGES_END + 0.5, CLICK = MOVE + 1.2;
  const pointer = (x, y, extra = "") => `transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px)${extra}`;
  css.push(`.ptr{opacity:0;animation:ptr ${LOOP}s cubic-bezier(.4,0,.2,1) infinite}`);
  css.push(keyframes("ptr", LOOP, [
    [0, `opacity:0;${pointer(start.x, start.y)}`], [MOVE, `opacity:0;${pointer(start.x, start.y)}`], [MOVE + 0.2, `opacity:1;${pointer(start.x, start.y)}`],
    [CLICK, `opacity:1;${pointer(target.x, target.y)}`], [CLICK + 0.1, `opacity:1;${pointer(target.x, target.y, " scale(.82)")}`],
    [CLICK + 0.25, `opacity:1;${pointer(target.x, target.y)}`], [CLICK + 1.2, `opacity:0;${pointer(target.x, target.y)}`], [LOOP, `opacity:0;${pointer(target.x, target.y)}`],
  ]));
  defs.push(`<clipPath id="canvas"><rect x="0" y="0" width="${p.x}" height="${v.height}"/></clipPath>`);
  defs.push(`<clipPath id="panel"><rect ${box(p)}/></clipPath>`);
  css.push(`.sel{animation:sel ${LOOP}s ease-out infinite}`);
  css.push(keyframes("sel", LOOP, [[0, "opacity:0"], [CLICK + 0.1, "opacity:0"], [CLICK + 0.4, "opacity:1"], [LOOP, "opacity:1"]]));
  css.push(`.insp{animation:insp ${LOOP}s cubic-bezier(.2,.8,.2,1) infinite}`);
  css.push(keyframes("insp", LOOP, [[0, "opacity:0;transform:translateX(48px)"], [CLICK + 0.15, "opacity:0;transform:translateX(48px)"], [CLICK + 0.75, "opacity:1;transform:translateX(0)"], [LOOP, "opacity:1;transform:translateX(0)"]]));
  layers.push(`<use class="sel" href="#inspecting" clip-path="url(#canvas)"/>`);
  layers.push(`<g class="insp"><use href="#inspecting" clip-path="url(#panel)"/></g>`);
  layers.push(`<g class="ptr"><path d="M0 0L0 22L6 16.5L10.5 26L14 24.5L9.8 15.2L18 15.2Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></g>`);

  // The empty Map covers the reset: it fades in over the last frame, and the loop starts again beneath it.
  css.push(`.cover{opacity:0;animation:cover ${LOOP}s linear infinite}`);
  css.push(keyframes("cover", LOOP, [[0, "opacity:1"], [0.2, "opacity:0"], [LOOP - 0.7, "opacity:0"], [LOOP, "opacity:1"]]));
  layers.push(`<use class="cover" href="#empty"/>`);

  css.push("@media (prefers-reduced-motion: reduce){*{animation:none!important}}");
  defs.push(`<clipPath id="window"><rect width="${v.width}" height="${v.height}" rx="14"/></clipPath>`);
  defs.push(`<filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="${t.shadow}" flood-opacity=".3"/><feDropShadow dx="0" dy="30" stdDeviation="35" flood-color="${t.shadow}"/></filter>`);
  defs.push(`<clipPath id="stage"><rect width="${W}" height="${H}" rx="22"/></clipPath>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(alt)}">`
    + `<style>${css.join("")}</style><defs>${defs.join("")}</defs>`
    + `<g clip-path="url(#stage)"><rect width="${W}" height="${H}" fill="${t.stage}"/>`
    + `<rect x="${wx}" y="${wy}" width="${v.width}" height="${v.height}" rx="14" fill="${t.stage}" filter="url(#shadow)"/>`
    + `<g transform="translate(${wx} ${wy})"><g clip-path="url(#window)"><use href="#empty"/>${layers.join("")}</g>`
    + `<rect x=".5" y=".5" width="${v.width - 1}" height="${v.height - 1}" rx="14" fill="none" stroke="${t.border}"/></g></g></svg>`;
}

/** review.json and an asset reader from a sealed review report's bytes. */
export async function openReport(bytes) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)));
  const entries = new Map((await reader.getEntries()).map(entry => [entry.filename, entry]));
  const read = async name => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`The report has no ${name}.`);
    return Buffer.from(await entry.getData(new Uint8ArrayWriter()));
  };
  const review = JSON.parse((await read("review.json")).toString("utf8")).review;
  return { review, asset: sha => read(`assets/${sha}.png`) };
}

/** A PNG as a JPEG at most `maxHeight` tall, drawn by the browser so the script needs no image library. */
async function toJpeg(browser, png, maxHeight) {
  const page = await browser.newPage();
  try {
    const base64 = await page.evaluate(async ({ png, maxHeight, quality }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const scale = Math.min(1, maxHeight / bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality).split(",")[1];
    }, { png: png.toString("base64"), maxHeight, quality: JPEG_QUALITY / 100 });
    return Buffer.from(base64, "base64");
  } finally {
    await page.close();
  }
}

/**
 * The surface of the Compare key `key` (the slug of the Viewer's #/compare/<key>, which is the route without its
 * slash) in `theme`, among the report's visually modified screens.
 */
export function compareSurface(review, key, theme) {
  const route = `/${key}`;
  const surface = review.surfaces.find(s => (s.head ?? s.base)?.route === route && s.colorScheme === theme && s.visual?.verdict === "modified");
  if (!surface) throw new Error(`No visually modified ${route} in ${theme} in this report; pass --compare <key> from a #/compare/<key> URL.`);
  return surface;
}

/** The Compare picture: `surface`'s base capture wiping to its head capture, its changed regions outlined. */
export async function compareSvg(browser, report, surface, theme, alt) {
  const t = STAGE[theme];
  const LOOP = 7;
  const W = 1000, H = 600;
  const { baseImage, headImage } = surface;
  const PH = 540, PW = Math.round(PH * headImage.width / headImage.height);
  const x = (W - PW) / 2, y = (H - PH) / 2;
  const k = PW / headImage.width;
  const before = dataUri(await toJpeg(browser, await report.asset(baseImage.sha256), PH * 2));
  const after = dataUri(await toJpeg(browser, await report.asset(headImage.sha256), PH * 2));
  const { pullRequest } = report.review;
  const css = [];
  // The After capture is revealed left to right, and the divider rides the edge of the reveal.
  css.push(`.after{animation:wipe ${LOOP}s cubic-bezier(.65,0,.35,1) infinite}`);
  css.push(keyframes("wipe", LOOP, [[0, "clip-path:inset(0 100% 0 0)"], [1.0, "clip-path:inset(0 100% 0 0)"], [2.6, "clip-path:inset(0 0 0 0)"], [5.8, "clip-path:inset(0 0 0 0)"], [6.8, "clip-path:inset(0 100% 0 0)"], [LOOP, "clip-path:inset(0 100% 0 0)"]]));
  css.push(`.divider{opacity:0;animation:divider ${LOOP}s cubic-bezier(.65,0,.35,1) infinite}`);
  css.push(keyframes("divider", LOOP, [[0, "transform:translateX(0);opacity:0"], [0.8, "transform:translateX(0);opacity:1"], [1.0, "transform:translateX(0);opacity:1"], [2.6, `transform:translateX(${PW}px);opacity:1`], [2.9, `transform:translateX(${PW}px);opacity:0`], [5.8, `transform:translateX(${PW}px);opacity:0`], [6.0, `transform:translateX(${PW}px);opacity:1`], [6.8, "transform:translateX(0);opacity:1"], [LOOP, "transform:translateX(0);opacity:0"]]));
  css.push(`.regions{animation:regions ${LOOP}s ease-in-out infinite}`);
  css.push(keyframes("regions", LOOP, [[0, "opacity:0"], [2.7, "opacity:0"], [3.1, "opacity:1"], [3.6, "opacity:.3"], [4.1, "opacity:1"], [5.7, "opacity:1"], [6.0, "opacity:0"], [LOOP, "opacity:0"]]));
  css.push(`.before-label{opacity:.3;animation:before-label ${LOOP}s linear infinite}.after-label{animation:after-label ${LOOP}s linear infinite}`);
  css.push(keyframes("before-label", LOOP, [[0, "opacity:1"], [1.8, "opacity:1"], [2.0, "opacity:.3"], [6.2, "opacity:.3"], [6.4, "opacity:1"], [LOOP, "opacity:1"]]));
  css.push(keyframes("after-label", LOOP, [[0, "opacity:.3"], [1.8, "opacity:.3"], [2.0, "opacity:1"], [6.2, "opacity:1"], [6.4, "opacity:.3"], [LOOP, "opacity:.3"]]));
  css.push("@media (prefers-reduced-motion: reduce){*{animation:none!important}}");
  const regions = surface.visual.regions.map(({ rect: r }) =>
    `<rect x="${(x + r.x * k - 3).toFixed(1)}" y="${(y + r.y * k - 3).toFixed(1)}" width="${(r.width * k + 6).toFixed(1)}" height="${(r.height * k + 6).toFixed(1)}" rx="3" fill="none" stroke="${t.region}" stroke-width="2"/>`).join("");
  const label = (cls, anchor, lx, title, sub, note) => `<g class="${cls}" font-family="${FONT}" text-anchor="${anchor}">`
    + `<text x="${lx}" y="${y + PH / 2 - 14}" font-size="26" font-weight="700" fill="${t.text}">${title}</text>`
    + `<text x="${lx}" y="${y + PH / 2 + 12}" font-family="${MONO}" font-size="13" fill="${t.muted}">${escapeXml(sub)}</text>`
    + (note ? `<text x="${lx}" y="${y + PH / 2 + 36}" font-size="13" font-weight="600" fill="${t.region}">${note}</text>` : "") + "</g>";
  const count = surface.visual.regions.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(alt)}">`
    + `<style>${css.join("")}</style>`
    + `<defs><clipPath id="stage"><rect width="${W}" height="${H}" rx="16"/></clipPath><clipPath id="phone"><rect x="${x}" y="${y}" width="${PW}" height="${PH}" rx="40"/></clipPath>`
    + `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="${t.shadow}"/></filter></defs>`
    + `<g clip-path="url(#stage)"><rect width="${W}" height="${H}" fill="${t.stage}"/>`
    + `<rect x="${x}" y="${y}" width="${PW}" height="${PH}" rx="40" fill="${t.stage}" filter="url(#shadow)"/>`
    + `<g clip-path="url(#phone)"><image href="${before}" x="${x}" y="${y}" width="${PW}" height="${PH}"/>`
    + `<image class="after" href="${after}" x="${x}" y="${y}" width="${PW}" height="${PH}"/></g>`
    + `<rect x="${x}" y="${y}" width="${PW}" height="${PH}" rx="40" fill="none" stroke="${t.border}"/>`
    + `<g class="divider"><rect x="${x - 1.5}" y="${y}" width="3" height="${PH}" fill="${t.accent}"/><circle cx="${x}" cy="${y + PH / 2}" r="13" fill="${t.accent}"/>`
    + `<path d="M${x - 5} ${y + PH / 2 - 4}l-3 4l3 4M${x + 5} ${y + PH / 2 - 4}l3 4l-3 4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`
    + `<g class="regions">${regions}</g>`
    + label("before-label", "end", x - 44, "Before", `${pullRequest.base.ref} ·${pullRequest.base.sha.slice(0, 7)}`)
    + label("after-label", "start", x + PW + 44, "After", `PR #${pullRequest.number} · ${pullRequest.head.sha.slice(0, 7)}`, `${count} changed region${count === 1 ? "" : "s"}`)
    + "</g></svg>";
}
