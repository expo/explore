// Which modifier keys are down right now, so a button can show the key that completes a chord
// with them: hold ⌃ and the toolbar's Map, Screens and Compare show 1, 2 and 3. One listener for
// the window; components subscribe and re-render only when the set of held modifiers changes.
import { useSyncExternalStore } from "react";
import { APPLE, isTyping, type Shortcut } from "./shortcuts";

export type HeldModifiers = { shift: boolean; ctrl: boolean; meta: boolean; alt: boolean };

const NONE: HeldModifiers = { shift: false, ctrl: false, meta: false, alt: false };
let held: HeldModifiers = NONE;
const listeners = new Set<() => void>();

function same(left: HeldModifiers, right: HeldModifiers): boolean {
  return left.shift === right.shift && left.ctrl === right.ctrl && left.meta === right.meta && left.alt === right.alt;
}

function update(next: HeldModifiers) {
  if (same(held, next)) return;
  held = same(next, NONE) ? NONE : next;
  for (const listener of listeners) listener();
}

function fromEvent(event: KeyboardEvent): HeldModifiers {
  // While typing, a held Shift is for a capital letter, not for a chord.
  if (isTyping(event.target)) return NONE;
  return { shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey };
}

function onKey(event: KeyboardEvent) {
  update(fromEvent(event));
}

function clear() {
  update(NONE);
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    // A chord that leaves the page (⌘Tab, a browser shortcut) never sends its key up here.
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("blur", clear);
    document.removeEventListener("visibilitychange", clear);
    held = NONE;
  };
}

export function useHeldModifiers(): HeldModifiers {
  return useSyncExternalStore(subscribe, () => held, () => NONE);
}

/** The modifiers a shortcut needs, on this keyboard: ⌘ for `mod` on Apple keyboards, Ctrl elsewhere. */
export function shortcutModifiers(shortcut: Shortcut, apple = APPLE): HeldModifiers {
  return {
    shift: Boolean(shortcut.shift),
    ctrl: Boolean(shortcut.ctrl) || (Boolean(shortcut.mod) && !apple),
    meta: Boolean(shortcut.mod) && apple,
    alt: Boolean(shortcut.alt),
  };
}

/**
 * The key that completes `shortcut` with exactly the modifiers held, or nothing: a plain key has no
 * chord to complete, and a held modifier that is not the shortcut's shows nothing for it.
 */
export function heldKeyHint(shortcut: Shortcut, held: HeldModifiers, apple = APPLE): string | undefined {
  if (same(held, NONE)) return undefined;
  return same(held, shortcutModifiers(shortcut, apple)) ? shortcut.key : undefined;
}
