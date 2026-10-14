import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { useEffect, useSyncExternalStore } from 'react';
import { useOnActive } from '@/lib/app-state';
import { formatMoney } from '@/lib/format';
import type { Currency } from '@/store/types';

/** iOS's answer for Wallet's notifications: `null` until it has been read. */
export type NotificationAccess = 'granted' | 'denied' | 'undetermined' | null;

const accessOf = (permission: Notifications.NotificationPermissionsStatus): Exclude<NotificationAccess, null> =>
  permission.granted ? 'granted' : permission.status === 'denied' ? 'denied' : 'undetermined';

// Transaction alerts show as banners even while Wallet is open, as a bank's do.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** The last known access, shared by every screen that shows it, so Settings and Notifications agree. */
let knownAccess: NotificationAccess = null;
const listeners = new Set<() => void>();
const publish = (next: NotificationAccess) => {
  if (next === knownAccess) return;
  knownAccess = next;
  listeners.forEach((listener) => listener());
};
/** Reads Wallet's notification permission without asking, and shares the answer with every screen. */
export async function readNotificationPermission(): Promise<Notifications.NotificationPermissionsStatus> {
  const permission = await Notifications.getPermissionsAsync();
  publish(accessOf(permission));
  return permission;
}

/** Asks iOS to allow Wallet's notifications. After a refusal iOS answers without asking; only Settings can change it. */
export async function requestNotificationPermission(): Promise<Notifications.NotificationPermissionsStatus> {
  const permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
  publish(accessOf(permission));
  return permission;
}

const refreshAccess = () => { readNotificationPermission().catch(() => { /* Keep the last known access. */ }); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const requestAccess = async () => accessOf(await requestNotificationPermission());

/**
 * Whether iOS lets Wallet show notifications. Reading it never prompts; `request` asks. It is read
 * when a screen that shows it opens and whenever the app becomes active, so a change made in Settings
 * shows as soon as the user is back.
 */
export function useNotificationAccess() {
  const access = useSyncExternalStore(subscribe, () => knownAccess);
  useEffect(refreshAccess, []);
  useOnActive(refreshAccess);
  return { access, request: requestAccess };
}

/**
 * Posts the transaction alert for a completed transfer, if iOS allows Wallet's notifications. The
 * alert carries its receipt's link (`explore-example-wallet:///transactions/tx-0013`), which a tap opens.
 */
export async function alertTransferSent({ transactionId, amount, currency, recipient }: { transactionId: string; amount: number; currency: Currency; recipient: string }) {
  if (!(await Notifications.getPermissionsAsync()).granted) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Money sent',
      body: `You sent ${formatMoney(amount, currency)} to ${recipient}.`,
      data: { transactionId, url: Linking.createURL(`/transactions/${transactionId}`) },
    },
    trigger: null,
  });
}

/**
 * Opens the receipt of a transaction alert the user tapped, including one that launched the app, once
 * `ready` (the store has loaded). The response is then cleared, so the next launch does not open it again.
 *
 * The receipt opens as an incoming link, which expo-router routes like any other, not with a router
 * call: the root layout runs this hook, so Explore's source analysis would read a router call here as
 * a link from every screen to the receipt, and a change to the receipt would then capture every screen.
 */
export function useOpenTappedAlerts(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const url = response?.notification.request.content.data?.url;
      if (typeof url !== 'string') return;
      Notifications.clearLastNotificationResponse();
      Linking.openURL(url).catch(() => { /* The alert stays in Notification Center; Activity lists the transfer. */ });
    };
    open(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [ready]);
}
