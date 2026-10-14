import { ActivityIndicator, StyleSheet, View, type ColorValue } from 'react-native';
import { isExploreProfile } from '@/fixtures/runtime';
import { colors } from '@/theme';

/** A progress indicator. The explore profile renders it static so captures of loading states settle. */
export function Spinner({ color = colors.ink, size = 'small' }: { color?: ColorValue; size?: 'small' | 'large' }) {
  if (!isExploreProfile) return <ActivityIndicator color={color} size={size} />;
  const dot = size === 'large' ? 10 : 6;
  return (
    <View style={styles.dots} accessibilityRole="progressbar" accessibilityLabel="Loading">
      {[0.35, 0.65, 1].map((opacity) => <View key={opacity} style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color, opacity }} />)}
    </View>
  );
}

const styles = StyleSheet.create({ dots: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', padding: 4 } });
