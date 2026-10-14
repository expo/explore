import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '@/components/icon';
import { useTextSize } from '@/lib/accessibility';
import { formatMoney } from '@/lib/format';
import type { Currency, Transaction } from '@/store/types';
import { colors, space, text } from '@/theme';

const icons: Record<Transaction['kind'], IconName> = { sent: 'arrow-up', received: 'arrow-down', topup: 'add', subscription: 'sparkles' };

/**
 * One transaction in a list: what, with whom, and the amount. At the accessibility text sizes the names
 * wrap and the amount moves under them, so nothing is cut short.
 */
export function TransactionRow({ transaction, currency, onPress, last }: { transaction: Transaction; currency: Currency; onPress: () => void; last?: boolean }) {
  const { large } = useTextSize();
  const incoming = transaction.amount > 0;
  const lines = large ? undefined : 1;
  const amount = <Text style={[styles.amount, incoming && styles.amountIn]}>{formatMoney(transaction.amount, currency, { sign: true })}</Text>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${transaction.title}, ${formatMoney(transaction.amount, currency, { sign: true })}`} onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.divider, pressed && styles.pressed]}>
      <View style={[styles.icon, incoming && styles.iconIn]}>
        <Icon name={icons[transaction.kind]} size={18} color={incoming ? colors.success : colors.ink} />
      </View>
      <View style={styles.texts}>
        <Text style={text.body} numberOfLines={lines}>{transaction.title}</Text>
        <Text style={text.caption} numberOfLines={lines}>{transaction.counterparty}</Text>
        {large ? amount : null}
      </View>
      {large ? null : amount}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.7 },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  iconIn: { backgroundColor: colors.successSoft },
  texts: { flex: 1, gap: 2 },
  amount: { fontSize: 16, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  amountIn: { color: colors.success },
});
