import { router } from 'expo-router';

/**
 * Goes back through the navigation history. A screen opened by a cold deep link has none, so
 * `fallback` runs instead; it should replace the screen with its parent. Callers pass a literal
 * router call, such as `() => router.replace('/settings')`, so static route analysis still sees
 * every destination.
 */
export function goBack(fallback: () => void) {
  if (router.canGoBack()) router.back();
  else fallback();
}
