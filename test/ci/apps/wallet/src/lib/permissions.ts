import type { PermissionResponse } from 'expo';
import { Camera } from 'expo-camera';
import * as Contacts from 'expo-contacts';
import * as Location from 'expo-location';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useOnActive } from '@/lib/app-state';
import { readNotificationPermission, requestNotificationPermission } from '@/lib/notifications';

/** The iPhone permissions Wallet's features use. */
export type PermissionName = 'camera' | 'location' | 'notifications' | 'contacts';

/**
 * What iOS has decided for one permission: `allowed`, `denied`, or `not-set` (never asked). `canAsk` is
 * whether a request would still show iOS's prompt; after a refusal only Settings can change it.
 * `limited` is iOS 18's limited contacts access: allowed, for the contacts the user chose.
 */
export type PermissionState = { status: 'allowed' | 'denied' | 'not-set'; canAsk: boolean; limited: boolean };

const stateOf = (response: PermissionResponse, limited = false): PermissionState => ({
  status: response.granted ? 'allowed' : response.status === 'denied' ? 'denied' : 'not-set',
  canAsk: !response.granted && response.status !== 'denied' && response.canAskAgain,
  limited: response.granted && limited,
});

const contactsStateOf = (response: Contacts.ContactsPermissionResponse) => stateOf(response, response.accessPrivileges === 'limited');

/** Reading never prompts; requesting shows iOS's prompt when it still can. */
const PERMISSIONS: Record<PermissionName, { read: () => Promise<PermissionState>; request: () => Promise<PermissionState> }> = {
  camera: {
    read: () => Camera.getCameraPermissionsAsync().then((response) => stateOf(response)),
    request: () => Camera.requestCameraPermissionsAsync().then((response) => stateOf(response)),
  },
  location: {
    read: () => Location.getForegroundPermissionsAsync().then((response) => stateOf(response)),
    request: () => Location.requestForegroundPermissionsAsync().then((response) => stateOf(response)),
  },
  // Through the notifications module, so Settings and Notifications show the new answer too.
  notifications: {
    read: () => readNotificationPermission().then((response) => stateOf(response)),
    request: () => requestNotificationPermission().then((response) => stateOf(response)),
  },
  contacts: {
    read: () => Contacts.getPermissionsAsync().then(contactsStateOf),
    request: () => Contacts.requestPermissionsAsync().then(contactsStateOf),
  },
};

export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as PermissionName[];

/**
 * The current answer for each permission, read when the screen gains focus and whenever the app becomes
 * active again, so a change made in iPhone Settings (or from the Viewer's Live tools) shows as soon as
 * the user is back. On a simulator, iOS applies a notifications change from the Live tools only after
 * SpringBoard restarts (README, iPhone settings Wallet follows). A permission is missing until it has
 * been read. `request` asks for one, only when called.
 */
export function usePermissions() {
  const [states, setStates] = useState<Partial<Record<PermissionName, PermissionState>>>({});
  const settle = useCallback((name: PermissionName, state: PermissionState) => setStates((current) => ({ ...current, [name]: state })), []);
  const read = useCallback(() => {
    for (const name of PERMISSION_NAMES) PERMISSIONS[name].read().then((state) => settle(name, state), () => { /* Keep the last known answer. */ });
  }, [settle]);
  const request = useCallback((name: PermissionName) => PERMISSIONS[name].request().then((state) => settle(name, state), read), [read, settle]);

  useFocusEffect(read);
  useOnActive(read);
  return { states, request };
}
