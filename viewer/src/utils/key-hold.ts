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

/** One press of a held key, which a glide can outlive. */
export type KeyPress = {
  /** Whether its key is still down, and nothing interrupted the hold or began a newer one. */
  readonly held: boolean;
  /** Whether it ended by its key going up, rather than by an interruption. */
  readonly released: boolean;
  /** Ends the hold, if this press still is it. */
  end: () => void;
};

export type KeyHold = {
  /**
   * Starts holding `code` after its first step already landed. `step` takes the next step and
   * says whether there was one; the hold ends by itself when there is not.
   */
  begin: (code: string, step: () => boolean) => KeyPress;
  /** Ends the hold as an interruption: another key, blur, a field or dialog taking the keyboard. */
  end: () => void;
  /** Ends the hold because `code` went up, if it is the key being held. */
  release: (code: string) => void;
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

export type GlideProfile = {
  /** Tap steps per second as the key goes down. */
  startRate: number;
  /** Tap steps per second once the ramp is over. */
  topRate: number;
  rampMs: number;
};

/** The Swipe divider: a 5% step in 125ms at first, up to a width a second. */
export const DIVIDER_GLIDE: GlideProfile = { startRate: 8, topRate: 20, rampMs: 700 };
/** The canvas zoom: a 1.2x step in 167ms at first, up to about three doublings a second. */
export const ZOOM_GLIDE: GlideProfile = { startRate: 6, topRate: 12, rampMs: 700 };

/** How fast a glide moves `elapsed` milliseconds after the key went down, in tap steps per second. */
export function glideRate(elapsed: number, profile: GlideProfile): number {
  const ramp = Math.min(1, Math.max(0, elapsed / profile.rampMs));
  return profile.startRate + (profile.topRate - profile.startRate) * ramp * ramp * (3 - 2 * ramp);
}

/**
 * For a continuous value (a zoom, a divider) a key glides instead of stepping, from the moment it
 * goes down: `move` is called every frame with how far to go, in tap steps (fractions of one), at
 * the profile's speed, while `press` is held. A tap, released before a whole step is covered, still
 * completes its one step at that speed, so a tap and a hold begin as one motion; an interrupted
 * press stops where it is. `move` says whether it moved; at a limit it does not, and the press's
 * hold ends there.
 */
export function glideWhileHeld(press: KeyPress, move: (steps: number) => boolean, profile: GlideProfile): void {
  const start = performance.now();
  let last = start;
  let covered = 0;
  const frame = (now: number) => {
    const held = press.held;
    if (!held && !(press.released && covered < 1)) return;
    // A frame's timestamp can predate the key down that scheduled it.
    let steps = glideRate(now - start, profile) * Math.max(0, now - last) / 1000;
    last = Math.max(last, now);
    if (!held) steps = Math.min(steps, 1 - covered);
    covered += steps;
    if (steps > 0 && !move(steps)) {
      press.end();
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** One held key at a time, timed on the schedule above. */
export function createKeyHold(): KeyHold {
  let current: { code: string; timer: ReturnType<typeof setTimeout>; press: { held: boolean; released: boolean } } | undefined;
  const finish = (released: boolean) => {
    if (current) {
      clearTimeout(current.timer);
      current.press.held = false;
      current.press.released = released;
    }
    current = undefined;
  };
  const end = () => finish(false);
  return {
    begin(code, step) {
      end();
      let count = 1;
      const tick = () => {
        const next = holdIntervalMs(count);
        // A field or a dialog took the keyboard mid-hold: end, rather than step behind it.
        if (!current || !keyboardFree() || !step()) { end(); return; }
        current.timer = setTimeout(tick, next);
        count += 1;
      };
      const state = { held: true, released: false };
      current = { code, timer: setTimeout(tick, HOLD_INITIAL_DELAY_MS), press: state };
      return {
        get held() { return state.held; },
        get released() { return state.released; },
        end: () => { if (current?.press === state) end(); },
      };
    },
    end,
    release(code) {
      if (current?.code === code) finish(true);
    },
    interrupt(event) {
      if (current && !event.repeat && event.code !== current.code && !MODIFIER_KEYS.has(event.key)) end();
    },
    holding: (code) => current?.code === code,
  };
}
