import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Card } from '@/components/card';
import { Field } from '@/components/field';
import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { CONTACTS } from '@/fixtures/seed';
import { useTextSize } from '@/lib/accessibility';
import { requestContactsAccess } from '@/lib/device-contacts';
import { colors, radius, space, text } from '@/theme';

export default function SendRoute() {
  const [query, setQuery] = useState('');
  const { large } = useTextSize();
  const needle = query.trim().toLowerCase();
  const matches = CONTACTS.filter((contact) => !needle || contact.name.toLowerCase().includes(needle) || contact.handle.includes(needle));
  // Asks for the contacts only now, on the press; a refusal made earlier can be changed only in Settings.
  const fromContacts = () => requestContactsAccess().then((access) => {
    if (access === 'granted') router.push('/send/contacts');
    else if (access === 'blocked') {
      Alert.alert('Allow access to contacts', 'To pay someone from your contacts, turn on Contacts for Wallet in Settings.', [
        { text: 'Not Now', style: 'cancel' },
        { text: 'Open Settings', onPress: () => { Linking.openSettings(); } },
      ]);
    }
  }, () => { /* Contacts are unavailable on this device. */ });
  return (
    <Screen title="Send money" subtitle="Choose who you’re paying." backFallback={() => router.replace('/home')}>
      <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name or @handle" autoCapitalize="none" returnKeyType="search" testID="send-search" />
      <View style={[styles.actions, large && styles.stacked]}>
        <Action icon="qr-code-outline" label="Scan to pay" onPress={() => router.push('/send/scan')} testID="send-scan" stacked={large} />
        <Action icon="people-outline" label="From contacts" onPress={fromContacts} testID="send-contacts" stacked={large} />
      </View>
      <View style={styles.section}>
        <Text style={text.overline}>On Wallet</Text>
        <Card style={styles.list}>
          {matches.length === 0 ? <Text style={[text.bodyMuted, styles.empty]}>No contacts match “{query}”.</Text> : null}
          {matches.map((contact, index) => (
            <Pressable key={contact.id} accessibilityRole="button" accessibilityLabel={`${contact.name}, ${contact.handle}`}
              onPress={() => router.push({ pathname: '/send/amount', params: { to: contact.id } })}
              style={({ pressed }) => [styles.row, index < matches.length - 1 && styles.divider, pressed && styles.pressed]}>
              <Avatar name={contact.name} />
              <View style={styles.texts}>
                <Text style={text.body}>{contact.name}</Text>
                <Text style={text.caption}>{contact.handle}</Text>
              </View>
            </Pressable>
          ))}
        </Card>
      </View>
    </Screen>
  );
}

/** Another way to find a recipient, beside the Wallet list. */
function Action({ icon, label, onPress, testID, stacked }: { icon: IconName; label: string; onPress: () => void; testID?: string; stacked?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.action, stacked && styles.actionStacked, pressed && styles.pressed]}>
      <View style={styles.actionIcon}><Icon name={icon} size={20} color={colors.ink} /></View>
      <Text style={[text.label, styles.actionLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: space.md },
  stacked: { flexDirection: 'column' },
  actionStacked: { flex: 0 },
  actionLabel: { flexShrink: 1 },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56, paddingHorizontal: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  actionIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  section: { gap: space.sm },
  list: { paddingVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.7 },
  texts: { flex: 1, gap: 2 },
  empty: { paddingVertical: space.md },
});
