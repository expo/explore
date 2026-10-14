import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '@/components/icon';
import { useTextSize } from '@/lib/accessibility';
import { colors, space, text } from '@/theme';

/**
 * A settings-style row. With `onPress` it is a button, otherwise static text. At the accessibility text
 * sizes the value and the `right` control move under the label, as in iPhone Settings, so neither squeezes
 * the label into a narrow column.
 */
export function Row({ label, value, detail, onPress, right, tone = 'default', testID, style }: {
  label: string; value?: string; detail?: string; onPress?: () => void; right?: ReactNode; tone?: 'default' | 'danger' | 'premium'; testID?: string; style?: StyleProp<ViewStyle>;
}) {
  const { large } = useTextSize();
  const labelColor = tone === 'danger' ? colors.danger : tone === 'premium' ? colors.premium : colors.ink;
  const trailing = (
    <>
      {value ? <Text style={[text.bodyMuted, large ? styles.stackedValue : styles.value]}>{value}</Text> : null}
      {right}
    </>
  );
  const content = (
    <>
      <View style={styles.texts}>
        <Text style={[text.body, { color: labelColor }]}>{label}</Text>
        {detail ? <Text style={text.caption}>{detail}</Text> : null}
        {large && (value || right) ? <View style={styles.stacked}>{trailing}</View> : null}
      </View>
      {large ? null : trailing}
      {onPress ? <Icon name="chevron-forward" size={18} color={colors.faint} /> : null}
    </>
  );
  if (!onPress) return <View style={[styles.row, large && styles.rowWide, style]} testID={testID}>{content}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label} testID={testID} onPress={onPress}
      style={({ pressed }) => [styles.row, large && styles.rowWide, pressed && styles.pressed, style]}>
      {content}
    </Pressable>
  );
}

export function RowGroup({ children }: { children: ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

const styles = StyleSheet.create({
  group: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowWide: { paddingHorizontal: space.md },
  pressed: { backgroundColor: colors.background },
  texts: { flex: 1, gap: 2 },
  // A long value wraps within its share of the row instead of pushing the label aside.
  value: { flexShrink: 1, maxWidth: '55%', textAlign: 'right' },
  stacked: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md, marginTop: space.xs },
  stackedValue: { flexShrink: 1 },
});
