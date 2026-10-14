import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Logo } from '@/components/logo';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { appVersion } from '@/lib/app-info';
import { colors, radius, space, text } from '@/theme';

/** Settings → About: the app and its version, and the diagnostics support asks for. */
export default function AboutRoute() {
  return (
    <Screen title="About" backFallback={() => router.replace('/settings')}>
      <View style={styles.app} accessible accessibilityLabel={`Wallet, version ${appVersion}`}>
        <View style={styles.mark}><Logo size={44} /></View>
        <Text style={text.heading}>Wallet</Text>
        <Text style={text.caption}>Version {appVersion}</Text>
      </View>
      <RowGroup>
        <Row label="Diagnostics" detail="Version, memory and accessibility details for support" onPress={() => router.push('/about/diagnostics')}
          testID="about-diagnostics" />
        <Row label="Privacy & permissions" onPress={() => router.push('/privacy')} testID="about-privacy" />
      </RowGroup>
      <Text style={[text.caption, styles.note]}>
        Wallet is an example app for Expo Explore. Accounts, balances and cards live only on this iPhone, and nothing is sent to a server.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  app: { alignItems: 'center', gap: space.xs, marginBottom: space.sm },
  mark: { width: 76, height: 76, borderRadius: radius.lg, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
  note: { textAlign: 'center', paddingHorizontal: space.sm },
});
