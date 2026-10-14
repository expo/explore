import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Runs `callback` each time the app becomes active again: back from iPhone Settings, or after a
 * system prompt closes. Screens use it to re-read a permission that may have changed meanwhile.
 */
export function useOnActive(callback: () => void) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && previous !== 'active') latest.current();
      previous = next;
    });
    return () => subscription.remove();
  }, []);
}
