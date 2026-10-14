import { StyleSheet, TextInput, View } from 'react-native';
import { Icon } from '@/components/icon';
import { colors, radius, space } from '@/theme';

/** An iOS-style search bar: a magnifying glass, the query, and a clear button while typing. */
export function SearchField({ value, onChangeText, placeholder, testID }: { value: string; onChangeText: (text: string) => void; placeholder: string; testID?: string }) {
  return (
    <View style={styles.bar}>
      <Icon name="search" size={18} color={colors.muted} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.faint}
        accessibilityLabel={placeholder} accessibilityRole="search" testID={testID} style={styles.input}
        autoCapitalize="none" autoCorrect={false} returnKeyType="search" enablesReturnKeyAutomatically clearButtonMode="while-editing" />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44, paddingLeft: space.md, borderRadius: radius.md, backgroundColor: colors.accentSoft },
  input: { flex: 1, alignSelf: 'stretch', paddingVertical: space.sm, paddingRight: space.sm, fontSize: 16, color: colors.ink },
});
