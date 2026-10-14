import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, type IconName } from '@/components/icon';
import { useReduceTransparency } from '@/lib/accessibility';
import { useMotion } from '@/lib/motion';
import { colors } from '@/theme';

const liquidGlass = isLiquidGlassAvailable();

/**
 * A round control over card art. On iOS 26 it is Liquid Glass, which picks up the art behind it; with
 * Reduce Transparency on, or without Liquid Glass, it is a solid surface in the app's colors instead. The
 * glass responds to a touch only while the app animates (see `useMotion`).
 */
export function GlassButton({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID?: string }) {
  const reduceTransparency = useReduceTransparency();
  const motion = useMotion();
  const glass = liquidGlass && !reduceTransparency;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} testID={testID} onPress={onPress} hitSlop={6}
      style={({ pressed }) => pressed && !glass && styles.pressed}>
      {glass ? (
        // Dark glass: the art under it is dark in both appearances.
        <GlassView glassEffectStyle="regular" colorScheme="dark" isInteractive={motion} style={styles.button}>
          <Icon name={icon} size={20} color={colors.onCard} />
        </GlassView>
      ) : (
        <View style={[styles.button, styles.solid]}>
          <Icon name={icon} size={20} color={colors.ink} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  solid: { backgroundColor: colors.elevated },
  pressed: { opacity: 0.7 },
});
