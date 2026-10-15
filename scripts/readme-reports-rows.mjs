// Renders `expo-explore reports` over the saved runs in $EXPLORE_CACHE_DIR, as the CLI draws it, and writes the terminal
// body as HTML for the README image's Paper artboards (skills/readme-refresh/SKILL.md says how it is used):
//
//   EXPLORE_CACHE_DIR=<dir with saved runs> node scripts/readme-reports-rows.mjs > reports-rows.html
//
// Every coloured piece of a row is its own text box exactly as wide as its characters (7.8px cells of 13px JetBrains
// Mono), so columns line up as they do in a terminal, and the wordmark is drawn as cell rectangles, since a design
// tool's fonts do not render the block characters cell for cell.
import { listSavedRuns } from "../dist/report/saved-runs.js";
import { renderPicker } from "../dist/cli/reports-picker.js";
import { WORDMARK } from "../dist/cli/title-intros.js";

const COLUMNS = 96, CELL = 7.8, ROW = 18;
const runs = await listSavedRuns();
if (!runs.length) { console.error("No saved runs in EXPLORE_CACHE_DIR; save the README's runs there first."); process.exit(1); }
// Shown from a repository's checkout with every repository listed, so the keys include tab.
const repository = runs.find(run => run.repository)?.repository;
const lines = renderPicker({ runs, ...(repository ? { repository } : {}), scope: "all", filter: "", filtering: false, selected: 0, offset: 0 },
  { width: COLUMNS, height: 20, color: true, totalBytes: runs.reduce((sum, run) => sum + run.bytes, 0) });
// The picker pads to the terminal's height above its keys; the image keeps one blank row there.
const keys = lines.slice(-2);
let body = lines.slice(0, -2);
while (body.length > 1 && body.at(-1).trim() === "" && body.at(-2).trim() === "") body = body.slice(0, -1);

const xterm = n => {
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  const level = [0, 95, 135, 175, 215, 255]; n -= 16;
  return [level[Math.floor(n / 36)], level[Math.floor(n / 6) % 6], level[n % 6]];
};
const hex = rgb => `#${rgb.map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = "font-family: 'JetBrains Mono'; font-size: 13px; line-height: 18px; white-space: pre; flex-shrink: 0; overflow: hidden;";

/** One terminal row as coloured pieces; a selected row (a background colour) gets it across the whole row. */
function row(line) {
  if (/^\x1b\[38;5;238m─+/.test(line)) return `<div data-name="Rule" style="display: flex; align-items: center; height: ${ROW}px; flex-shrink: 0;"><div style="height: 1px; flex-grow: 1; background-color: #444444;"></div></div>`;
  let colour = "#D4D4D4", bold = false, background;
  const pieces = [];
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i];
        if (code === 0) { colour = "#D4D4D4"; bold = false; }
        else if (code === 1) bold = true;
        else if (code === 2) colour = "#808080";
        else if (code === 97) colour = "#FFFFFF";
        else if (code === 38 && codes[i + 1] === 5) { colour = hex(xterm(codes[i + 2])); i += 2; }
        else if (code === 48 && codes[i + 1] === 5) { background = hex(xterm(codes[i + 2])); i += 2; }
      }
      continue;
    }
    if (!part) continue;
    pieces.push(`<div style="${FONT} width: ${([...part].length * CELL).toFixed(1)}px; color: ${colour};${bold ? " font-weight: 700;" : ""}">${escape(part)}</div>`);
  }
  return `<div data-name="${background ? "Row — selected" : "Row"}" style="display: flex; height: ${ROW}px; flex-shrink: 0;${background ? ` background-color: ${background};` : ""}">${pieces.join("")}</div>`;
}

/** The wordmark's two rows as rectangles: █ a whole cell, ▀ and ▄ its top or bottom half, overlapping a little so no seams show. */
function wordmark() {
  const rects = [];
  WORDMARK.forEach((line, r) => [...line].forEach((ch, c) => {
    const x = c * CELL, y = r * ROW;
    if (ch === "█") rects.push([x, y, ROW]); else if (ch === "▀") rects.push([x, y, ROW / 2]); else if (ch === "▄") rects.push([x, y + ROW / 2, ROW / 2]);
  }));
  const svg = rects.map(([x, y, h]) => `<rect x="${(x - 0.25).toFixed(2)}" y="${(y - 0.25).toFixed(2)}" width="${(CELL + 0.5).toFixed(2)}" height="${(h + 0.5).toFixed(2)}"/>`).join("");
  const width = (WORDMARK[0].length * CELL).toFixed(1);
  return `<div data-name="Wordmark" style="display: flex; padding-left: ${(3 * CELL).toFixed(1)}px; height: ${2 * ROW}px; flex-shrink: 0;"><svg width="${width}" height="${2 * ROW}" viewBox="0 0 ${width} ${2 * ROW}" fill="#FFFFFF" xmlns="http://www.w3.org/2000/svg">${svg}</svg></div>`;
}

const rows = [];
for (let index = 0; index < body.length; index += 1) {
  // The picker draws the wordmark as two text rows; the image draws both as one picture.
  if (body[index].includes(WORDMARK[0])) { rows.push(wordmark()); index += 1; continue; }
  rows.push(body[index].trim() ? row(body[index]) : `<div data-name="Blank" style="height: ${ROW}px; flex-shrink: 0;"></div>`);
}
rows.push(...keys.map(row));
console.log(`<div data-name="Terminal" style="display: flex; flex-direction: column; padding: 12px 18px 16px 18px;">\n${rows.join("\n")}\n</div>`);
