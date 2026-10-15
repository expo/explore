/**
 * The "Expo Explore" wordmark `expo-explore reports` opens with, and the five ways it can arrive. One is picked at
 * random each launch (EXPLORE_INTRO names one, or `off`). Each intro is a function of progress t (0..1) to the
 * wordmark's two rows, so it can be drawn at any frame rate and tested without a terminal.
 */
export type Paint = Record<"white" | "text" | "dim" | "faint" | "amber" | "green" | "yellow" | "blue" | "red", (text: string) => string>;
export type Intro = { duration: number; frame: (t: number, paint: Paint) => string[] };

// A two-row pixel font: one column between letters, three between words.
const GLYPHS: Record<string, [string, string]> = { e: ["█▀▀", "██▄"], x: ["▀▄▀", "█ █"], p: ["█▀█", "█▀▀"], o: ["█▀█", "█▄█"], l: ["█  ", "█▄▄"], r: ["█▀█", "█▀▄"] };
export const WORDMARK: string[] = [0, 1].map(row => "expo explore".split(" ").map(word => [...word].map(letter => GLYPHS[letter]![row]).join(" ")).join("   "));
const WIDTH = WORDMARK[0]!.length;
const NOISE = [..."░▒▓▚▞▖▗▘▝◆◇○●■□▪▫"];

const ease = (t: number) => 1 - (1 - t) ** 3;
/** A small seeded random, so an intro plays the same way for the same seed (and in tests). */
function seeded(seed: number): () => number {
  let state = seed % 2147483647 || 1;
  return () => { state = (state * 16807) % 2147483647; return state / 2147483647; };
}
const cells = (fn: (ch: string, row: number, column: number) => string) => WORDMARK.map((row, r) => [...row].map((ch, c) => fn(ch, r, c)).join(""));

export function intros(seed = 7): Record<"slider" | "decrypt" | "beams" | "snap" | "slide", Intro> {
  const random = seeded(seed);
  // decrypt: when each letter locks in.
  const lock = WORDMARK.map(row => [...row].map(() => 0.3 + random() * 0.6));
  // snap: letters start in each other's places and each snaps home at its own moment.
  const swaps = WORDMARK.map(row => {
    const map = [...row].map((_, c) => c);
    const letters = map.filter(c => row[c] !== " ");
    for (let i = 0; i < letters.length * 0.35; i += 1) {
      const a = letters[Math.floor(random() * letters.length)]!, b = letters[Math.floor(random() * letters.length)]!;
      [map[a], map[b]] = [map[b]!, map[a]!];
    }
    return map.map((from, c) => ({ from, at: from === c ? 0 : 0.3 + random() * 0.5 }));
  });
  const noise = () => NOISE[Math.floor(random() * NOISE.length)]!;
  return {
    // The Viewer's compare slider: the crisp "after" behind the handle, the faded "before" ahead of it.
    slider: { duration: 600, frame: (t, paint) => {
      const at = Math.round(ease(t) * WIDTH);
      return cells((ch, _r, c) => c === at && t < 1 ? paint.amber("┃") : c < at ? paint.white(ch) : paint.faint(ch === " " ? " " : "░"));
    } },
    // Every letter cycles through noise, then locks in with an amber flash.
    decrypt: { duration: 900, frame: (t, paint) => cells((ch, r, c) => {
      if (ch === " ") return " ";
      const at = lock[r]![c]!;
      if (t < at) return (t < 0.15 ? paint.faint : paint.blue)(noise());
      return t < at + 0.07 ? paint.amber(ch) : paint.white(ch);
    }) },
    // A diagonal beam of light draws the wordmark as it passes.
    beams: { duration: 700, frame: (t, paint) => {
      const beam = t * (WIDTH + 16) - 6;
      return cells((ch, r, c) => {
        const distance = c + r * 3 - beam;
        return distance > 0 ? " " : distance > -3 ? paint.amber(ch === " " ? "·" : ch) : distance > -6 ? paint.yellow(ch) : paint.white(ch);
      });
    } },
    // A visual diff resolving: misplaced letters (amber, modified) snap home (green), then settle.
    snap: { duration: 900, frame: (t, paint) => cells((ch, r, c) => {
      const { from, at } = swaps[r]![c]!;
      const original = WORDMARK[r]![from]!;
      if (t < 0.12) return paint.faint(original === " " ? " " : "░");
      if (at === 0) return paint.text(ch);
      if (t < at) return paint.amber(original);
      return t < at + 0.1 ? paint.green(ch) : paint.white(ch);
    }) },
    // Letters glide in from the right one after another, gray to white.
    slide: { duration: 800, frame: (t, paint) => WORDMARK.map(row => {
      const out = Array.from({ length: WIDTH + 24 }, () => " ");
      for (let c = 0; c < WIDTH; c += 1) {
        if (row[c] === " ") continue;
        const local = Math.min(1, Math.max(0, (t - (c / WIDTH) * 0.5) / 0.5));
        if (local === 0) continue;
        out[c + Math.round((1 - ease(local)) * 24)] = (local < 1 ? paint.dim : paint.white)(row[c]!);
      }
      return out.join("").trimEnd();
    }) },
  };
}

export const INTRO_NAMES = ["slider", "decrypt", "beams", "snap", "slide"] as const;
export type IntroName = (typeof INTRO_NAMES)[number];

/** EXPLORE_INTRO when it names one (or `off`), otherwise a random one. */
export function pickIntro(environment: NodeJS.ProcessEnv, random = Math.random): IntroName | undefined {
  const chosen = environment.EXPLORE_INTRO?.trim().toLowerCase();
  if (chosen === "off" || chosen === "none") return undefined;
  if (chosen && (INTRO_NAMES as readonly string[]).includes(chosen)) return chosen as IntroName;
  return INTRO_NAMES[Math.floor(random() * INTRO_NAMES.length)];
}
