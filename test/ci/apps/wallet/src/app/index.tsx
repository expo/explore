import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, useSharedValue, withTiming } from 'react-native-reanimated';
import { Logo } from '@/components/logo';
import { LightStatusBar } from '@/components/status-bar';
import { useRelayoutKey } from '@/lib/accessibility';
import { entering, useMotion } from '@/lib/motion';
import { useStore } from '@/store/store';
import { colors, TITLE_MAX_SCALE } from '@/theme';

const FILL_MS = 1400;

/**
 * Launch screen: the mark fills while the store hydrates, then the app moves on to home, onboarding
 * or sign-in. `?hold=true` keeps this screen on display so it can be captured.
 */
export default function SplashRoute() {
  const { hold } = useLocalSearchParams<{ hold?: string }>();
  const { hydrated, onboarded, session } = useStore();
  const motion = useMotion();
  const relayout = useRelayoutKey();
  const fill = useSharedValue(motion ? 0 : 1);

  // Without motion (or once Reduce Motion is known to be on) the mark is simply full.
  useEffect(() => { fill.value = motion ? withTiming(1, { duration: FILL_MS, easing: Easing.out(Easing.cubic) }) : 1; }, [fill, motion]);

  // Only while focused: a deep link opened during launch covers the splash and its blur cancels the
  // timer, and going back to the splash later starts it again. A signed-in account goes home even
  // if it skipped onboarding through "I already have an account".
  useFocusEffect(useCallback(() => {
    if (hold === 'true' || !hydrated) return;
    const timer = setTimeout(() => {
      if (session) router.replace('/home');
      else if (!onboarded) router.replace('/onboarding');
      else router.replace('/auth/sign-in');
    }, FILL_MS + 200);
    return () => clearTimeout(timer);
  }, [hold, hydrated, onboarded, session]));

  return (
    <View style={styles.root} testID="splash">
      <LightStatusBar />
      <Logo size={112} fill={fill} />
      <Animated.View key={relayout} entering={entering(FadeIn.delay(600).duration(500))} style={styles.texts}>
        <Text style={styles.wordmark} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Wallet</Text>
        <Text style={styles.tagline} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Money, minus the friction</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center', gap: 28 },
  texts: { alignItems: 'center', gap: 6 },
  wordmark: { color: colors.onCard, fontSize: 30, fontWeight: '700', letterSpacing: -0.6 },
  tagline: { color: colors.onCardMuted, fontSize: 15 },
});
