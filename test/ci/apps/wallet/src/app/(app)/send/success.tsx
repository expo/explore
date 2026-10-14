import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { formatDateTime, formatMoney } from '@/lib/format';
import { entering } from '@/lib/motion';
import { useStore } from '@/store/store';
import { AMOUNT_MAX_SCALE, colors, space, text, TITLE_MAX_SCALE } from '@/theme';

export default function SuccessRoute() {
  const { tx } = useLocalSearchParams<{ tx?: string }>();
  const { wallet, currency } = useStore();
  const transaction = wallet?.transactions.find((entry) => entry.id === tx);
  if (!wallet) return null;
  if (!transaction) {
    return (
      <Screen title="Receipt not found" subtitle="This transfer is not in your activity." footer={<Button label="Done" onPress={() => router.dismissTo('/home')} />}>
        <View />
      </Screen>
    );
  }
  // The wallet was debited amount + fee; the headline is what the recipient got.
  const sent = -transaction.amount - transaction.fee;
  return (
    <Screen scroll={false}
      footer={
        <>
          <Button label="Done" testID="send-done" onPress={() => router.dismissTo('/home')} />
          <Button label="View receipt" variant="ghost" onPress={() => router.push({ pathname: '/transactions/[id]', params: { id: transaction.id } })} />
        </>
      }>
      <View style={styles.hero}>
        <Animated.View entering={entering(ZoomIn.springify().damping(14))} style={styles.badge}>
          <Icon name="checkmark" size={44} color={colors.success} />
        </Animated.View>
        <Text style={[text.title, styles.center]} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Money sent</Text>
        <Text style={styles.amount} maxFontSizeMultiplier={AMOUNT_MAX_SCALE} numberOfLines={1} adjustsFontSizeToFit>{formatMoney(sent, currency)}</Text>
        <Text style={[text.bodyMuted, styles.center]}>to {transaction.counterparty}</Text>
      </View>
      <Card>
        <View style={styles.line}><Text style={text.bodyMuted}>Fee</Text><Text style={text.body}>{transaction.fee ? formatMoney(transaction.fee, currency) : 'Free'}</Text></View>
        <View style={styles.line}><Text style={text.bodyMuted}>Reference</Text><Text style={text.body}>{transaction.reference}</Text></View>
        <View style={styles.line}><Text style={text.bodyMuted}>Date</Text><Text style={text.body}>{formatDateTime(transaction.at)}</Text></View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.sm, marginTop: space.xxl, marginBottom: space.xl },
  badge: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.successSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space.md },
  amount: { fontSize: 40, fontWeight: '700', letterSpacing: -1.2, color: colors.ink, fontVariant: ['tabular-nums'] },
  center: { textAlign: 'center' },
  line: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: space.lg },
});
