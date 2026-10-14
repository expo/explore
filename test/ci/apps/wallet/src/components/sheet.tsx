import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { entering } from '@/lib/motion';
import { colors, layout, radius, space, text, TITLE_MAX_SCALE } from '@/theme';

/**
 * A bottom sheet. Uses a native modal so it is part of the accessibility tree while open. It is as tall
 * as its content, up to just below the status bar; beyond that, as at the largest text sizes, it scrolls.
 */
export function Sheet({ visible, onClose, title, children, testID }: { visible: boolean; onClose: () => void; title: string; children: ReactNode; testID?: string }) {
  const insets = useSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Animated.View entering={entering(FadeIn.duration(180))} style={StyleSheet.absoluteFill}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.backdrop} />
        </Animated.View>
        {/* Keyed by the text size, so a change lays the sheet out again (see `useRelayoutKey`). */}
        <Animated.View key={fontScale} entering={entering(SlideInDown.duration(260))} style={[styles.sheet, { maxHeight: height - insets.top - space.sm }]} testID={testID}>
          <ScrollView bounces={false} contentContainerStyle={[styles.inner, { paddingBottom: insets.bottom + space.xl }]}>
            <View style={styles.grabber} />
            <Text style={text.heading} accessibilityRole="header" maxFontSizeMultiplier={TITLE_MAX_SCALE}>{title}</Text>
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { flex: 1, backgroundColor: colors.backdrop },
  // On a wide screen the sheet keeps a readable width, centred at the bottom.
  sheet: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', backgroundColor: colors.elevated, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: 'hidden' },
  inner: { padding: space.xl, gap: space.lg },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.faint, opacity: 0.5, marginTop: -8 },
});
