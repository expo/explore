import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, Switch, Text, View } from 'react-native';
import { Banner } from '@/components/banner';
import { Logo } from '@/components/logo';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { useToast } from '@/components/toast';
import { formatMoney } from '@/lib/format';
import { useNotificationAccess } from '@/lib/notifications';
import { useStore } from '@/store/store';
import { colors, radius, space, text } from '@/theme';

/** The amount and recipient of the example alert. */
const EXAMPLE_AMOUNT = 2_500;
const EXAMPLE_RECIPIENT = 'Alex Rivera';

/**
 * Settings → Notifications. Transaction alerts is on when the wallet wants them and iOS allows Wallet's
 * notifications; turning it on asks iOS, only then. When iOS has them off, the screen says so and links to
 * Settings, and it follows a change made there as soon as the app is back.
 */
export default function NotificationsRoute() {
  const { wallet, currency, setNotifications } = useStore();
  const { access, request } = useNotificationAccess();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  if (!wallet) return null;
  const on = wallet.notifications && access === 'granted';

  const toggle = async (next: boolean) => {
    if (!next) { setNotifications(false); return; }
    setAsking(true);
    const answer = await request().catch(() => 'denied' as const);
    setAsking(false);
    setNotifications(answer === 'granted');
    if (answer === 'granted') toast('Transaction alerts on', 'success');
  };

  const example = `You sent ${formatMoney(EXAMPLE_AMOUNT, currency)} to ${EXAMPLE_RECIPIENT}.`;
  return (
    <Screen title="Notifications" subtitle="Choose what Wallet tells you about." backFallback={() => router.replace('/settings')}>
      {access === 'denied' ? (
        <Banner tone="danger" title="Notifications are off for Wallet" body="Turn on Allow Notifications in Settings to get transaction alerts."
          actionLabel="Settings" onPress={() => Linking.openSettings()} testID="notifications-settings" />
      ) : null}
      <RowGroup>
        <Row label="Transaction alerts" detail="A notification each time you send money, even while Wallet is open."
          right={<Switch accessibilityLabel="Transaction alerts" value={on || asking} disabled={asking} onValueChange={toggle} testID="notifications-transactions" />} />
      </RowGroup>
      <View style={styles.section}>
        <Text style={text.overline}>Preview</Text>
        <View style={[styles.alert, !on && styles.alertOff]} accessible accessibilityLabel={`Example alert: Money sent. ${example}`}>
          <View style={styles.icon}><Logo size={20} /></View>
          <View style={styles.texts}>
            <View style={styles.alertHeader}>
              <Text style={styles.alertTitle}>Money sent</Text>
              <Text style={text.caption}>now</Text>
            </View>
            <Text style={styles.alertBody}>{example}</Text>
          </View>
        </View>
        <Text style={text.caption}>Tap an alert to open the transfer’s receipt.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm, marginTop: space.sm },
  alert: { flexDirection: 'row', gap: space.md, alignItems: 'center', padding: space.md, borderRadius: radius.xl, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.line },
  alertOff: { opacity: 0.55 },
  icon: { width: 38, height: 38, borderRadius: 9, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, gap: 2 },
  alertHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: space.sm },
  alertTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  alertBody: { fontSize: 15, color: colors.ink },
});
