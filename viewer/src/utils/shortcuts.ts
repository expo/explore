// The keys the viewer answers to, written once. A shortcut is both the thing a handler matches
// an event against and the hint a tooltip prints, so the label can never drift from the key
// that actually fires. Matching is on `event.code` — the physical key — so a Dvorak or AZERTY
// keyboard reaches the same tools; only the printed hint is layout-flavoured.
export type Shortcut = {
  /** KeyboardEvent.code, e.g. "KeyB" or "Digit1". */
  code: string;
  /** ⌘ on Apple keyboards, Ctrl everywhere else. */
  mod?: boolean;
  /** The Control key itself on every keyboard, for chords whose ⌘ form the browser keeps (⌘1–⌘9 switch tabs). */
  ctrl?: boolean;
  /** ⌥ on Apple keyboards, Alt everywhere else. */
  alt?: boolean;
  shift?: boolean;
  /** How the key prints in a hint: "B", "1", "F". */
  key: string;
};

export const APPLE = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/**
 * Whether Ctrl+1–3 reach the page. On Apple keyboards ⌃ is free (the browser's tab keys are ⌘1–9); elsewhere the
 * browser keeps Ctrl+1–8 for its tabs, so those keys are neither handled nor printed there.
 */
export const CANVAS_NUMBER_KEYS = APPLE;

/**
 * Whether Alt+1–8 reach the page. Browsers on Linux and ChromeOS keep them for their tabs; on Apple keyboards ⌥ only
 * types a symbol (matching is on `event.code`, so that does not matter) and Windows browsers leave Alt+digits alone.
 */
export const TARGET_NUMBER_KEYS = APPLE
  || !(typeof navigator !== "undefined" && /Linux|X11|CrOS/.test(navigator.platform || navigator.userAgent));

function mod(code: string, key: string): Shortcut {
  return { code, key, mod: true };
}

function modShift(code: string, key: string): Shortcut {
  return { code, key, mod: true, shift: true };
}

function ctrl(code: string, key: string): Shortcut {
  return { code, key, ctrl: true };
}

function shift(code: string, key: string): Shortcut {
  return { code, key, shift: true };
}

function plain(code: string, key: string): Shortcut {
  return { code, key };
}

function alt(code: string, key: string): Shortcut {
  return { code, key, alt: true };
}

