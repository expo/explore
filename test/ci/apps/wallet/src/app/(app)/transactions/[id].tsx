import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { TransactionActions } from '@/components/transaction-actions';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useStore } from '@/store/store';
import { AMOUNT_MAX_SCALE, colors, space, text } from '@/theme';

const KIND_LABEL = { sent: 'Transfer', received: 'Incoming payment', topup: 'Top up', subscription: 'Subscription' } as const;

export default function TransactionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { wallet, currency } = useStore();
  const transaction = wallet?.transactions.find((entry) => entry.id === id);
  if (!wallet) return null;
  if (!transaction) {
    return <Screen title="Transaction not found" subtitle="It may have been removed from your activity."
      backFallback={() => router.replace('/activity')}><View /></Screen>;
  }
  const incoming = transaction.amount > 0;
  const details: Array<[string, string]> = [
    ['Status', transaction.status === 'completed' ? 'Completed' : 'Failed'],
    ['Type', KIND_LABEL[transaction.kind]],
    ['Date', formatDateTime(transaction.at)],
    ['Fee', transaction.fee ? formatMoney(transaction.fee, currency) : 'None'],
    ['Reference', transaction.reference],
  ];
  return (
    <>
      {/* The bottom toolbar is part of this screen's safe area, which only a provider inside the screen sees. */}
      <SafeAreaProvider>
        <Screen backFallback={() => router.replace('/activity')}>
          <View style={styles.hero}>
            <View style={[styles.icon, incoming && styles.iconIn]}>
              <Icon name={incoming ? 'arrow-down' : 'arrow-up'} size={26} color={incoming ? colors.success : colors.ink} />
            </View>
            <Text style={[styles.amount, incoming && styles.amountIn]} maxFontSizeMultiplier={AMOUNT_MAX_SCALE} numberOfLines={1} adjustsFontSizeToFit>{formatMoney(transaction.amount, currency, { sign: true })}</Text>
            <Text style={text.heading}>{transaction.title}</Text>
            <Text style={text.bodyMuted}>{transaction.counterparty}</Text>
          </View>
          <Card>
            {details.map(([label, value]) => (
              <View key={label} style={styles.line}>
                <Text style={text.bodyMuted}>{label}</Text>
                <Text style={text.body}>{value}</Text>
              </View>
            ))}
          </Card>
        </Screen>
      </SafeAreaProvider>
      <TransactionActions transaction={transaction} currency={currency} />
    </>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.xs, marginTop: space.md, marginBottom: space.md },
  icon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  iconIn: { backgroundColor: colors.successSoft },
  amount: { fontSize: 36, fontWeight: '700', letterSpacing: -1, color: colors.ink, fontVariant: ['tabular-nums'] },
  amountIn: { color: colors.success },
  line: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: space.lg },
});
