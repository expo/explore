import { StyleSheet, Text, View } from 'react-native';
import type { Plan } from '@/store/types';
import { colors, radius, TITLE_MAX_SCALE } from '@/theme';

export function PlanBadge({ plan }: { plan: Plan }) {
  const premium = plan === 'premium';
  return (
    <View style={[styles.badge, { backgroundColor: premium ? colors.premiumSoft : colors.accentSoft }]} accessibilityLabel={premium ? 'Premium plan' : 'Free plan'}>
      <Text maxFontSizeMultiplier={TITLE_MAX_SCALE} style={[styles.text, { color: premium ? colors.premium : colors.muted }]}>{premium ? 'Premium' : 'Free'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill }, text: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' } });
