import { StyleSheet, Text, View } from 'react-native';
import { initialsOf } from '@/lib/format';
import { colors, GLYPH_MAX_SCALE } from '@/theme';

export function Avatar({ name, size = 44, tone = 'default' }: { name: string; size?: number; tone?: 'default' | 'accent' }) {
  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: tone === 'accent' ? colors.accent : colors.accentSoft }]}>
      <Text maxFontSizeMultiplier={GLYPH_MAX_SCALE} style={[styles.text, { fontSize: size * 0.38, color: tone === 'accent' ? colors.onAccent : colors.ink }]}>{initialsOf(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ circle: { alignItems: 'center', justifyContent: 'center' }, text: { fontWeight: '600' } });
