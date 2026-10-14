import { Redirect, Stack } from 'expo-router';
import { useStore } from '@/store/store';
import { colors } from '@/theme';

/** Everything in this group needs a session; signing out or deleting the account returns to sign-in. */
export default function SignedInLayout() {
  const { hydrated, session, wallet } = useStore();
  if (!hydrated) return null;
  if (!session || !wallet) return <Redirect href="/auth/sign-in" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="send/processing" options={{ gestureEnabled: false, animation: 'fade' }} />
      <Stack.Screen name="send/success" options={{ gestureEnabled: false, animation: 'fade' }} />
      <Stack.Screen name="send/failed" options={{ gestureEnabled: false, animation: 'fade' }} />
    </Stack>
  );
}
