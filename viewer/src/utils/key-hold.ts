/**
 * Paging by holding a key. The first step lands on key down; holding past the initial delay keeps
 * stepping, each step a little sooner than the last until the floor, the way a held scrollbar arrow
 * or a spinner accelerates. The browser's own key repeat is ignored (its rate is a fixed OS setting),
 * so the hold is timed here and ends on key up, another key, blur, a field or dialog taking the
 * keyboard, or the end of the list.
 */
import { isTyping, modalOpen } from "./shortcuts";

export const HOLD_INITIAL_DELAY_MS = 250;
export const HOLD_FIRST_INTERVAL_MS = 200;
export const HOLD_FLOOR_INTERVAL_MS = 70;
const HOLD_DECAY = 0.8;

/** Milliseconds between held step `step` (1 = the first step after the initial delay) and the next. */
export function holdIntervalMs(step: number): number {
  return Math.max(HOLD_FLOOR_INTERVAL_MS, Math.round(HOLD_FIRST_INTERVAL_MS * HOLD_DECAY ** Math.max(0, step - 1)));
}

/** When each held step fires, in milliseconds from key down, up to `count` steps. */
export function holdSchedule(count: number): number[] {
  const times: number[] = [];
  let at = HOLD_INITIAL_DELAY_MS;
  for (let step = 1; step <= count; step += 1) {
    times.push(at);
    at += holdIntervalMs(step);
  }
  return times;
}

export type KeyHold = {
  /**
   * Starts holding `code` after its first step already landed. `step` takes the next step and
   * says whether there was one; the hold ends by itself when there is not.
   */
  begin: (code: string, step: () => boolean) => void;
  end: () => void;
  /**
   * Ends the hold when another key goes down, as the OS's own key repeat stops. A modifier does
   * not end it, so ⇧ or ⌘ can join a held key. Call it first in the listener, before any guard.
   */
  interrupt: (event: KeyboardEvent) => void;
  /** Whether `code` is the key being held. */
  holding: (code: string) => boolean;
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Whether the keyboard is still the page's: nothing is being typed into and no dialog is open. */
function keyboardFree(): boolean {
  if (typeof document === "undefined") return true;
  return !isTyping(document.activeElement) && !modalOpen();
}

// A glide moves at the stepped hold's speeds, in tap steps per second: one step per first
// interval at first, easing up to one per floor interval.
const GLIDE_START_RATE = 1000 / HOLD_FIRST_INTERVAL_MS;
const GLIDE_TOP_RATE = 1000 / HOLD_FLOOR_INTERVAL_MS;
const GLIDE_RAMP_MS = 1000;
/** A glide picks up from rest over this long, so it does not lurch out of the tap's step. */
const GLIDE_PICKUP_MS = 80;

/** How fast a glide moves `elapsed` milliseconds after it began, in tap steps per second. */
export function glideRate(elapsed: number): number {
  const ramp = Math.min(1, elapsed / GLIDE_RAMP_MS);
  return GLIDE_START_RATE * Math.min(1, elapsed / GLIDE_PICKUP_MS)
    + (GLIDE_TOP_RATE - GLIDE_START_RATE) * ramp * ramp * (3 - 2 * ramp);
}

/**
 * For a continuous value (a zoom, a divider) a held key glides instead of stepping: from `delayMs`
 * on, `move` is called every frame with how far to go, in tap steps (fractions of one), until the
 * hold ends. `move` says whether it moved; at a limit it does not, and the hold ends there.
 */
export function glideWhileHeld(hold: KeyHold, code: string, delayMs: number, move: (steps: number) => boolean): void {
  const start = performance.now() + delayMs;
  let last = start;
  const frame = (now: number) => {
    if (!hold.holding(code)) return;
    if (now > start) {
      const steps = glideRate(now - start) * (now - Math.max(last, start)) / 1000;
      last = now;
      if (!move(steps)) {
        hold.end();
        return;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** One held key at a time, timed on the schedule above. */
export function createKeyHold(): KeyHold {
  let current: { code: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const end = () => {
    if (current) clearTimeout(current.timer);
    current = undefined;
  };
  return {
    begin(code, step) {
      end();
      let count = 1;
      const tick = () => {
        const next = holdIntervalMs(count);
        // A field or a dialog took the keyboard mid-hold: end, rather than step behind it.
        if (!current || !keyboardFree() || !step()) { end(); return; }
        current = { code, timer: setTimeout(tick, next) };
        count += 1;
      };
      current = { code, timer: setTimeout(tick, HOLD_INITIAL_DELAY_MS) };
    },
    end,
    interrupt(event) {
      if (current && !event.repeat && event.code !== current.code && !MODIFIER_KEYS.has(event.key)) end();
    },
    holding: (code) => current?.code === code,
  };
}
