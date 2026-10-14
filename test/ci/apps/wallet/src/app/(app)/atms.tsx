import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { Screen } from '@/components/screen';
import { Spinner } from '@/components/spinner';
import type { Coordinates } from '@/fixtures/atms';
import { isExploreProfile } from '@/fixtures/runtime';
import { useTextSize } from '@/lib/accessibility';
import { useOnActive } from '@/lib/app-state';
import { formatDistance, nearbyAtms, NEARBY_RADIUS_M, walkingTime, type AtmNearby } from '@/lib/atms';
import { formatMoney } from '@/lib/format';
import { ATM_FEE_PERCENT, ATM_FREE_ALLOWANCE } from '@/store/rules';
import { useStore } from '@/store/store';
import { colors, radius, space, text } from '@/theme';

/**
 * - checking: reading a permission granted earlier (not in the explore profile), so the explainer
 *   does not flash before the list;
 * - idle: not located yet; the explainer with Use my location.
 * - searching: allowed and watching, waiting for the first position.
 * - ready: a position is known; the list follows it as it changes.
 */
type Status = 'checking' | 'idle' | 'searching' | 'ready' | 'denied' | 'services-off';

/** After this long without a position, the searching state says so. */
const SLOW_SEARCH_MS = 10_000;

/**
 * Nearby ATMs: Wallet's partner ATMs in the closest city, nearest first. Location is asked for only
 * when Use my location is pressed, and read only while this screen is open.
 */
export default function AtmsRoute() {
  const { wallet, currency } = useStore();
  const { status, position, slow, locate, refresh } = useWatchedLocation();
  const nearby = useMemo(() => (position ? nearbyAtms(position) : null), [position]);
  if (!wallet) return null;

  const allowance = formatMoney(ATM_FREE_ALLOWANCE[wallet.plan], currency);
  const subtitle = status === 'ready' ? 'Partner ATMs around you, nearest first.' : 'Withdraw cash without a fee at Wallet partner ATMs.';

  return (
    <Screen title="Nearby ATMs" subtitle={subtitle} backFallback={() => router.replace('/home')}>
      {status === 'idle' ? (
        <Card style={styles.explainer} testID="atms-explainer">
          <View style={styles.badge}><Icon name="location" size={28} color={colors.ink} /></View>
          <Text style={[text.heading, styles.center]}>Find cash near you</Text>
          <Text style={[text.bodyMuted, styles.center]}>
            Wallet uses your location only while this screen is open, to list the partner ATMs around you. It never leaves your iPhone.
          </Text>
          <Button label="Use my location" onPress={locate} testID="atms-locate" style={styles.stretch} />
        </Card>
      ) : null}

      {status === 'searching' ? (
        <Card style={styles.explainer} testID="atms-searching">
          <Spinner size="large" />
          <Text style={[text.heading, styles.center]} accessibilityLiveRegion="polite">Finding ATMs near you…</Text>
          <Text style={[text.caption, styles.center]}>
            {slow ? 'This is taking longer than usual. Wallet keeps looking while this screen is open.' : 'This only takes a moment.'}
          </Text>
        </Card>
      ) : null}

      {status === 'denied' ? (
        <Problem icon="location-outline" title="Location is off for Wallet" testID="atms-denied"
          body="To list ATMs near you, allow location access in Settings → Wallet → Location."
          action={<Button label="Open Settings" onPress={() => Linking.openSettings()} testID="atms-settings" style={styles.stretch} />} />
      ) : null}

      {status === 'services-off' ? (
        <Problem icon="navigate-circle-outline" title="Location Services is off" testID="atms-services-off"
          body="Turn on Location Services in Settings → Privacy & Security, then try again."
          action={<Button label="Try again" variant="secondary" onPress={refresh} style={styles.stretch} />} />
      ) : null}

      {status === 'ready' && nearby ? (
        <>
          <View style={styles.cityHeader} accessibilityLiveRegion="polite">
            <Text style={text.overline}>{nearby.nearby ? `Near you in ${nearby.city.name}` : `Closest to you: ${nearby.city.name}`}</Text>
            <Text style={text.caption}>{nearby.city.country} · Cash in {nearby.city.currency}</Text>
          </View>
          {!nearby.nearby ? (
            <Banner tone="info" title={`No partner ATMs within ${formatDistance(NEARBY_RADIUS_M)}`}
              body={`The closest are in ${nearby.city.name}, ${formatDistance(nearby.atms[0]!.distance)} away.`} />
          ) : null}
          <Card style={styles.list} testID="atms-list">
            {nearby.atms.map((atm, index) => <AtmRow key={atm.id} atm={atm} last={index === nearby.atms.length - 1} />)}
          </Card>
          <Text style={[text.caption, styles.center]}>The list follows your location while this screen is open. Tap an ATM for walking directions in Maps.</Text>
        </>
      ) : null}

      <View style={styles.section}>
        <Text style={text.overline}>Fees</Text>
        <Card>
          <View style={styles.fee}>
            <Icon name="cash-outline" size={22} color={colors.ink} />
            <View style={styles.texts}>
              <Text style={text.label}>{allowance} a month without fees</Text>
              <Text style={text.caption}>Then {ATM_FEE_PERCENT}% a withdrawal. The ATM’s owner may add its own fee; you’ll see it on screen before you confirm.</Text>
            </View>
          </View>
        </Card>
        {wallet.plan === 'free' ? (
          <Banner tone="premium" title={`Withdraw ${formatMoney(ATM_FREE_ALLOWANCE.premium, currency)} free`} body="Premium raises your monthly fee-free cash."
            actionLabel="Upgrade" onPress={() => router.push('/paywall')} />
        ) : null}
      </View>
    </Screen>
  );
}

