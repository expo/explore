import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { PROCESSING_DELAY_MS, wait } from '@/fixtures/runtime';
import { formatMoney } from '@/lib/format';
import { useStore } from '@/store/store';
import { colors, radius, space, text } from '@/theme';

const CONSEQUENCES = ['Your balance and cards are closed', 'Your activity history is erased', 'Premium ends without a refund'];

/** Account deletion: type DELETE, confirm in an alert, then the account and its data are removed. */
export default function DeleteAccountRoute() {
  const { wallet, currency, deleteAccount } = useStore();
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  if (!wallet) return null;
  const confirmed = confirmation.trim().toUpperCase() === 'DELETE';

  const remove = () => Alert.alert('Delete account permanently?', 'This can’t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Yes, delete', style: 'destructive', onPress: async () => { setDeleting(true); await wait(PROCESSING_DELAY_MS); deleteAccount(); } },
  ]);

  return (
    <Screen title="Delete account" subtitle="We’re sorry to see you go." backFallback={() => router.replace('/account')}>
      <View style={styles.warning}>
        <Icon name="warning-outline" size={22} color={colors.danger} />
        <Text style={[text.body, styles.warningText]}>Deleting your account closes your wallet with {formatMoney(wallet.balance, currency)}. Move your money out first.</Text>
      </View>
      <View style={styles.list}>
        {CONSEQUENCES.map((item) => (
          <View key={item} style={styles.item}>
            <Icon name="close-circle-outline" size={20} color={colors.muted} />
            <Text style={text.body}>{item}</Text>
          </View>
        ))}
      </View>
      <Field label="Type DELETE to confirm" value={confirmation} onChangeText={setConfirmation} autoCapitalize="characters" placeholder="DELETE" testID="delete-account-input" editable={!deleting} />
      <Button label="Delete account" variant="danger" testID="delete-account-confirm" disabled={!confirmed} loading={deleting} onPress={remove} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  warning: { flexDirection: 'row', gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.dangerSoft },
  warningText: { flex: 1, color: colors.danger },
  list: { gap: space.md },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
