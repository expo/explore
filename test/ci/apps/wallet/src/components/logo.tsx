import { StyleSheet, View, type ColorValue } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { colors } from '@/theme';

/** The Wallet mark: a card outline with a stripe. `fill` (0–1) reveals a solid copy from the bottom up. */
export function Logo({ size = 96, fill, color = colors.onCard, faded = colors.onCardTrack }: { size?: number; fill?: SharedValue<number>; color?: ColorValue; faded?: ColorValue }) {
  const mask = useAnimatedStyle(() => ({ height: fill ? `${Math.round(fill.value * 100)}%` : '100%' }));
  const Mark = ({ tint }: { tint: ColorValue }) => (
    <View style={[styles.mark, { width: size, height: size * 0.7, borderRadius: size * 0.16, borderColor: tint, borderWidth: Math.max(3, size * 0.06) }]}>
      <View style={[styles.stripe, { backgroundColor: tint, top: size * 0.16, height: size * 0.09 }]} />
    </View>
  );
  return (
    <View style={{ width: size, height: size * 0.7 }} accessibilityRole="image" accessibilityLabel="Wallet logo">
      <Mark tint={fill ? faded : color} />
      {fill ? (
        <Animated.View style={[styles.fill, mask]}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, width: size, height: size * 0.7 }}><Mark tint={color} /></View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { position: 'absolute', top: 0, left: 0, overflow: 'hidden' },
  stripe: { position: 'absolute', left: 0, right: 0 },
  fill: { position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' },
});