// Keys follow what the reader already knows from other apps: ⌘B is VS Code's sidebar key (here the
// Changes menu), I is Figma's and Finder's info panel (here the inspector), and ⇧0/⇧1 are Figma's
// camera presets.
export const SHORTCUTS = {
  app: {
    /** Global Explore search; intercepted before the browser's location-search command. */
    search: mod("KeyK", "K"),
    /** Opens and closes the Changes menu in the top-left pill. */
    changes: mod("KeyB", "B"),
    /** Opens Hand off to AI, where the report can be handed off (a hosted preview). */
    handoff: plain("KeyA", "A"),
  },
  /** I shows or hides the inspector, as an info panel does elsewhere. */
  panel: {
    right: plain("KeyI", "I"),
  },
  /** T is the Viewer's own light or dark theme; ⇧T is the captured app's appearance, in a report that has both. */
  appearance: {
    theme: plain("KeyT", "T"),
    app: shift("KeyT", "T"),
  },
  /** F puts the whole Viewer in or out of full screen, where the browser allows it. */
  view: {
    fullscreen: plain("KeyF", "F"),
  },
  /** Canvas edits follow the platform-standard history keys. */
  edit: {
    undo: mod("KeyZ", "Z"),
    redo: modShift("KeyZ", "Z"),
  },
  /** Camera presets stay grouped with the persistent camera controls. */
  camera: {
    zoomIn: plain("Equal", "+"),
    zoomOut: plain("Minus", "−"),
    zoom100: shift("Digit0", "0"),
    fit: shift("Digit1", "1"),
    center: shift("Digit2", "2"),
  },
  /**
   * The run's other targets (devices, or platforms in reports from before targets). D opens their menu as ⌘B opens
   * Changes, and ` returns to the last one shown, as ⌘` and Alt-Tab return to the last window.
   */
  target: {
    menu: plain("KeyD", "D"),
    last: plain("Backquote", "`"),
  },
  /** A target by its place in the menu, as the canvases are numbered; the only digits left are ⌥'s. TARGET_NUMBER_KEYS only. */
  targetByNumber: ["1", "2", "3", "4", "5", "6", "7", "8"].map(digit => alt(`Digit${digit}`, digit)),
  /** Initials for the canvases; the shifted digits already belong to persistent canvas actions. */
  canvas: {
    map: plain("KeyM", "M"),
    screens: plain("KeyS", "S"),
    compare: plain("KeyC", "C"),
  },
  /** The canvases by their place in the toolbar, as tabs are numbered elsewhere. Apple keyboards only (CANVAS_NUMBER_KEYS). */
  canvasByNumber: {
    map: ctrl("Digit1", "1"),
    screens: ctrl("Digit2", "2"),
    compare: ctrl("Digit3", "3"),
  },
  /** Screens only, on desktop: G for the grid and E for the filmstrip, as Lightroom's Library switches Grid and Loupe. */
  screens: {
    grid: plain("KeyG", "G"),
    filmstrip: plain("KeyE", "E"),
  },
  /** Compare only. The arrows walk changed screens; J and K walk the changed areas of one. */
  compare: {
    previousScreen: plain("ArrowLeft", "←"),
    nextScreen: plain("ArrowRight", "→"),
    nextArea: plain("KeyJ", "J"),
    previousArea: plain("KeyK", "K"),
    split: plain("Digit1", "1"),
    swipe: plain("Digit2", "2"),
    flip: plain("Digit3", "3"),
    flipSide: plain("KeyX", "X"),
    dividerLeft: plain("BracketLeft", "["),
    dividerRight: plain("BracketRight", "]"),
    outlines: plain("KeyO", "O"),
    whatChanged: plain("KeyW", "W"),
  },
  /** Printed only: an open find field closes itself on Escape. */
  find: {
    close: plain("Escape", "Esc"),
  },
} as const;

/** The hint, in the idiom of the keyboard reading it: Apple's ⌥⇧⌘ order, or Ctrl+Alt+Shift. */
export function formatShortcut(shortcut: Shortcut, apple = APPLE): string {
  if (apple) {
    return `${shortcut.ctrl ? "⌃" : ""}${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${shortcut.mod ? "⌘" : ""}${shortcut.key}`;
  }
  const parts: string[] = [];
  if (shortcut.mod || shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  parts.push(shortcut.key);
  return parts.join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  if (event.code !== shortcut.code) return false;
  if (shortcut.ctrl) {
    if (!event.ctrlKey || event.metaKey) return false;
  } else if ((event.metaKey || event.ctrlKey) !== Boolean(shortcut.mod)) return false;
  if (event.shiftKey !== Boolean(shortcut.shift)) return false;
  return event.altKey === Boolean(shortcut.alt);
}

/** Typing somewhere should never reach for a tool. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable;
}

const PRESSABLE = 'button, a, summary, [role="button"]';

/**
 * True when the space bar belongs to the focused control rather than to the canvas: on a button
 * or a link, Space is how the keyboard presses it, and a tool must not steal that.
 */
function pressesFocused(event: KeyboardEvent): boolean {
  if (event.code !== "Space") return false;
  return Boolean((event.target as HTMLElement | null)?.closest?.(PRESSABLE));
}

/**
 * True while a dialog owns the screen. It has its own keys — Escape, a wrapped Tab — and the
 * shortcuts behind it would move a canvas the reader cannot see.
 */
export function modalOpen(): boolean {
  // Native dialogs and popovers stay mounted while closed. Only their open state owns input. A
  // dialog marked aria-modal="false" (Compare's What changed) sits beside the canvas, so keys
  // still reach it.
  return document.querySelector('dialog[open], [role="dialog"]:not(dialog):not([popover]):not([aria-modal="false"]), [role="dialog"][popover]:popover-open') !== null;
}

/** Whether a key event should be read as a shortcut at all. */
export function shortcutsLive(event: KeyboardEvent): boolean {
  return !event.repeat && !isTyping(event.target) && !pressesFocused(event) && !modalOpen();
}
