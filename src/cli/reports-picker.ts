import { cleanRun, type SavedRun } from "../report/saved-runs.js";
import { intros, WORDMARK, type IntroName, type Paint } from "./title-intros.js";

/**
 * The `expo-explore reports` picker: one aligned line per saved run, the selected run's details in a strip below,
 * arrow keys to move, Enter to open. Rendering and key handling are pure (state in, lines or state out); `runPicker`
 * owns the terminal: the alternate screen, raw input, resizes and the intro.
 */
export type PickerState = {
  runs: SavedRun[];
  /** This repository (owner/name), when run inside one with saved runs; `tab` switches to every repository. */
  repository?: string;
  scope: "repository" | "all";
  filter: string;
  filtering: boolean;
  selected: number;
  offset: number;
  /** The run awaiting `y` to delete. */
  confirming?: string | undefined;
  message?: string | undefined;
};
export type PickerAction = { type: "open" | "upload" | "delete"; run: SavedRun } | { type: "quit" };
export type Key = "up" | "down" | "pageup" | "pagedown" | "home" | "end" | "enter" | "escape" | "tab" | "backspace" | "quit" | { text: string };

const PLAIN: Paint = { white: s => s, text: s => s, dim: s => s, faint: s => s, amber: s => s, green: s => s, yellow: s => s, blue: s => s, red: s => s };
const sgr = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
export const COLOR: Paint = { white: sgr("1;97"), text: sgr("97"), dim: sgr("38;5;244"), faint: sgr("38;5;238"), amber: sgr("38;5;214"), green: sgr("38;5;114"),
  yellow: sgr("38;5;221"), blue: sgr("38;5;111"), red: sgr("38;5;203") };
/** The selected row's background, kept across the row's own colour resets so it reaches the end of the line. */
const SELECT = (text: string) => `\x1b[48;5;236m${text.replaceAll("\x1b[0m", "\x1b[0m\x1b[48;5;236m")}\x1b[0m`;

