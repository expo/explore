import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { useToast } from '@/components/toast';
import { formatLongDate } from '@/lib/format';
import { useStore } from '@/store/store';
import { space, text } from '@/theme';

export default function AccountRoute() {
  const { session, updateName, signOut } = useStore();
  const toast = useToast();
  const [name, setName] = useState(session?.name ?? '');
  if (!session) return null;
  const changed = name.trim() !== session.name && name.trim().length > 0;
  return (
    <Screen title="Account" backFallback={() => router.replace('/settings')}>
      <View style={styles.profile} testID="account-session">
        <Avatar name={session.name} size={72} tone="accent" />
        <Text style={[text.heading, styles.center]}>{session.name}</Text>
        <Text style={[text.bodyMuted, styles.center]}>Signed in as {session.email}</Text>
        <Text style={[text.caption, styles.center]}>Member since {formatLongDate(session.createdAt)}</Text>
      </View>
      <Field label="Display name" value={name} onChangeText={setName} autoCapitalize="words" testID="account-name" />
      <Button label="Save changes" variant="secondary" disabled={!changed} onPress={() => { updateName(name); toast('Name updated', 'success'); }} testID="account-save" />
      <RowGroup>
        <Row label="Sign out" onPress={() => Alert.alert('Sign out?', 'You can sign back in with your email and password.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Yes, sign out', style: 'destructive', onPress: signOut }])} testID="account-sign-out" />
        <Row label="Delete account" tone="danger" onPress={() => router.push('/account/delete')} testID="account-delete" />
      </RowGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({ profile: { alignItems: 'center', gap: space.xs, marginBottom: space.sm }, center: { textAlign: 'center' } });
