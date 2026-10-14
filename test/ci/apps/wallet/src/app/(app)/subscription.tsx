import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { PlanBadge } from '@/components/plan-badge';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { Sheet } from '@/components/sheet';
import { formatLongDate, formatMoney } from '@/lib/format';
import { PREMIUM_PRICES } from '@/store/rules';
import { useStore } from '@/store/store';
import { space, text } from '@/theme';

export default function SubscriptionRoute() {
  const { wallet, currency, switchCycle, cancelPlan } = useStore();
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  if (!wallet) return null;
  const premium = wallet.plan === 'premium';
  return (
    <Screen title="Subscription" backFallback={() => router.replace('/settings')}>
      {cancelled ? <Banner tone="success" title="Premium cancelled" body="You’re on the Free plan now. Your data and cards are unchanged." testID="subscription-cancelled" /> : null}
      <Card>
        <View style={styles.planHeader}>
          <Text style={text.heading}>{premium ? 'Wallet Premium' : 'Wallet Free'}</Text>
          <PlanBadge plan={wallet.plan} />
        </View>
        <Text style={text.bodyMuted}>
          {premium && wallet.cycle && wallet.renewsAt
            ? `${formatMoney(PREMIUM_PRICES[wallet.cycle], currency)} per ${wallet.cycle === 'annual' ? 'year' : 'month'} · renews ${formatLongDate(wallet.renewsAt)}`
            : 'Transfers cost 1% (at least 0.10). One virtual card.'}
        </Text>
      </Card>
      {premium ? (
        <>
          <View style={styles.section}>
            <Text style={text.overline}>Billing</Text>
            <RowGroup>
              <Row label="Monthly" detail={`${formatMoney(PREMIUM_PRICES.monthly, currency)} per month`} value={wallet.cycle === 'monthly' ? 'Current' : undefined}
                onPress={wallet.cycle === 'monthly' ? undefined : () => switchCycle('monthly')} />
              <Row label="Annual" detail={`${formatMoney(PREMIUM_PRICES.annual, currency)} per year`} value={wallet.cycle === 'annual' ? 'Current' : undefined}
                onPress={wallet.cycle === 'annual' ? undefined : () => switchCycle('annual')} />
            </RowGroup>
          </View>
          <Button label="Cancel Premium" variant="danger" testID="subscription-cancel" onPress={() => setCancelling(true)} />
        </>
      ) : (
        <Button label="Upgrade to Premium" variant="premium" testID="subscription-upgrade" onPress={() => router.push('/paywall')} />
      )}
      <Sheet visible={cancelling} onClose={() => setCancelling(false)} title="Cancel Premium?" testID="cancel-sheet">
        <Text style={text.bodyMuted}>You’ll move to the Free plan right away. Transfers will cost 1% again and extra cards stay frozen until you upgrade.</Text>
        <Button label="Cancel Premium" variant="danger" testID="cancel-confirm" onPress={() => { cancelPlan(); setCancelling(false); setCancelled(true); }} />
        <Button label="Keep Premium" variant="ghost" onPress={() => setCancelling(false)} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({ planHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: space.sm }, section: { gap: space.sm } });