const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const length = (text: string) => [...visible(text)].length;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - length(text)));
/** A line cut to `width` visible columns, keeping its colour codes and closing them. */
function fit(line: string, width: number): string {
  if (length(line) <= width) return line;
  let out = "", count = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    for (const ch of part) { if (count === width - 1) return `${out}…${out.includes("\x1b[") ? "\x1b[0m" : ""}`; out += ch; count += 1; }
  }
  return out;
}
const cut = (text: string, width: number) => [...text].length > width ? `${[...text].slice(0, Math.max(0, width - 1)).join("")}…` : text;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** "5 min ago", "this morning", "yesterday", "last Sunday", then "Oct 12" (with the year when it is not this year). */
export function friendlyTime(iso: string, now = Date.now()): string {
  const then = new Date(iso), today = new Date(now);
  const minutes = Math.floor((now - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.ceil((midnight - then.getTime()) / 86_400_000);
  if (then.getTime() >= midnight) return then.getHours() < 12 ? "this morning" : then.getHours() < 18 ? "this afternoon" : "this evening";
  if (days <= 1) return "yesterday";
  if (days < 7) return `last ${then.toLocaleDateString("en-US", { weekday: "long" })}`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(then.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

export function kindLabel(run: SavedRun): string {
  return run.kind === "local" ? "Local" : run.kind === "compare" ? "Compare" : run.kind === "exploration" ? "Explore" : `PR #${run.number ?? "?"}`;
}

/** What the list calls a run: a local review of uncommitted changes says how many files; the rest use the report's title. */
export function runTitle(run: SavedRun): string {
  if (run.kind === "local" && run.uncommittedFiles && run.base) return `HEAD + ${run.uncommittedFiles} uncommitted file${run.uncommittedFiles === 1 ? "" : "s"} vs ${run.base.ref}`;
  if (run.kind === "compare" && run.base && run.head) return `${run.base.ref} → ${run.head.ref}`;
  return run.title;
}

const PLATFORM_NAMES: Record<string, string> = { ios: "iOS", android: "Android" };
const platforms = (run: SavedRun) => run.platforms.map(platform => PLATFORM_NAMES[platform] ?? platform).join(" ");

/** The runs the list shows: this repository's (or all) that match the filter, across title, refs, subjects, SHAs and PR number. */
export function visibleRuns(state: PickerState): SavedRun[] {
  const query = state.filter.trim().toLowerCase();
  return state.runs.filter(run => (state.scope === "all" || !state.repository || run.repository === state.repository)
    && (!query || [runTitle(run), run.title, kindLabel(run), run.repository, run.head?.ref, run.head?.sha, run.head?.subject, run.base?.ref, run.base?.sha, run.base?.subject,
      run.explored?.app].some(field => field?.toLowerCase().includes(query))));
}

function counts(run: SavedRun, paint: Paint): string {
  if (run.explored) return `${paint.text(String(run.explored.screens))} ${paint.dim("screens")}  ${paint.dim(`${run.explored.unexplored} unexplored`)}`;
  const parts = ([["modified", paint.amber, "modified"], ["added", paint.green, "added"], ["removed", paint.red, "removed"], ["needs-review", paint.yellow, "need review"],
    ["source-affected", paint.yellow, "source-affected"]] as const)
    .filter(([group]) => run.changes?.[group]).map(([group, colour, label]) => `${colour(String(run.changes![group]))} ${paint.dim(label)}`);
  return parts.length ? parts.join("  ") : paint.dim("no visible changes");
}

const KIND_COLOUR = (run: SavedRun, paint: Paint) => ({ local: paint.blue, compare: paint.text, exploration: paint.green, "pull-request": paint.amber }[run.kind]);

/** The whole screen for a terminal `width` × `height`, top to bottom. */
export function renderPicker(state: PickerState, options: { width: number; height: number; now?: number; color?: boolean; totalBytes: number; header?: string[] }): string[] {
  const paint = options.color === false ? PLAIN : COLOR;
  const select = options.color === false ? (text: string) => text : SELECT;
  const width = Math.max(40, options.width), now = options.now ?? Date.now();
  // Runs are made plain when saved and read; drawing them again plain keeps a hand-edited run.json from reaching the terminal.
  const runs = visibleRuns(state).map(cleanRun);
  const scope = state.scope === "all" || !state.repository ? "all repositories" : state.repository;
  const subtitle = paint.dim(`${state.runs.length} saved run${state.runs.length === 1 ? "" : "s"} · ${formatBytes(options.totalBytes)} on disk · ${scope}`);
  const tall = options.height >= 20 && width >= WORDMARK[0]!.length + 6;
  const header = options.header ?? (tall ? ["", ...WORDMARK.map(row => `   ${paint.white(row)}`), "", `   ${subtitle}`, ""] : [`  ${paint.white("Expo Explore")}  ${subtitle}`, ""]);
  const rule = paint.faint("─".repeat(width));
  // Columns: kind, title (what is left), head SHA, platforms, when; the SHA and platforms go first when narrow.
  const wide = width >= 72;
  const fixed = 2 + 9 + 2 + (wide ? 2 + 7 + 2 + 11 : 0) + 2 + 14;
  const titleWidth = Math.max(12, width - fixed);
  const row = (run: SavedRun) => [pad(KIND_COLOUR(run, paint)(kindLabel(run)), 9), "  ", pad(cut(runTitle(run), titleWidth), titleWidth),
    ...(wide ? ["  ", paint.dim(pad(run.head?.sha.slice(0, 7) ?? "", 7)), "  ", paint.dim(pad(cut(platforms(run), 11), 11))] : []), "  ", paint.dim(cut(friendlyTime(run.createdAt, now), 14))].join("");

  const footer: string[] = [rule];
  if (state.filtering) footer.push(`  ${paint.amber("/")} ${state.filter}${paint.amber("▏")}   ${paint.dim(`${runs.length} of ${state.runs.length} · Esc clears · ⏎ done`)}`);
  else if (state.confirming) {
    const run = state.runs.find(each => each.id === state.confirming);
    footer.push(`  ${paint.red("Delete")} ${paint.white(run ? cut(runTitle(run), 50) : state.confirming)} ${paint.dim(`(${formatBytes(run?.bytes ?? 0)})`)}? ${paint.dim("y/N")}`);
  } else {
    const keys = width >= 80 ? `↑↓ move   ⏎ open   / filter   u upload   d delete${state.repository ? "   tab all repos" : ""}   q quit`
      : `↑↓ ⏎ open  / filter  u upload  d delete${state.repository ? "  tab" : ""}  q`;
    footer.push(`  ${state.message ? `${paint.text(state.message)}   ` : ""}${paint.dim(keys)}`);
  }

  if (!runs.length) {
    const empty = state.runs.length
      ? [`  ${paint.dim(state.filter ? `Nothing matches "${state.filter}".` : `No saved runs of ${state.repository}. Press tab for every repository.`)}`]
      : [`  ${paint.text("No saved runs yet.")}`, `  ${paint.dim("expo-explore capture:review reviews your branch on this machine, and its report is kept here.")}`];
    return [...header, ...empty, "", ...footer].map(line => fit(line, width));
  }
  const selected = runs[Math.min(state.selected, runs.length - 1)]!;
  const detail = [rule, `  ${paint.white(runTitle(selected))}${selected.repository && state.scope === "all" ? paint.dim(`  ${selected.repository}`) : ""}`];
  if (selected.explored) detail.push(`  ${paint.dim("app ")}  ${selected.explored.app}${selected.explored.version ? ` ${selected.explored.version}` : ""}${selected.explored.buildNumber ? ` (${selected.explored.buildNumber})` : ""}`, "");
  else {
    const commit = (label: string, side: SavedRun["head"], uncommitted?: number) => side
      ? `  ${paint.dim(label)}  ${(label === "head" ? paint.amber : paint.dim)(side.sha.slice(0, 7))}  ${cut(side.subject ?? side.ref, width - 20)}${uncommitted ? paint.dim(` + ${uncommitted} uncommitted`) : ""}${side.subject && side.ref !== "HEAD" && !/^[0-9a-f]{7,40}$/.test(side.ref) && side.subject !== side.ref ? paint.dim(`  ${side.ref}`) : ""}`
      : "";
    detail.push(commit("head", selected.head, selected.uncommittedFiles), commit("base", selected.base));
  }
  detail.push(`  ${counts(selected, paint)}${selected.device ? paint.dim(`   · ${selected.device}`) : ""}`);

  // The list gets whatever the header, details and footer leave, and scrolls to keep the selection in view.
  const room = Math.max(3, options.height - header.length - detail.length - footer.length);
  const index = Math.min(state.selected, runs.length - 1);
  const offset = Math.min(Math.max(state.offset, index - room + 1, 0), index);
  const list = runs.slice(offset, offset + room).map((run, position) => offset + position === index
    ? select(`${paint.amber("▌")} ${pad(row(run), width - 3)}`) : `  ${row(run)}`);
  // The details follow the list; what is left over sits above the keys, so a short list does not float away from them.
  return [...header, ...list, ...detail, ...Array.from({ length: room - list.length }, () => ""), ...footer].map(line => fit(line, width));
}

/** One key against the state: the next state, and an action when the key asks for one. */
export function reducePicker(state: PickerState, key: Key, pageSize = 10): { state: PickerState; action?: PickerAction } {
  const runs = visibleRuns(state);
  const at = Math.min(state.selected, Math.max(0, runs.length - 1));
  const move = (to: number): { state: PickerState } => ({ state: { ...state, selected: Math.max(0, Math.min(runs.length - 1, to)), message: undefined } });
  if (state.confirming) {
    const run = state.runs.find(each => each.id === state.confirming);
    const next: PickerState = { ...state, confirming: undefined };
    return typeof key === "object" && key.text.toLowerCase() === "y" && run ? { state: next, action: { type: "delete", run } } : { state: { ...next, message: "Kept it." } };
  }
  // Ctrl+C always quits, whatever the picker is in the middle of.
  if (key === "quit") return { state, action: { type: "quit" } };
  if (state.filtering) {
    if (key === "escape") return { state: { ...state, filtering: false, filter: "", selected: 0, offset: 0 } };
    if (key === "enter") return { state: { ...state, filtering: false } };
    if (key === "backspace") return { state: { ...state, filter: [...state.filter].slice(0, -1).join(""), selected: 0, offset: 0 } };
    if (key === "up" || key === "down") return reducePicker({ ...state, filtering: false }, key, pageSize);
    if (typeof key === "object") return { state: { ...state, filter: state.filter + key.text, selected: 0, offset: 0 } };
    return { state };
  }
  const run = runs[at];
  switch (key) {
    case "up": return move(at - 1);
    case "down": return move(at + 1);
    case "pageup": return move(at - pageSize);
    case "pagedown": return move(at + pageSize);
    case "home": return move(0);
    case "end": return move(runs.length - 1);
    case "enter": return run ? { state, action: { type: "open", run } } : { state };
    case "tab": return state.repository ? { state: { ...state, scope: state.scope === "all" ? "repository" : "all", selected: 0, offset: 0, message: undefined } } : { state };
    case "escape": return state.filter ? { state: { ...state, filter: "", selected: 0, offset: 0 } } : { state, action: { type: "quit" } };
    case "backspace": return { state };
  }
  switch (key.text) {
    case "j": return move(at + 1);
    case "k": return move(at - 1);
    case "g": return move(0);
    case "G": return move(runs.length - 1);
    case "/": return { state: { ...state, filtering: true, message: undefined } };
    case "u": return run ? { state, action: { type: "upload", run } } : { state };
    case "d": return run ? { state: { ...state, confirming: run.id, message: undefined } } : { state };
    case "q": return { state, action: { type: "quit" } };
  }
  return { state };
}

/**
 * Raw terminal input to keys; a paste or several keys in one chunk become several keys. Escape sequences the picker has
 * no use for (Delete, F-keys, modified arrows, Alt+key) are consumed whole and ignored, so they never read as Esc.
 */
export function decodeKeys(data: string): Key[] {
  const keys: Key[] = [];
  const named: Record<string, Key> = { "[A": "up", OA: "up", "[B": "down", OB: "down", "[5~": "pageup", "[6~": "pagedown",
    "[H": "home", OH: "home", "[1~": "home", "[F": "end", OF: "end", "[4~": "end" };
  let rest = data;
  while (rest) {
    if (rest.startsWith("\x1b")) {
      // CSI: ESC [ parameters final byte; SS3: ESC O and one byte; Alt+key: ESC and the key; a lone ESC is Esc.
      const sequence = /^\x1b(\[[0-?]*[ -/]*[@-~]|O.|[^[O])/s.exec(rest);
      if (!sequence) { keys.push("escape"); rest = rest.slice(1); continue; }
      const key = named[sequence[1]!];
      if (key) keys.push(key);
      rest = rest.slice(sequence[0].length);
      continue;
    }
    const [first] = rest;
    rest = rest.slice(first!.length);
    if (first === "\r" || first === "\n") keys.push("enter");
    else if (first === "\t") keys.push("tab");
    else if (first === "\x7f" || first === "\b") keys.push("backspace");
    else if (first === "\x03" || first === "\x04") keys.push("quit");
    else if (first! >= " " && !/[\u007f-\u009f]/.test(first!)) keys.push({ text: first! });
  }
  return keys;
}

export type PickerTerminal = {
  input: NodeJS.ReadStream; output: NodeJS.WriteStream;
  color: boolean; intro?: IntroName | undefined;
  /** Deletes a run; the picker drops it from the list. */
  remove: (run: SavedRun) => Promise<void>;
  totalBytes: () => number;
};

/** Shows the picker until the person opens, uploads or quits; the terminal is restored before it returns. */
export async function runPicker(initial: PickerState, terminal: PickerTerminal): Promise<PickerAction> {
  const { input, output } = terminal;
  let state = initial;
  const size = () => ({ width: output.columns || 80, height: output.rows || 24 });
  const paint = terminal.color ? COLOR : PLAIN;
  const draw = (header?: string[]) => {
    const lines = renderPicker(state, { ...size(), color: terminal.color, totalBytes: terminal.totalBytes(), ...(header ? { header } : {}) });
    output.write(`\x1b[H${lines.map(line => `${line}\x1b[K`).join("\n")}\x1b[J`);
  };
  output.write("\x1b[?1049h\x1b[?25l");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  const pending: Key[] = [];
  let wake: (() => void) | undefined;
  const onData = (data: string) => { pending.push(...decodeKeys(data)); wake?.(); };
  const onResize = () => draw();
  input.on("data", onData);
  output.on("resize", onResize);
  try {
    // The intro plays where the wordmark will rest, with the list already drawn under it; any key skips it.
    const { height, width } = size();
    if (terminal.intro && height >= 20 && width >= WORDMARK[0]!.length + 6) {
      const intro = intros(Date.now())[terminal.intro];
      const start = Date.now();
      for (;;) {
        const t = Math.min(1, (Date.now() - start) / intro.duration);
        draw(["", ...intro.frame(t, paint).map(row => `   ${row}`), "", "", ""]);
        if (t === 1 || pending.length) break;
        await new Promise(done => setTimeout(done, 16));
      }
      // A key that skipped the intro only skips it; Ctrl+C still quits.
      const quit = pending.includes("quit");
      pending.length = 0;
      if (quit) pending.push("quit");
    }
    draw();
    for (;;) {
      if (!pending.length) await new Promise<void>(done => { wake = done; });
      wake = undefined;
      while (pending.length) {
        const result = reducePicker(state, pending.shift()!, Math.max(1, size().height - 16));
        state = result.state;
        const action = result.action;
        if (action?.type === "delete") {
          await terminal.remove(action.run);
          state = { ...state, runs: state.runs.filter(run => run.id !== action.run.id), message: `Deleted ${runTitle(action.run)}.` };
        } else if (action) return action;
      }
      draw();
    }
  } finally {
    input.off("data", onData);
    output.off("resize", onResize);
    input.setRawMode(false);
    input.pause();
    output.write("\x1b[?25h\x1b[?1049l");
  }
}
