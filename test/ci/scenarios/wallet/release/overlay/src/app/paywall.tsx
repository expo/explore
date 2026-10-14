import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { SHORT_DELAY_MS, wait } from '@/fixtures/runtime';
import { formatMoney } from '@/lib/format';
import { entering } from '@/lib/motion';
import { goBack } from '@/lib/navigation';
import { PREMIUM_PRICES } from '@/store/rules';
import { useStore } from '@/store/store';
import type { BillingCycle } from '@/store/types';
import { colors, radius, space, text, TITLE_MAX_SCALE } from '@/theme';

const PERKS = ['No fees on transfers', 'Up to 5 virtual cards', 'Priority support'];

/** Premium paywall. Purchases are simulated on the device: Subscribe always succeeds, Restore finds nothing. */
export default function PaywallRoute() {
  const { hydrated, session, wallet, currency, subscribe } = useStore();
  const [restored, setRestored] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  const [phase, setPhase] = useState<'choose' | 'purchasing' | 'done'>('choose');
  // Outside the signed-in group, so this modal checks the session itself.
  if (!hydrated) return null;
  if (!session || !wallet) return <Redirect href="/auth/sign-in" />;

  const purchase = async () => {
    setPhase('purchasing');
    await wait(SHORT_DELAY_MS);
    subscribe(cycle);
    setPhase('done');
  };

  // A cold deep link opens this modal with nothing beneath it; closing it then goes Home.
  const dismiss = () => goBack(() => router.replace('/home'));
  // Subscription lives in the signed-in stack: close the modal first, so a second copy of that group
  // is not stacked over it.
  const manageSubscription = () => {
    if (!router.canDismiss()) { router.replace('/subscription'); return; }
    router.dismiss();
    router.push('/subscription');
  };
  const close = <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={dismiss} hitSlop={12}><Icon name="close" size={24} color={colors.ink} /></Pressable>;

  if (phase === 'done' || (wallet.plan === 'premium' && phase === 'choose')) {
    const welcome = phase === 'done';
    return (
      <Screen scroll={false} right={close}
        footer={<Button label={welcome ? 'Start using Premium' : 'Manage subscription'} testID="paywall-done"
          onPress={welcome ? dismiss : manageSubscription} />}>
        <Animated.View entering={entering(FadeInDown.duration(350))} style={styles.center}>
          <View style={styles.crown}><Icon name="sparkles" size={36} color={colors.premium} /></View>
          <Text style={[text.title, styles.centerText]} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{welcome ? 'Welcome to Premium' : 'You’re on Premium'}</Text>
          <Text style={[text.bodyMuted, styles.centerText]}>{welcome ? 'Fee-free transfers and extra cards are unlocked.' : 'Every Premium feature is already unlocked on your account.'}</Text>
        </Animated.View>
      </Screen>
    );
  }

  const saving = Math.round((1 - PREMIUM_PRICES.annual / (PREMIUM_PRICES.monthly * 12)) * 100);
  const Plan = ({ value, title, detail, badge }: { value: BillingCycle; title: string; detail: string; badge?: string }) => {
    const selected = cycle === value;
    return (
      <Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${title}, ${detail}`} onPress={() => setCycle(value)}
        style={[styles.plan, selected && styles.planSelected]}>
        <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
        <View style={styles.planTexts}>
          <Text style={text.heading}>{title}</Text>
          <Text style={text.caption}>{detail}</Text>
        </View>
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      </Pressable>
    );
  };

  return (
    <Screen right={close}
      footer={
        <>
          <Button label="Subscribe" variant="premium" testID="paywall-subscribe" onPress={purchase} loading={phase === 'purchasing'} />
          <Button label="Restore purchases" variant="ghost" onPress={() => setRestored(true)} testID="paywall-restore" />
        </>
      }>
      <View style={styles.header}>
        <View style={styles.crown}><Icon name="sparkles" size={32} color={colors.premium} /></View>
        <Text style={[text.title, styles.centerText]} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Wallet Premium</Text>
        <Text style={[text.bodyMuted, styles.centerText]}>Everything in Free, without the fees.</Text>
      </View>
      <View style={styles.perks}>
        {PERKS.map((perk) => (
          <View key={perk} style={styles.perk}>
            <Icon name="checkmark-circle" size={20} color={colors.premium} />
            <Text style={text.body}>{perk}</Text>
          </View>
        ))}
      </View>
      <Plan value="annual" title="Annual" detail={`${formatMoney(PREMIUM_PRICES.annual, currency)} per year · ${formatMoney(Math.round(PREMIUM_PRICES.annual / 12), currency)} a month`} badge={`Save ${saving}%`} />
      <Plan value="monthly" title="Monthly" detail={`${formatMoney(PREMIUM_PRICES.monthly, currency)} per month`} />
      {/* Inline, not a toast: toasts render under this native modal. */}
      {restored ? <Text style={[text.label, styles.centerText]} accessibilityLiveRegion="polite" testID="paywall-restore-result">No previous purchases to restore.</Text> : null}
      <Text style={[text.caption, styles.centerText]}>Renews automatically. Cancel anytime in Settings.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  crown: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.premiumSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  perks: { gap: space.md, paddingVertical: space.sm },
  perk: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  plan: { flexDirection: 'row', alignItems: 'center', gap: space.lg, padding: space.lg, borderRadius: radius.xl, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.surface },
  planSelected: { borderColor: colors.premium },
  planTexts: { flex: 1, gap: 2 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.premium },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.premium },
  badge: { fontSize: 12, fontWeight: '700', color: colors.onAccent, backgroundColor: colors.premium, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill, overflow: 'hidden' },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  centerText: { textAlign: 'center' },
});
