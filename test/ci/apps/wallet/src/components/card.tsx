import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radius, space } from '@/theme';

type Tone = 'default' | 'muted' | 'accent' | 'premium' | 'success' | 'danger';

export function Card({ children, tone = 'default', style, testID }: { children: ReactNode; tone?: Tone; style?: StyleProp<ViewStyle>; testID?: string }) {
  return <View testID={testID} style={[styles.card, tones[tone], style]}>{children}</View>;
}

const tones: Record<Tone, ViewStyle> = {
  default: { backgroundColor: colors.surface, borderColor: colors.line },
  muted: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  accent: { backgroundColor: colors.card, borderColor: colors.cardLine },
  premium: { backgroundColor: colors.premiumSoft, borderColor: colors.premiumSoft },
  success: { backgroundColor: colors.successSoft, borderColor: colors.successSoft },
  danger: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerSoft },
};

const styles = StyleSheet.create({ card: { borderRadius: radius.xl, borderWidth: 1, padding: space.lg, gap: space.md } });
