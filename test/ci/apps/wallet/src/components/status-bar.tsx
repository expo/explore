import { useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

/** Light status bar content while this brand-background screen is focused; other screens follow the appearance. */
export function LightStatusBar() {
  return useIsFocused() ? <StatusBar style="light" /> : null;
}
