import { type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/icon';
import { useTextSize } from '@/lib/accessibility';
import { goBack } from '@/lib/navigation';
import { colors, layout, space, text, TITLE_MAX_SCALE } from '@/theme';

/**
 * Page chrome: safe area, optional header with a Back control, content and a pinned footer.
 * `backFallback` adds the Back control; Back goes through the history, or runs `backFallback` when
 * there is none (a cold deep link), see `goBack`.
 *
 * The content scrolls. With `scroll={false}` it fills the screen instead, for centred or pinned layouts
 * (a child with `flexGrow: 1` takes the free space), and scrolls only when it is taller than the screen,
 * as it can be at the largest text sizes. `list` hands the whole area to a list that scrolls itself.
 * At the accessibility text sizes the footer joins the end of the content, so pinned buttons never
 * cover most of the screen. On a wide screen the page keeps a readable width, centred.
 */
export function Screen({ title, subtitle, backFallback, right, children, footer, scroll = true, list = false, testID, background = colors.background }: {
  title?: string; subtitle?: string; backFallback?: () => void; right?: ReactNode; children: ReactNode; footer?: ReactNode; scroll?: boolean; list?: boolean; testID?: string; background?: ColorValue;
}) {
  // Insets come from the nearest provider: the root one, or a native tab's, whose bottom inset includes the
  // tab bar. A native SafeAreaView reports none inside a full-screen modal.
  const insets = useSafeAreaInsets();
  const textSize = useTextSize();
  const pinned = footer && !textSize.large ? footer : null;
  // Without a pinned footer, the content runs to the bottom edge, under the tab bar or the home indicator.
  const contentInsets = pinned ? undefined : { paddingBottom: insets.bottom + space.xxl };
  const header = title || backFallback || right ? (
    <View style={[styles.header, styles.readable]}>
      <View style={styles.headerSide}>
        {backFallback ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => goBack(backFallback)} hitSlop={12} style={styles.back}>
            <Icon name="chevron-back" size={22} color={colors.ink} />
            <Text style={styles.backLabel} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Back</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  ) : null;
  const heading = title ? (
    <View style={styles.heading}>
      <Text style={text.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_MAX_SCALE}>{title}</Text>
      {subtitle ? <Text style={[text.bodyMuted, styles.subtitle]}>{subtitle}</Text> : null}
    </View>
  ) : null;
  const trailing = footer && !pinned ? <View style={styles.inlineFooter}>{footer}</View> : null;
  return (
    // Keyed by the text size, so a change lays the page out again (see `useRelayoutKey`).
    <View key={textSize.scale} style={[styles.safe, { backgroundColor: background, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]} testID={testID}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {header}
        {list ? (
          <View style={[styles.flex, styles.readable, styles.content, textSize.large && styles.contentWide]}>
            {heading}
            {children}
            {trailing}
          </View>
        ) : (
          <ScrollView style={styles.flex} contentContainerStyle={[styles.readable, styles.content, textSize.large && styles.contentWide, !scroll && styles.fill, contentInsets]} alwaysBounceVertical={scroll}
            keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentInsetAdjustmentBehavior="never">
            {heading}
            {children}
            {trailing}
          </ScrollView>
        )}
        {pinned ? <View style={[styles.footer, styles.readable, { paddingBottom: insets.bottom + space.md }]}>{pinned}</View> : null}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  fill: { flexGrow: 1 },
  // On a wide screen the header, content and footer keep a readable width, centred; the background stays full width.
  readable: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
  header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md },
  headerSide: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  headerRight: { justifyContent: 'flex-end' },
  back: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 8 },
  backLabel: { fontSize: 16, color: colors.ink, marginLeft: -2 },
  heading: { marginBottom: space.xl, gap: space.sm },
  subtitle: { marginTop: 2 },
  content: { paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.xxl, gap: space.lg },
  // At the accessibility text sizes the side margins narrow, leaving more of each line for the text.
  contentWide: { paddingHorizontal: space.lg },
  inlineFooter: { gap: space.md, marginTop: space.md },
  footer: { paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.md, gap: space.md },
});
