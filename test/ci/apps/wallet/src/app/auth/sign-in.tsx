import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, TextInput } from 'react-native';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Screen } from '@/components/screen';
import { useStore } from '@/store/store';

export default function SignInRoute() {
  const { signIn } = useStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const submit = async () => {
    Keyboard.dismiss();
    setBusy(true); setError(null);
    const result = await signIn({ email, password });
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <Screen title="Welcome back" subtitle="Sign in to continue to your wallet.">
      <Field label="Email" testID="auth-email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" textContentType="none" autoComplete="off" returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} />
      <Field ref={passwordRef} label="Password" testID="auth-password" value={password} onChangeText={setPassword} placeholder="Your password" secureTextEntry textContentType="oneTimeCode" autoComplete="off" returnKeyType="done" onSubmitEditing={submit} error={error} />
      <Button label="Sign in" testID="auth-submit" onPress={submit} loading={busy} disabled={!email || !password} />
      <Button label="Create an account" variant="ghost" onPress={() => router.push('/auth/sign-up')} />
    </Screen>
  );
}
