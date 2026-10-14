import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Keypad } from '@/components/keypad';
import { Screen } from '@/components/screen';
import { formatMoney, parseAmount } from '@/lib/format';
import { recipientFrom, recipientParams, type RecipientParams } from '@/lib/recipient';
import { useStore } from '@/store/store';
import { AMOUNT_MAX_SCALE, colors, space, text } from '@/theme';

export default function AmountRoute() {
  const params = useLocalSearchParams<RecipientParams>();
  const { wallet, currency } = useStore();
  const [input, setInput] = useState('');
  const recipient = recipientFrom(params);
  if (!wallet) return null;
  if (!recipient) {
    return (
      <Screen title="No recipient" subtitle="Pick someone to pay first." backFallback={() => router.replace('/send')}
        footer={<Button label="Choose recipient" onPress={() => router.replace('/send')} />}>
        <View />
      </Screen>
    );
  }
  const cents = parseAmount(input);
  const onKey = (key: string) => setInput((value) => {
    const next = value + key;
    if (key === '.' && value.includes('.')) return value;
    if (!/^\d{0,6}(\.\d{0,2})?$/.test(next) || next === '.') return value;
    return next === '0' ? value : next;
  });
  return (
    <Screen backFallback={() => router.replace('/send')} scroll={false}
      footer={<Button label="Review" testID="send-amount-continue" disabled={cents === null}
        onPress={() => cents !== null && router.push({ pathname: '/send/review', params: { ...recipientParams(recipient), amount: String(cents) } })} />}>
      <View style={styles.recipient}>
        <Avatar name={recipient.name} size={56} />
        <Text style={text.heading}>Send to {recipient.name}</Text>
        <Text style={text.caption}>Available {formatMoney(wallet.balance, currency)}</Text>
      </View>
      <View style={styles.display} testID="send-amount-input" accessibilityLabel={`Amount ${input ? formatMoney(cents ?? 0, currency) : 'empty'}`}>
        <Text style={[styles.amount, !input && styles.placeholder]} maxFontSizeMultiplier={AMOUNT_MAX_SCALE} numberOfLines={1} adjustsFontSizeToFit>{input ? `${formatMoney(0, currency).replace(/[\d.,]+/, '')}${input}` : formatMoney(0, currency)}</Text>
      </View>
      <Keypad onKey={onKey} onDelete={() => setInput((value) => value.slice(0, -1))} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  recipient: { alignItems: 'center', gap: space.sm, marginTop: space.md },
  display: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.lg },
  amount: { fontSize: 56, fontWeight: '700', letterSpacing: -1.5, color: colors.ink, fontVariant: ['tabular-nums'] },
  placeholder: { color: colors.faint },
});
