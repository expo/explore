import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { useStore } from '@/store/store';
import type { Currency } from '@/store/types';
import { colors, GLYPH_MAX_SCALE, radius, space, text } from '@/theme';

const CURRENCIES: Array<{ code: Currency; name: string; symbol: string }> = [
  { code: 'USD', name: 'US dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British pound', symbol: '£' },
];

export default function CurrencyRoute() {
  const { completeOnboarding } = useStore();
  const [currency, setCurrency] = useState<Currency>('USD');
  return (
    <Screen title="Pick your currency" subtitle="Balances and transfers are shown in this currency. You can’t change it later."
      backFallback={() => router.replace('/onboarding')}
      footer={<Button label="Continue" testID="currency-continue" onPress={() => { completeOnboarding(currency); router.push('/auth/sign-up'); }} />}>
      <View style={styles.list}>
        {CURRENCIES.map((option) => {
          const selected = option.code === currency;
          return (
            <Pressable key={option.code} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${option.name}, ${option.code}`}
              onPress={() => setCurrency(option.code)} style={[styles.option, selected && styles.optionSelected]}>
              <View style={styles.symbol}><Text style={styles.symbolText} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>{option.symbol}</Text></View>
              <View style={styles.texts}>
                <Text style={text.heading}>{option.name}</Text>
                <Text style={text.caption}>{option.code}</Text>
              </View>
              {selected ? <Icon name="checkmark-circle" size={24} color={colors.ink} /> : <View style={styles.radio} />}
            </Pressable>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.md },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.lg, padding: space.lg, backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1.5, borderColor: colors.line },
  optionSelected: { borderColor: colors.ink },
  symbol: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  symbolText: { fontSize: 20, fontWeight: '600', color: colors.ink },
  texts: { flex: 1, gap: 2 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.line },
});
