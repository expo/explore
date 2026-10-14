import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useRelayoutKey } from '@/lib/accessibility';
import { colors, text, TITLE_MAX_SCALE } from '@/theme';

export default function NotFoundRoute() {
  return (
    <View key={useRelayoutKey()} style={styles.root}>
      <Text style={[text.title, styles.center]} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Page not found</Text>
      <Text style={[text.bodyMuted, styles.center]}>This link does not point to a Wallet screen.</Text>
      <Link href="/" style={styles.link} accessibilityRole="link">Back to start</Link>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: colors.background },
  center: { textAlign: 'center' },
  link: { color: colors.ink, fontSize: 16, fontWeight: '600', marginTop: 12 },
});
