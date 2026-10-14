import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Screen } from '@/components/screen';
import { useStore } from '@/store/store';
import { colors, space, text } from '@/theme';

export default function SignUpRoute() {
  const { signUp } = useStore();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const submit = async () => {
    Keyboard.dismiss();
    setBusy(true); setError(null);
    const result = await signUp({ name, email, password });
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <Screen title="Create your account" subtitle="It takes less than a minute." backFallback={() => router.replace('/auth/sign-in')}>
      <Field label="Full name" testID="auth-name" value={name} onChangeText={setName} placeholder="Your full name" autoCapitalize="words" textContentType="none" autoComplete="off" returnKeyType="next" onSubmitEditing={() => emailRef.current?.focus()} />
      <Field ref={emailRef} label="Email" testID="auth-email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" textContentType="none" autoComplete="off" returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} />
      <Field ref={passwordRef} label="Password" testID="auth-password" value={password} onChangeText={setPassword} placeholder="At least 8 characters" secureTextEntry textContentType="oneTimeCode" autoComplete="off" returnKeyType="done" onSubmitEditing={submit} error={error} />
      <Button label="Create account" testID="auth-submit" onPress={submit} loading={busy} disabled={!name || !email || !password} />
      <Button label="I already have an account" variant="ghost" onPress={() => router.dismissTo('/auth/sign-in')} />
      <View style={styles.note}>
        <Text style={text.caption}>Accounts live only on this device. By continuing you agree to the <Text style={styles.link}>Terms</Text> and <Text style={styles.link}>Privacy Policy</Text>.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ note: { marginTop: space.sm }, link: { color: colors.ink, fontWeight: '600' } });