function AtmRow({ atm, last }: { atm: AtmNearby; last: boolean }) {
  const { large } = useTextSize();
  const walk = walkingTime(atm.distance);
  const distance = formatDistance(atm.distance);
  const features = [atm.hours, atm.deposits ? 'Deposits' : null].filter(Boolean).join(' · ');
  const directions = () => {
    const query = `daddr=${atm.latitude},${atm.longitude}&q=${encodeURIComponent(atm.name)}&dirflg=w`;
    Linking.openURL(`https://maps.apple.com/?${query}`).catch(() => { /* No maps app: the address is on screen. */ });
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${atm.name}, ${atm.address}, ${distance}`} accessibilityHint="Opens walking directions in Maps"
      onPress={directions} style={({ pressed }) => [styles.row, !last && styles.divider, pressed && styles.pressed]}>
      <View style={styles.rowIcon}><Icon name="card-outline" size={20} color={colors.ink} /></View>
      <View style={styles.texts}>
        <Text style={text.body}>{atm.name}</Text>
        <Text style={text.caption}>{atm.address}</Text>
        <Text style={text.caption}>{features}</Text>
        {large ? <Text style={text.label}>{walk ? `${distance} · ${walk}` : distance}</Text> : null}
      </View>
      {large ? null : (
        <View style={styles.distance}>
          <Text style={text.label}>{distance}</Text>
          {walk ? <Text style={text.caption}>{walk}</Text> : null}
        </View>
      )}
    </Pressable>
  );
}

function Problem({ icon, title, body, action, testID }: { icon: IconName; title: string; body: string; action: ReactNode; testID?: string }) {
  return (
    <Card style={styles.explainer} testID={testID}>
      <View style={[styles.badge, styles.badgeWarning]}><Icon name={icon} size={28} color={colors.warning} /></View>
      <Text style={[text.heading, styles.center]}>{title}</Text>
      <Text style={[text.bodyMuted, styles.center]}>{body}</Text>
      {action}
    </Card>
  );
}

/**
 * The device's position while this screen is open. Nothing is asked for until `locate` (Use my
 * location); outside the explore profile, a permission granted earlier starts it at once. The status is
 * read again whenever the app becomes active, so a change in Settings shows when the user returns.
 */
function useWatchedLocation() {
  const [status, setStatus] = useState<Status>(isExploreProfile ? 'idle' : 'checking');
  const [position, setPosition] = useState<Coordinates | null>(null);
  const [slow, setSlow] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const apply = useCallback(async (permission: Location.LocationPermissionResponse) => {
    if (!permission.granted) { setStatus(permission.status === 'denied' ? 'denied' : 'idle'); return; }
    const servicesOn = await Location.hasServicesEnabledAsync().catch(() => true);
    setStatus((current) => (!servicesOn ? 'services-off' : current === 'ready' ? 'ready' : 'searching'));
  }, []);
  const locate = useCallback(() => { Location.requestForegroundPermissionsAsync().then(apply, () => setStatus('denied')); }, [apply]);
  const refresh = useCallback(() => {
    Location.getForegroundPermissionsAsync().then(apply, () => setStatus((current) => (current === 'checking' ? 'idle' : current)));
  }, [apply]);

  // A capture shows the explainer until the button is pressed; other builds carry on where the user left off.
  useEffect(() => { if (!isExploreProfile) refresh(); }, [refresh]);
  useOnActive(() => { if (!isExploreProfile || statusRef.current !== 'idle') refresh(); });

  const watching = status === 'searching' || status === 'ready';
  useEffect(() => {
    if (!watching) return;
    let active = true;
    let subscription: Location.LocationSubscription | undefined;
    Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 25 }, ({ coords }) => {
      if (!active) return;
      setPosition({ latitude: coords.latitude, longitude: coords.longitude });
      setStatus('ready');
    }, () => { if (active) refresh(); }).then((created) => {
      if (active) subscription = created;
      else created.remove();
    }, () => { if (active) refresh(); });
    return () => { active = false; subscription?.remove(); };
  }, [refresh, watching]);

  useEffect(() => {
    setSlow(false);
    if (status !== 'searching') return;
    const timer = setTimeout(() => setSlow(true), SLOW_SEARCH_MS);
    return () => clearTimeout(timer);
  }, [status]);

  return { status, position, slow, locate, refresh };
}

const styles = StyleSheet.create({
  explainer: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  badge: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  badgeWarning: { backgroundColor: colors.warningSoft },
  center: { textAlign: 'center' },
  stretch: { alignSelf: 'stretch' },
  cityHeader: { gap: 2 },
  list: { paddingVertical: space.xs, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.7 },
  rowIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, gap: 2 },
  distance: { alignItems: 'flex-end', gap: 2 },
  section: { gap: space.sm, marginTop: space.sm },
  fee: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
});
