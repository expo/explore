import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { PROCESSING_DELAY_MS, wait } from '@/fixtures/runtime';
import { formatMoney, parseAmount } from '@/lib/format';
import { useTextSize } from '@/lib/accessibility';
import { entering } from '@/lib/motion';
import { goBack } from '@/lib/navigation';
import { useStore } from '@/store/store';
import { colors, radius, space, text, TITLE_MAX_SCALE } from '@/theme';

const PRESETS = [2_000, 5_000, 10_000];
type Phase = { kind: 'form' } | { kind: 'loading' } | { kind: 'success'; amount: number } | { kind: 'failure' };

/** Top-up modal with its loading, success and failure states inline. A top-up of exactly 13.00 is declined. */
export default function TopUpRoute() {
  const { hydrated, session, wallet, currency, topUp } = useStore();
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const { large } = useTextSize();
  const cents = parseAmount(input);
  // Outside the signed-in group, so this modal checks the session itself.
  if (!hydrated) return null;
  if (!session || !wallet) return <Redirect href="/auth/sign-in" />;

  const submit = async () => {
    if (cents === null) return;
    setPhase({ kind: 'loading' });
    await wait(PROCESSING_DELAY_MS);
    setPhase(topUp(cents).ok ? { kind: 'success', amount: cents } : { kind: 'failure' });
  };
  // A cold deep link opens this modal with nothing beneath it; closing it then goes Home.
  const close = () => goBack(() => router.replace('/home'));

  if (phase.kind === 'success' || phase.kind === 'failure') {
    const ok = phase.kind === 'success';
    return (
      <Screen scroll={false}
        footer={ok
          ? <Button label="Done" testID="topup-done" onPress={close} />
          : <>
              <Button label="Try again" testID="topup-retry" onPress={() => setPhase({ kind: 'form' })} />
              <Button label="Close" variant="ghost" onPress={close} />
            </>}>
        <Animated.View entering={entering(FadeIn.duration(250))} style={styles.result}>
          <View style={[styles.resultIcon, { backgroundColor: ok ? colors.successSoft : colors.dangerSoft }]}>
            <Icon name={ok ? 'checkmark' : 'close'} size={40} color={ok ? colors.success : colors.danger} />
          </View>
          <Text style={[text.title, styles.center]} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{ok ? 'Top up complete' : 'Card declined'}</Text>
          <Text style={[text.bodyMuted, styles.center]}>
            {ok ? `${formatMoney(phase.amount, currency)} was added to your wallet.` : 'Your card issuer declined this top up. Nothing was charged.'}
          </Text>
        </Animated.View>
      </Screen>
    );
  }

  return (
    <Screen title="Top up" subtitle={`Balance ${formatMoney(wallet.balance, currency)}`}
      right={<Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} hitSlop={12}><Icon name="close" size={24} color={colors.ink} /></Pressable>}>
      <Field label="Amount" testID="topup-amount" value={input} onChangeText={setInput} placeholder="0.00" keyboardType="decimal-pad" editable={phase.kind === 'form'} />
      <View style={[styles.presets, large && styles.stacked]}>
        {PRESETS.map((preset) => (
          <Pressable key={preset} accessibilityRole="button" accessibilityLabel={`Add ${formatMoney(preset, currency)}`} onPress={() => { Keyboard.dismiss(); setInput(String(preset / 100)); }}
            style={({ pressed }) => [styles.preset, large && styles.presetStacked, pressed && styles.pressed]}>
            <Text style={text.label}>{formatMoney(preset, currency)}</Text>
          </Pressable>
        ))}
      </View>
      {/* Inline, not pinned: the number pad has no return key and would cover a pinned button in this sheet. */}
      <Button label={cents ? `Add ${formatMoney(cents, currency)}` : 'Add money'} testID="topup-submit" onPress={() => { Keyboard.dismiss(); submit(); }} loading={phase.kind === 'loading'} disabled={cents === null} />
      <View style={styles.method}>
        <Icon name="card-outline" size={22} color={colors.ink} />
        <View style={styles.methodTexts}>
          <Text style={text.body}>Visa •••• 4242</Text>
          <Text style={text.caption}>Instant · No fee</Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  presets: { flexDirection: 'row', gap: space.sm },
  stacked: { flexDirection: 'column' },
  presetStacked: { flex: 0 },
  preset: { flex: 1, alignItems: 'center', paddingVertical: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  pressed: { opacity: 0.7 },
  method: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  methodTexts: { flex: 1, gap: 2 },
  result: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  resultIcon: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  center: { textAlign: 'center' },
});
