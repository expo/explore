import { router } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { PlanBadge } from '@/components/plan-badge';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { appVersion } from '@/lib/app-info';
import { useNotificationAccess } from '@/lib/notifications';
import { useStore } from '@/store/store';
import type { AppearancePreference } from '@/store/types';
import { hasDarkAppearance, space, text } from '@/theme';

const APPEARANCE_LABEL: Record<AppearancePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export default function SettingsRoute() {
  const { session, wallet, currency, appearance, signOut } = useStore();
  const { access } = useNotificationAccess();
  if (!session || !wallet) return null;
  const alertsOn = wallet.notifications && access === 'granted';
  const confirmSignOut = () => Alert.alert('Sign out?', 'You can sign back in with your email and password.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Yes, sign out', style: 'destructive', onPress: signOut },
  ]);
  return (
    <Screen title="Settings">
      <RowGroup>
        <Row label={session.name} detail={session.email} onPress={() => router.push('/account')} testID="settings-account"
          right={<Avatar name={session.name} size={36} />} />
      </RowGroup>
      <View style={styles.section}>
        <Text style={text.overline}>Plan</Text>
        <RowGroup>
          <Row label="Subscription" onPress={() => router.push('/subscription')} right={<PlanBadge plan={wallet.plan} />} testID="settings-subscription" />
        </RowGroup>
      </View>
      <View style={styles.section}>
        <Text style={text.overline}>Preferences</Text>
        <RowGroup>
          <Row label="Notifications" value={alertsOn ? 'On' : 'Off'} onPress={() => router.push('/notifications')} testID="settings-notifications" />
          {/* Only iOS has a dark appearance to choose. */}
          {hasDarkAppearance ? (
            <Row label="Appearance" value={APPEARANCE_LABEL[appearance]} onPress={() => router.push('/appearance')} testID="settings-appearance" />
          ) : null}
          <Row label="Currency" value={currency} />
        </RowGroup>
      </View>
      <View style={styles.section}>
        <Text style={text.overline}>Privacy</Text>
        <RowGroup>
          <Row label="Privacy & permissions" detail="Camera, location, notifications and contacts" onPress={() => router.push('/privacy')} testID="settings-privacy" />
        </RowGroup>
      </View>
      <RowGroup>
        <Row label="About Wallet" detail="Version and diagnostics" onPress={() => router.push('/about')} testID="settings-about" />
      </RowGroup>
      <RowGroup>
        <Row label="Sign out" tone="danger" onPress={confirmSignOut} testID="settings-sign-out" />
      </RowGroup>
      <Text style={[text.caption, styles.version]}>Wallet {appVersion} · Example app for Expo Explore</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({ section: { gap: space.sm }, version: { textAlign: 'center', marginTop: space.md } });
