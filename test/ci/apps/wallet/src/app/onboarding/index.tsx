import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Button } from '@/components/button';
import { Logo } from '@/components/logo';
import { Screen } from '@/components/screen';
import { LightStatusBar } from '@/components/status-bar';
import { entering } from '@/lib/motion';
import { colors, space, text, TITLE_MAX_SCALE } from '@/theme';

export default function WelcomeRoute() {
  return (
    <Screen
      scroll={false}
      background={colors.brand}
      footer={
        <>
          <Button label="Get started" testID="onboarding-start" variant="inverse" onPress={() => router.push('/onboarding/features')} />
          <Button label="I already have an account" variant="ghostInverse" onPress={() => router.push('/auth/sign-in')} />
        </>
      }>
      <LightStatusBar />
      <View style={styles.hero}>
        <Animated.View entering={entering(FadeInDown.duration(500))}>
          <Logo size={120} />
        </Animated.View>
        <Animated.View entering={entering(FadeInDown.delay(150).duration(500))} style={styles.texts}>
          <Text style={styles.title} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Your money,{'\n'}in one place</Text>
          <Text style={styles.body}>Send, receive and top up in seconds. No branches, no paperwork, no surprises.</Text>
        </Animated.View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexGrow: 1, justifyContent: 'center', gap: space.xxl, paddingBottom: space.xxl },
  texts: { gap: space.md },
  title: { ...text.hero, color: colors.onCard },
  body: { ...text.body, color: colors.onCardMuted },
});
