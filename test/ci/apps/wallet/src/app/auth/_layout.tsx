import { type NativeStackNavigationProp, Redirect, Stack, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback } from 'react';
import { useStore } from '@/store/store';

/** Sign-in and sign-up are only for signed-out users; a signed-in visit goes home. */
export default function AuthLayout() {
  const { hydrated, session } = useStore();
  if (!hydrated) return null;
  if (session) return <GoHome />;
  return <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />;
}

/**
 * Leaves Home as the only screen in the root stack. The redirect replaces just this group, so
 * whatever led to it (onboarding, the splash) would stay beneath the signed-in group; signing out
 * then replaces only the top screen again, and a swipe back from sign-in would reveal onboarding,
 * whose Continue sets the currency of every existing account.
 */
function GoHome() {
  // This group's entry in the root stack: its state is the root stack's.
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  useFocusEffect(useCallback(() => {
    // Keep only this group, which is on top while focused; the redirect then replaces it.
    const state = navigation.getState();
    if (state.index > 0) navigation.reset({ ...state, index: 0, routes: [state.routes[state.index]] });
  }, [navigation]));
  return <Redirect href="/home" />;
}
