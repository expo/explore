import { router } from 'expo-router';
import { useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { SHORT_DELAY_MS, wait } from '@/fixtures/runtime';
import { goBack } from '@/lib/navigation';
import { colors, space, text, TITLE_MAX_SCALE } from '@/theme';

/** Password reset. Local accounts have no mail server, so any valid address gets the same confirmation. */
export default function ForgotPasswordRoute() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'sending' | 'sent'>('form');

  const submit = async () => {
    Keyboard.dismiss();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter a valid email address.'); return; }
    setError(null); setPhase('sending');
    await wait(SHORT_DELAY_MS);
    setPhase('sent');
  };

  // Sign-in pushes this screen; a cold deep link has no history, so both Back controls fall back to sign-in.
  const backToSignIn = () => router.replace('/auth/sign-in');

  if (phase === 'sent') {
    return (
      <Screen backFallback={backToSignIn}>
        <View style={styles.sent}>
          <View style={styles.badge}><Icon name="mail-outline" size={32} color={colors.success} /></View>
          <Text style={text.title} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Check your email</Text>
          <Text style={[text.bodyMuted, styles.center]}>If an account uses {email.trim().toLowerCase()}, a reset link is on its way.</Text>
        </View>
        <Button label="Back to sign in" testID="reset-done" onPress={() => goBack(backToSignIn)} />
      </Screen>
    );
  }

  return (
    <Screen title="Reset your password" subtitle="We’ll email you a link to choose a new one." backFallback={backToSignIn}>
      <Field label="Email" testID="reset-email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none"
        keyboardType="email-address" textContentType="none" autoComplete="off" returnKeyType="send" onSubmitEditing={submit} error={error} />
      <Button label="Send reset link" testID="reset-submit" onPress={submit} loading={phase === 'sending'} disabled={!email} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sent: { alignItems: 'center', gap: space.md, marginTop: space.xxl, marginBottom: space.xl },
  badge: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.successSoft, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  center: { textAlign: 'center' },
});
