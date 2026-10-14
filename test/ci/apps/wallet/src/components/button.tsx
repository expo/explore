import { Pressable, StyleSheet, Text, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { Spinner } from '@/components/spinner';
import { colors, radius } from '@/theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'premium' | 'inverse' | 'ghostInverse';

/**
 * `accessibilityLabel` replaces the visible label for VoiceOver when the label alone does not say what
 * the button acts on, such as one of several Allow buttons on a screen.
 */
export function Button({ label, accessibilityLabel = label, onPress, variant = 'primary', disabled, loading, testID, style, compact }: {
  label: string; accessibilityLabel?: string; onPress?: () => void; variant?: Variant; disabled?: boolean; loading?: boolean; testID?: string; style?: StyleProp<ViewStyle>; compact?: boolean;
}) {
  const palette = palettes[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inactive, busy: loading }}
      testID={testID}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [styles.base, compact && styles.compact, { backgroundColor: palette.background, borderColor: palette.border }, pressed && styles.pressed, inactive && styles.disabled, style]}>
      {loading ? <Spinner color={palette.text} /> : null}
      <View style={loading ? styles.hiddenLabel : undefined}><Text style={[styles.label, compact && styles.compactLabel, { color: palette.text }]}>{label}</Text></View>
    </Pressable>
  );
}

const palettes: Record<Variant, { background: ColorValue; text: ColorValue; border: ColorValue }> = {
  primary: { background: colors.accent, text: colors.onAccent, border: colors.accent },
  secondary: { background: colors.surface, text: colors.ink, border: colors.line },
  ghost: { background: 'transparent', text: colors.ink, border: 'transparent' },
  danger: { background: colors.dangerSoft, text: colors.danger, border: colors.dangerSoft },
  premium: { background: colors.premium, text: colors.onAccent, border: colors.premium },
  // For the brand background, such as the welcome screen.
  inverse: { background: colors.onCard, text: colors.brand, border: colors.onCard },
  ghostInverse: { background: 'transparent', text: colors.onCard, border: 'transparent' },
};

const styles = StyleSheet.create({
  base: { minHeight: 52, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  compact: { minHeight: 40, paddingHorizontal: 14, borderRadius: radius.md },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.45 },
  hiddenLabel: { position: 'absolute', opacity: 0 },
  label: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  compactLabel: { fontSize: 14 },
});
