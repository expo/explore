import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Screen } from '@/components/screen';
import { formatMoney } from '@/lib/format';
import { recipientFrom, recipientParams, type RecipientParams } from '@/lib/recipient';
import { feeFor } from '@/store/rules';
import { useStore } from '@/store/store';
import { colors, space, text } from '@/theme';

export default function ReviewRoute() {
  const { amount, ...params } = useLocalSearchParams<RecipientParams & { amount?: string }>();
  const { wallet, currency } = useStore();
  const recipient = recipientFrom(params);
  const cents = Number(amount);
  if (!wallet) return null;
  if (!recipient || !Number.isInteger(cents) || cents <= 0) {
    return (
      <Screen title="Transfer incomplete" subtitle="This transfer is missing a recipient or an amount." backFallback={() => router.replace('/send')}
        footer={<Button label="Start again" onPress={() => router.replace('/send')} />}>
        <View />
      </Screen>
    );
  }
  const fee = feeFor(wallet.plan, cents);
  const Line = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
    <View style={styles.line}>
      <Text style={strong ? text.heading : text.bodyMuted}>{label}</Text>
      <Text style={strong ? text.heading : text.body}>{value}</Text>
    </View>
  );
  return (
    <Screen title="Review transfer" backFallback={() => router.replace('/send')}
      footer={<Button label={`Send ${formatMoney(cents, currency)}`} testID="send-confirm"
        onPress={() => router.replace({ pathname: '/send/processing', params: { ...recipientParams(recipient), amount: String(cents) } })} />}>
      <View style={styles.recipient}>
        <Avatar name={recipient.name} size={56} />
        <Text style={text.heading}>{recipient.name}</Text>
        <Text style={text.caption}>{recipient.detail}</Text>
      </View>
      <Card>
        <Line label="Amount" value={formatMoney(cents, currency)} />
        <Line label="Fee" value={fee === 0 ? 'Free with Premium' : formatMoney(fee, currency)} />
        <View style={styles.divider} />
        <Line label="Total" value={formatMoney(cents + fee, currency)} strong />
      </Card>
      {fee > 0 ? <Banner tone="premium" title="Skip the fee" body="Premium members send money for free." actionLabel="See plans" onPress={() => router.push('/paywall')} /> : null}
      <Text style={[text.caption, styles.note]}>Transfers arrive instantly and can’t be cancelled once sent.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  recipient: { alignItems: 'center', gap: space.xs, marginBottom: space.sm },
  line: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: space.lg },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  note: { textAlign: 'center' },
});
