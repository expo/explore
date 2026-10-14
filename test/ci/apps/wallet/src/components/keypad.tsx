import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/icon';
import { colors, GLYPH_MAX_SCALE, radius } from '@/theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'delete'] as const;

export function Keypad({ onKey, onDelete }: { onKey: (key: string) => void; onDelete: () => void }) {
  return (
    <View style={styles.grid} accessibilityLabel="Amount keypad">
      {KEYS.map((key) => (
        <Pressable key={key} accessibilityRole="button" accessibilityLabel={key === 'delete' ? 'Delete' : key === '.' ? 'Decimal point' : key}
          onPress={() => (key === 'delete' ? onDelete() : onKey(key))} style={({ pressed }) => [styles.key, pressed && styles.pressed]}>
          {key === 'delete' ? <Icon name="backspace-outline" size={24} color={colors.ink} /> : <Text style={styles.label} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>{key}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  key: { width: '33.33%', minHeight: 60, alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg },
  pressed: { backgroundColor: colors.accentSoft },
  label: { fontSize: 26, fontWeight: '500', color: colors.ink },
});
