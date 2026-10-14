import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { entering } from '@/lib/motion';
import { colors, radius, space, text } from '@/theme';

const FEATURES: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'paper-plane-outline', title: 'Instant transfers', body: 'Send money to anyone in your contacts. It arrives before you can put your phone down.' },
  { icon: 'card-outline', title: 'Virtual cards', body: 'Create a card for online purchases and freeze it with one tap whenever you like.' },
  { icon: 'shield-checkmark-outline', title: 'Built-in safety', body: 'Every transfer is reviewed before it leaves your wallet, and you can undo mistakes.' },
];

export default function FeaturesRoute() {
  return (
    <Screen title="Everything you need" subtitle="Three things Wallet does really well." backFallback={() => router.replace('/onboarding')}
      footer={<Button label="Continue" testID="features-continue" onPress={() => router.push('/onboarding/currency')} />}>
      {FEATURES.map((feature, index) => (
        <Animated.View key={feature.title} entering={entering(FadeInDown.delay(120 * index).duration(450))} style={styles.feature}>
          <View style={styles.icon}><Icon name={feature.icon} size={22} color={colors.ink} /></View>
          <View style={styles.texts}>
            <Text style={text.heading}>{feature.title}</Text>
            <Text style={text.bodyMuted}>{feature.body}</Text>
          </View>
        </Animated.View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  feature: { flexDirection: 'row', gap: space.lg, alignItems: 'flex-start', backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, padding: space.lg },
  icon: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, gap: 4 },
});
