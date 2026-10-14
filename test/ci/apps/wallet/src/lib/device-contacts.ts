import * as Contacts from 'expo-contacts';
import { useCallback, useEffect, useState } from 'react';
import { useOnActive } from '@/lib/app-state';

/** A person in the iPhone's contacts. Wallet reads names only. */
export type Person = { id: string; name: string };

const FIELDS = [Contacts.ContactField.FULL_NAME, Contacts.ContactField.COMPANY] as const;

async function readPeople(): Promise<Person[]> {
  const details = await Contacts.Contact.getAllDetails(FIELDS, { sortOrder: Contacts.ContactsSortOrder.UserDefault });
  return details.map((entry) => ({ id: entry.id, name: (entry.fullName || entry.company || '').trim() })).filter((person) => person.name);
}

/**
 * Asks for access to the contacts, for a button press: `granted`, `declined` in the prompt, or `blocked`
 * when iOS no longer asks and only Settings can turn it on.
 */
export async function requestContactsAccess(): Promise<'granted' | 'declined' | 'blocked'> {
  const before = await Contacts.getPermissionsAsync();
  if (before.granted) return 'granted';
  if (!before.canAskAgain) return 'blocked';
  return (await Contacts.requestPermissionsAsync()).granted ? 'granted' : 'declined';
}

/**
 * The iPhone's contacts, when Wallet may read them. Opening a screen only reads the permission;
 * `request` asks for it. The permission is read again whenever the app becomes active, and the list
 * reloads when the contacts change.
 */
export function useDeviceContacts() {
  const [permission, setPermission] = useState<Contacts.ContactsPermissionResponse | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const granted = !!permission?.granted;

  const check = useCallback(() => { Contacts.getPermissionsAsync().then(setPermission, () => { /* Keep the last known permission. */ }); }, []);
  const request = useCallback(() => { Contacts.requestPermissionsAsync().then(setPermission, () => { /* Contacts are unavailable. */ }); }, []);
  const load = useCallback(() => { readPeople().then(setPeople, () => setPeople([])); }, []);
  /** iOS 18 limited access: lets the user share more contacts with Wallet. */
  const chooseMore = useCallback(() => { Contacts.Contact.presentAccessPicker().then(load, () => { /* Picker dismissed. */ }); }, [load]);

  useEffect(check, [check]);
  useOnActive(check);
  useEffect(() => {
    if (!granted) { setPeople(null); return; }
    load();
    const subscription = Contacts.addContactsChangeListener(load);
    return () => subscription.remove();
  }, [granted, load]);

  return { permission, people, request, chooseMore };
}
