import { useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform, useWindowDimensions } from 'react-native';

/** The iOS change events that carry an on/off value. */
type SettingEvent = 'reduceTransparencyChanged' | 'reduceMotionChanged' | 'boldTextChanged' | 'grayscaleChanged'
  | 'invertColorsChanged' | 'screenReaderChanged' | 'darkerSystemColorsChanged';

/**
 * One iOS accessibility setting. The value is read once and then follows the setting's change event, so
 * every screen that uses it switches while the app is open, and a screen that mounts later starts from the
 * known value instead of flashing the default. `use` subscribes a component; `current` is the last known
 * value, for code that reads it once, such as an entrance animation when its view mounts.
 */
function accessibilitySetting(event: SettingEvent, read: () => Promise<boolean>) {
  let value = false;
  let started = false;
  const listeners = new Set<() => void>();
  const update = (next: boolean) => {
    if (next === value) return;
    value = next;
    listeners.forEach((listener) => listener());
  };
  const start = () => {
    if (started) return;
    started = true;
    read().then(update, () => { /* Unsupported on this platform: stays off. */ });
    AccessibilityInfo.addEventListener(event, update);
  };
  const subscribe = (listener: () => void) => {
    start();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return {
    use: () => useSyncExternalStore(subscribe, () => value),
    current: () => { start(); return value; },
  };
}

const reduceMotion = accessibilitySetting('reduceMotionChanged', () => AccessibilityInfo.isReduceMotionEnabled());
const reduceTransparency = accessibilitySetting('reduceTransparencyChanged', () => AccessibilityInfo.isReduceTransparencyEnabled());
// React Native reports iOS Increase Contrast as darker system colors.
const increaseContrast = accessibilitySetting('darkerSystemColorsChanged', () => AccessibilityInfo.isDarkerSystemColorsEnabled());
const screenReader = accessibilitySetting('screenReaderChanged', () => AccessibilityInfo.isScreenReaderEnabled());

/** Settings → Accessibility → Motion → Reduce Motion. */
export const useReduceMotion = reduceMotion.use;
/** The last known Reduce Motion value; reading it also starts following the setting. */
export const reduceMotionEnabled = reduceMotion.current;
/** Settings → Accessibility → Display & Text Size → Reduce Transparency. */
export const useReduceTransparency = reduceTransparency.use;
/** Settings → Accessibility → Display & Text Size → Increase Contrast. */
export const useIncreaseContrast = increaseContrast.use;
/** Settings → Accessibility → VoiceOver. */
export const useScreenReader = screenReader.use;

/**
 * Has VoiceOver speak `message` once it has stayed the same for `delay` ms, so a search result count is
 * not spoken on every keystroke; `null` says nothing. It is for feedback that appears without focus
 * moving to it, such as a notice that clears itself. iOS ignores `accessibilityLiveRegion`, so the view
 * keeps that prop for Android's TalkBack, and this speaks on iOS only, so TalkBack does not say it twice.
 */
export function useAnnouncement(message: string | null, delay = 0) {
  useEffect(() => {
    if (!message || Platform.OS !== 'ios') return;
    const timer = setTimeout(() => AccessibilityInfo.announceForAccessibility(message), delay);
    return () => clearTimeout(timer);
  }, [message, delay]);
}

/** iOS text sizes (Settings → Display & Brightness → Text Size, and Larger Accessibility Sizes) by the font scale React Native reports. */
const TEXT_SIZES: ReadonlyArray<readonly [scale: number, name: string]> = [
  [0.823, 'Extra Small'], [0.882, 'Small'], [0.941, 'Medium'], [1, 'Large (default)'], [1.118, 'Extra Large'],
  [1.235, 'Extra Extra Large'], [1.353, 'Extra Extra Extra Large'], [1.786, 'Accessibility Medium'],
  [2.143, 'Accessibility Large'], [2.643, 'Accessibility Extra Large'], [3.143, 'Accessibility Extra Extra Large'],
  [3.571, 'Accessibility Extra Extra Extra Large'],
];

/**
 * A key for views whose text must follow a change of text size while they are on screen. React Native
 * keeps the measurements of text it has already laid out, so after a change the bigger or smaller text is
 * drawn in its old box and cut off; a view keyed with this is laid out again at the new size. State held
 * above the keyed view survives.
 */
export function useRelayoutKey(): number {
  return useWindowDimensions().fontScale;
}

/** The accessibility text sizes (Larger Accessibility Sizes) start above this font scale; there layouts stack. */
const LARGE_TEXT_SCALE = 1.5;

/**
 * The iPhone's text size, following it as it changes: `scale` multiplies every font size, `name` is the
 * size's name in iPhone Settings, and `large` is true for the accessibility sizes, where side-by-side text no
 * longer fits.
 */
export function useTextSize() {
  const { fontScale } = useWindowDimensions();
  const [, name] = TEXT_SIZES.reduce((best, size) => (Math.abs(size[0] - fontScale) < Math.abs(best[0] - fontScale) ? size : best));
  return { scale: fontScale, name, large: fontScale >= LARGE_TEXT_SCALE };
}
