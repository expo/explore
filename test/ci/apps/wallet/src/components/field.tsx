import { forwardRef } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, radius, space, text } from '@/theme';

export const Field = forwardRef<TextInput, TextInputProps & { label: string; error?: string | null; hint?: string }>(function Field({ label, error, hint, style, ...input }, ref) {
  return (
    <View style={styles.wrapper}>
      <Text style={text.label}>{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor={colors.faint}
        autoCorrect={false}
        style={[styles.input, error ? styles.inputError : null, style]}
        {...input}
      />
      {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : hint ? <Text style={text.caption}>{hint}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { gap: space.sm },
  input: { minHeight: 52, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: space.lg, fontSize: 16, color: colors.ink },
  inputError: { borderColor: colors.danger },
  error: { fontSize: 13, color: colors.danger },
});
