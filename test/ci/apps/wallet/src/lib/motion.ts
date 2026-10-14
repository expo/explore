import { isExploreProfile } from '@/fixtures/runtime';
import { reduceMotionEnabled, useReduceMotion } from '@/lib/accessibility';

/**
 * Motion is part of the product, but it gives way twice. A capture must show a screen's final frame, so
 * the explore profile never animates. And iOS Reduce Motion (Settings → Accessibility → Motion) turns
 * entrances, the balance count-up, the splash fill and the glass controls' response to touch off while
 * the app is open, and back on when it is turned off.
 */
const buildAnimates = !isExploreProfile;

// Read Reduce Motion now, so the first screens already know it.
reduceMotionEnabled();

/** Whether to animate, following Reduce Motion as it changes. */
export function useMotion(): boolean {
  const reduce = useReduceMotion();
  return buildAnimates && !reduce;
}

/**
 * An entrance or exit animation, or none without motion: the view then appears or goes in its final
 * state. Reanimated reads it when the view mounts (or unmounts), so the value at that moment is the one
 * that counts.
 */
export function entering<T>(animation: T): T | undefined {
  return buildAnimates && !reduceMotionEnabled() ? animation : undefined;
}

export const exiting = entering;
