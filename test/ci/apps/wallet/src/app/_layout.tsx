import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '@/components/toast';
import { watchMemoryWarnings } from '@/lib/memory';
import { useOpenTappedAlerts } from '@/lib/notifications';
import { StoreProvider, useStore } from '@/store/store';
import { colors, hasDarkAppearance } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => { /* Already hidden. */ });

/**
 * Hides the native splash screen once the store has loaded. It sits beside `Routes`, not in it, so a
 * store update does not re-render the root stack: every re-render makes each native screen drop and
 * re-add its animation listeners, and with a single screen in the stack (a cold deep link) React Native
 * then logs "Sending `onAnimatedValueUpdate` with no listeners registered."
 */
function HideSplashScreen() {
  const { hydrated } = useStore();
  useEffect(() => { if (hydrated) SplashScreen.hideAsync().catch(() => { /* Already hidden. */ }); }, [hydrated]);
  return null;
}

/**
 * Applies Settings → Appearance to every window of the app; System hands the choice back to iOS. It
 * sits beside `Routes` for the same reason as `HideSplashScreen`, and before it, so a stored choice
 * is in place when the splash screen goes. Where the app is light only, it leaves the light style of
 * app.config.ts alone: 'unspecified' would hand the system bars back to the system's dark mode.
 */
function ApplyAppearance() {
  const { hydrated, appearance } = useStore();
  useEffect(() => {
    if (hydrated && hasDarkAppearance) Appearance.setColorScheme(appearance === 'system' ? 'unspecified' : appearance);
  }, [hydrated, appearance]);
  return null;
}

/** Opens the receipt of a tapped transaction alert. Beside `Routes` for the same reason as `HideSplashScreen`. */
function OpenTappedAlerts() {
  const { hydrated } = useStore();
  useOpenTappedAlerts(hydrated);
  return null;
}

/**
 * Gives cached card art and insights back when iOS runs low on memory, and records when, for Settings →
 * About → Diagnostics. Beside `Routes` for the same reason as `HideSplashScreen`.
 */
function WatchMemory() {
  useEffect(watchMemoryWarnings, []);
  return null;
}

/**
 * Navigator defaults (stack backgrounds, tab bar, headers) from the app's colors. The colors resolve
 * natively, so only `dark`, which native headers read, depends on the appearance.
 */
const navigationColors = { primary: colors.accent, background: colors.background, card: colors.surface, text: colors.ink, border: colors.line, notification: colors.danger };
const lightNavigationTheme = { ...DefaultTheme, colors: navigationColors };
const darkNavigationTheme = { ...DarkTheme, colors: navigationColors };

function NavigationTheme({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const dark = hasDarkAppearance && scheme === 'dark';
  return <ThemeProvider value={dark ? darkNavigationTheme : lightNavigationTheme}>{children}</ThemeProvider>;
}

function Routes() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="index" options={{ animation: 'fade' }} />
      <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
      <Stack.Screen name="auth" options={{ animation: 'fade' }} />
      <Stack.Screen name="(app)" options={{ animation: 'fade' }} />
      {/* Modals live in the root stack: a native modal inside a group stays on screen when navigation leaves
          that group. Full-screen, so a capture never shows whichever screen happened to be open beneath. */}
      <Stack.Screen name="topup" options={{ presentation: 'fullScreenModal' }} />
      <Stack.Screen name="paywall" options={{ presentation: 'fullScreenModal' }} />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StoreProvider>
          <ToastProvider>
            {/* Light content over a dark page on iOS in Dark Mode; dark content over the light-only screens elsewhere. */}
            <StatusBar style={hasDarkAppearance ? 'auto' : 'dark'} />
            <ApplyAppearance />
            <HideSplashScreen />
            <OpenTappedAlerts />
            <WatchMemory />
            <NavigationTheme>
              <Routes />
            </NavigationTheme>
          </ToastProvider>
        </StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
