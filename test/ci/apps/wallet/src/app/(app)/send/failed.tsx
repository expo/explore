import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { formatMoney } from '@/lib/format';
import { entering } from '@/lib/motion';
import { recipientFrom, type RecipientParams } from '@/lib/recipient';
import { failureMessage } from '@/store/rules';
import { useStore } from '@/store/store';
import { colors, space, text, TITLE_MAX_SCALE } from '@/theme';

export default function FailedRoute() {
  const { reason, amount, ...params } = useLocalSearchParams<RecipientParams & { reason?: string; amount?: string }>();
  const { currency } = useStore();
  const message = failureMessage(reason);
  const recipient = recipientFrom(params);
  const cents = Number(amount);
  const insufficient = reason === 'insufficient';
  return (
    <Screen scroll={false}
      footer={
        <>
          {insufficient
            ? <Button label="Top up wallet" testID="failed-top-up" onPress={() => router.push('/topup')} />
            : <Button label="Try another recipient" testID="failed-retry" onPress={() => router.dismissTo('/send')} />}
          <Button label="Back to home" variant="ghost" onPress={() => router.dismissTo('/home')} />
        </>
      }>
      <View style={styles.hero}>
        <Animated.View entering={entering(ZoomIn.springify().damping(14))} style={styles.badge}>
          <Icon name="close" size={44} color={colors.danger} />
        </Animated.View>
        <Text style={[text.title, styles.body]} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{message.title}</Text>
        <Text style={[text.bodyMuted, styles.body]}>{message.body}</Text>
        {recipient && Number.isInteger(cents) && cents > 0 ? (
          <View style={styles.summary}>
            <Text style={text.caption}>Attempted</Text>
            <Text style={[text.heading, styles.body]}>{formatMoney(cents, currency)} to {recipient.name}</Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.sm, marginTop: space.xxl },
  badge: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.dangerSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space.md },
  body: { textAlign: 'center' },
  summary: { alignItems: 'center', gap: 2, marginTop: space.xl, paddingVertical: space.lg, paddingHorizontal: space.xl, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
});
