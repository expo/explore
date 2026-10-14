import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { Icon, type IconName } from '@/components/icon';
import { useTextSize } from '@/lib/accessibility';
import { colors, radius, space } from '@/theme';

type Tone = 'success' | 'danger' | 'premium' | 'info';
const palette: Record<Tone, { background: ColorValue; color: ColorValue; icon: IconName }> = {
  success: { background: colors.successSoft, color: colors.success, icon: 'checkmark-circle' },
  danger: { background: colors.dangerSoft, color: colors.danger, icon: 'alert-circle' },
  premium: { background: colors.premiumSoft, color: colors.premium, icon: 'sparkles' },
  info: { background: colors.accentSoft, color: colors.ink, icon: 'information-circle' },
};

export function Banner({ tone, title, body, onPress, actionLabel, testID }: { tone: Tone; title: string; body?: string; onPress?: () => void; actionLabel?: string; testID?: string }) {
  const { large } = useTextSize();
  const { background, color, icon } = palette[tone];
  // At the accessibility text sizes the action goes under the text instead of beside it.
  const action = onPress && actionLabel ? <Text style={[styles.action, { color }]}>{actionLabel}</Text> : null;
  const content = (
    <>
      <Icon name={icon} size={22} color={color} />
      <View style={styles.texts}>
        <Text style={[styles.title, { color }]}>{title}</Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
        {large ? action : null}
      </View>
      {large ? null : action}
    </>
  );
  if (!onPress) return <View style={[styles.banner, { backgroundColor: background }]} testID={testID} accessibilityLiveRegion="polite">{content}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}${actionLabel ? `, ${actionLabel}` : ''}`} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.banner, { backgroundColor: background }, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: radius.lg },
  pressed: { opacity: 0.85 },
  texts: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: '600' },
  body: { fontSize: 13, color: colors.muted },
  action: { fontSize: 14, fontWeight: '600' },
});
