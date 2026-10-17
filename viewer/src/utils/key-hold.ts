/**
 * Paging by holding a key. The first step lands on key down; holding past the initial delay keeps
 * stepping, each step a little sooner than the last until the floor, the way a held scrollbar arrow
 * or a spinner accelerates. The browser's own key repeat is ignored (its rate is a fixed OS setting),
 * so the hold is timed here and ends on key up, blur, or the end of the list.
 */
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
  /** Whether `code` is the key being held. */
  holding: (code: string) => boolean;
};

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
        if (!current || !step()) { end(); return; }
        current = { code, timer: setTimeout(tick, holdIntervalMs(count)) };
        count += 1;
      };
      current = { code, timer: setTimeout(tick, HOLD_INITIAL_DELAY_MS) };
    },
    end,
    holding: (code) => current?.code === code,
  };
}
