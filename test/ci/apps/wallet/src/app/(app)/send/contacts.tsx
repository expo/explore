import { router } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Field } from '@/components/field';
import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { Spinner } from '@/components/spinner';
import { useTextSize } from '@/lib/accessibility';
import { useDeviceContacts } from '@/lib/device-contacts';
import { recipientNamed, recipientParams } from '@/lib/recipient';
import { colors, radius, space, text } from '@/theme';

/**
 * Pay someone from the iPhone's contacts. Send's From contacts asks for access; opened any other way,
 * this screen asks only when Allow access is pressed.
 */
export default function ContactsRoute() {
  const insets = useSafeAreaInsets();
  const { permission, people, request, chooseMore } = useDeviceContacts();
  const [query, setQuery] = useState('');
  const { large } = useTextSize();
  const recipients = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (people ?? []).filter((person) => !needle || person.name.toLowerCase().includes(needle))
      .map((person) => ({ id: person.id, recipient: recipientNamed(person.name) }));
  }, [people, query]);

  if (!permission) {
    return <Screen title="Your contacts" subtitle="Pay anyone in your iPhone contacts." backFallback={() => router.replace('/send')}><View /></Screen>;
  }
  if (!permission.granted) {
    const denied = !permission.canAskAgain;
    return (
      <Screen title="Your contacts" subtitle="Pay anyone in your iPhone contacts." backFallback={() => router.replace('/send')}>
        {denied ? (
          <Explainer icon="people-outline" title="Contacts access is off" testID="contacts-denied"
            body="To pay someone from your contacts, allow access in Settings → Wallet → Contacts."
            action={<Button label="Open Settings" onPress={() => Linking.openSettings()} testID="contacts-settings" style={styles.stretch} />} />
        ) : (
          <Explainer icon="people" title="Pay people you know" testID="contacts-explainer"
            body="Wallet lists your contacts here so you can choose who to pay. It reads only their names, and they never leave your iPhone."
            action={<Button label="Allow access" onPress={request} testID="contacts-allow" style={styles.stretch} />} />
        )}
      </Screen>
    );
  }

  const limited = permission.accessPrivileges === 'limited';
  return (
    <Screen title="Your contacts" subtitle="Choose who you’re paying." backFallback={() => router.replace('/send')} list>
      <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name" returnKeyType="search" testID="contacts-search" />
      {people === null ? <Spinner /> : (
        <FlatList data={recipients} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
          style={styles.list} contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }} testID="contacts-list"
          renderItem={({ item, index }) => (
            <Pressable accessibilityRole="button" accessibilityLabel={`${item.recipient.name}, ${item.recipient.detail}`}
              onPress={() => router.push({ pathname: '/send/amount', params: recipientParams(item.recipient) })}
              style={({ pressed }) => [styles.row, index < recipients.length - 1 && styles.divider, pressed && styles.pressed]}>
              <Avatar name={item.recipient.name} />
              <View style={styles.texts}>
                <Text style={text.body}>{item.recipient.name}</Text>
                <Text style={text.caption}>{item.recipient.detail}</Text>
                {large && item.recipient.contact ? <Text style={[styles.onWallet, styles.onWalletStacked]}>On Wallet</Text> : null}
              </View>
              {!large && item.recipient.contact ? <Text style={styles.onWallet}>On Wallet</Text> : null}
            </Pressable>
          )}
          ListEmptyComponent={(
            <Text style={[text.bodyMuted, styles.empty]}>
              {query.trim() ? `No contacts match “${query.trim()}”.` : limited ? 'You haven’t shared any contacts with Wallet yet.' : 'Your contacts list is empty.'}
            </Text>
          )}
          ListFooterComponent={limited ? (
            <Card style={styles.limited}>
              <Text style={text.caption}>Wallet sees only the contacts you chose to share.</Text>
              <Button label="Choose more contacts" variant="secondary" compact onPress={chooseMore} testID="contacts-choose" />
            </Card>
          ) : null} />
      )}
    </Screen>
  );
}

function Explainer({ icon, title, body, action, testID }: { icon: IconName; title: string; body: string; action: ReactNode; testID?: string }) {
  return (
    <Card style={styles.explainer} testID={testID}>
      <View style={styles.badge}><Icon name={icon} size={28} color={colors.ink} /></View>
      <Text style={[text.heading, styles.center]}>{title}</Text>
      <Text style={[text.bodyMuted, styles.center]}>{body}</Text>
      {action}
    </Card>
  );
}

const styles = StyleSheet.create({
  explainer: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  badge: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  stretch: { alignSelf: 'stretch' },
  list: { flex: 1, marginHorizontal: -space.xl, paddingHorizontal: space.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.7 },
  texts: { flex: 1, gap: 2 },
  onWallet: { fontSize: 12, fontWeight: '600', color: colors.success, backgroundColor: colors.successSoft, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' },
  onWalletStacked: { alignSelf: 'flex-start', marginTop: space.xs },
  empty: { paddingVertical: space.lg, textAlign: 'center' },
  limited: { marginTop: space.lg, gap: space.sm },
});
