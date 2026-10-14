import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Avatar } from '@/components/avatar';
import { Balance } from '@/components/balance';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { PlanBadge } from '@/components/plan-badge';
import { Screen } from '@/components/screen';
import { TransactionRow } from '@/components/transaction-row';
import { useTextSize } from '@/lib/accessibility';
import { entering } from '@/lib/motion';
import { useStore } from '@/store/store';
import { colors, radius, space, text } from '@/theme';

const ACTIONS = [
  { label: 'Send', icon: 'arrow-up' as const, open: () => router.push('/send') },
  { label: 'Top up', icon: 'add' as const, open: () => router.push('/topup') },
  { label: 'Cards', icon: 'card-outline' as const, open: () => router.navigate('/cards') },
  { label: 'ATMs', icon: 'location-outline' as const, open: () => router.push('/atms') },
];

export default function HomeRoute() {
  const { session, wallet, currency } = useStore();
  const { large } = useTextSize();
  if (!session || !wallet) return null;
  const firstName = session.name.split(' ')[0];
  return (
    <Screen>
      {/* At the accessibility text sizes the greeting gets a line of its own, under the avatar and plan. */}
      <View style={[styles.header, large && styles.headerStacked]}>
        {large ? (
          <View style={styles.headerRow}>
            <Avatar name={session.name} />
            <PlanBadge plan={wallet.plan} />
          </View>
        ) : <Avatar name={session.name} />}
        <View style={styles.greeting}>
          <Text style={text.caption}>Welcome back</Text>
          <Text style={text.heading}>Hi, {firstName}</Text>
        </View>
        {large ? null : <PlanBadge plan={wallet.plan} />}
      </View>

      <Animated.View entering={entering(FadeInDown.duration(400))}>
        <Card tone="accent" style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Total balance</Text>
          <Balance cents={wallet.balance} currency={currency} />
          <Text style={styles.balanceMeta}>{currency} · Wallet {wallet.plan === 'premium' ? 'Premium' : 'Free'}</Text>
        </Card>
      </Animated.View>

      {/* Four across, or two by two at the accessibility text sizes. */}
      <View style={[styles.actions, large && styles.actionsGrid]}>
        {ACTIONS.map((action) => (
          <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} onPress={action.open}
            style={({ pressed }) => [styles.action, large && styles.actionHalf, pressed && styles.pressed]}>
            <View style={styles.actionIcon}><Icon name={action.icon} size={22} color={colors.ink} /></View>
            <Text style={text.label}>{action.label}</Text>
          </Pressable>
        ))}
      </View>

      {wallet.plan === 'free' ? (
        <Banner tone="premium" title="Go Premium" body="No transfer fees and up to 5 virtual cards." actionLabel="Upgrade" onPress={() => router.push('/paywall')} testID="home-upsell" />
      ) : null}

      <View style={styles.sectionHeader}>
        <Text style={text.heading}>Recent activity</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="See all activity" onPress={() => router.navigate('/activity')} hitSlop={8}>
          <Text style={styles.link}>See all</Text>
        </Pressable>
      </View>
      <Card>
        {wallet.transactions.slice(0, 4).map((transaction, index, list) => (
          <TransactionRow key={transaction.id} transaction={transaction} currency={currency} last={index === list.length - 1}
            onPress={() => router.push({ pathname: '/transactions/[id]', params: { id: transaction.id } })} />
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headerStacked: { flexDirection: 'column', alignItems: 'stretch' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  greeting: { flex: 1 },
  balanceCard: { paddingVertical: space.xl, gap: space.sm },
  balanceLabel: { color: colors.onCardMuted, fontSize: 14 },
  balanceMeta: { color: colors.onCardFaint, fontSize: 13 },
  actions: { flexDirection: 'row', gap: space.md },
  actionsGrid: { flexWrap: 'wrap' },
  actionHalf: { flexBasis: '40%' },
  action: { flex: 1, alignItems: 'center', gap: space.sm, paddingVertical: space.lg, backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line },
  actionIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
  sectionHeader: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: space.md, marginTop: space.sm },
  link: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
