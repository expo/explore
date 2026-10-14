import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { Icon } from '@/components/icon';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { useIncreaseContrast } from '@/lib/accessibility';
import { useStore } from '@/store/store';
import type { AppearancePreference } from '@/store/types';
import { colors, hasDarkAppearance, palettes, radius, space, text, TITLE_MAX_SCALE, type Palette } from '@/theme';

const OPTIONS: Array<{ value: AppearancePreference; label: string; testID: string }> = [
  { value: 'system', label: 'System', testID: 'appearance-system' },
  { value: 'light', label: 'Light', testID: 'appearance-light' },
  { value: 'dark', label: 'Dark', testID: 'appearance-dark' },
];

/** A miniature Home drawn in one appearance's plain colors, so each option shows what it picks. */
function Preview({ palette }: { palette: Palette }) {
  return (
    <View style={[styles.preview, { backgroundColor: palette.background }]}>
      <View style={styles.previewHeader}>
        <View style={[styles.previewAvatar, { backgroundColor: palette.accentSoft }]} />
        <View style={[styles.previewLine, styles.previewGreeting, { backgroundColor: palette.ink }]} />
      </View>
      <View style={[styles.previewCard, { backgroundColor: palette.card, borderColor: palette.cardLine }]}>
        <View style={[styles.previewLine, styles.previewCardLabel, { backgroundColor: palette.onCardFaint }]} />
        <View style={[styles.previewBalance, { backgroundColor: palette.onCard }]} />
      </View>
      <View style={[styles.previewList, { backgroundColor: palette.surface, borderColor: palette.line }]}>
        {[styles.previewRowLong, styles.previewRowShort].map((width, index) => (
          <View key={index} style={styles.previewRow}>
            <View style={[styles.previewDot, { backgroundColor: palette.accentSoft }]} />
            <View style={[styles.previewLine, width, { backgroundColor: palette.muted }]} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Settings → Appearance: System follows the iPhone; Light and Dark keep Wallet in one appearance on this device. */
export default function AppearanceRoute() {
  const { appearance, setAppearance } = useStore();
  const scheme = useColorScheme();
  const contrast = useIncreaseContrast();

  const choose = (value: AppearancePreference) => {
    if (value === appearance) return;
    Haptics.selectionAsync().catch(() => { /* No haptics on this device. */ });
    setAppearance(value);
  };

  // Settings links here only where Wallet has a dark appearance; a link opened elsewhere shows the choice off.
  const note = !hasDarkAppearance ? 'On this device Wallet is always light.' : appearance === 'system'
    ? `Wallet matches your iPhone, which is ${scheme === 'dark' ? 'dark' : 'light'} right now, and switches when it does, including on a schedule.`
    : `Wallet stays ${appearance} on this iPhone, whatever its own setting.`;

  return (
    <Screen title="Appearance" subtitle="Choose how Wallet looks on this iPhone." backFallback={() => router.replace('/settings')}>
      <View style={styles.options} accessibilityRole="radiogroup">
        {OPTIONS.map((option) => {
          const selected = option.value === appearance;
          return (
            <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ selected, disabled: !hasDarkAppearance }} accessibilityLabel={option.label}
              testID={option.testID} disabled={!hasDarkAppearance} onPress={() => choose(option.value)}
              style={({ pressed }) => [styles.option, pressed && styles.pressed, !hasDarkAppearance && styles.unavailable]}>
              <View style={[styles.frame, selected && styles.frameSelected]}>
                <Preview palette={option.value === 'dark' ? palettes.dark : palettes.light} />
                {option.value === 'system' ? (
                  // The right half shows the dark preview: System is either.
                  <View style={styles.darkHalf}>
                    <View style={styles.darkHalfContent}><Preview palette={palettes.dark} /></View>
                  </View>
                ) : null}
              </View>
              <Text style={text.label} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{option.label}</Text>
              <View style={[styles.radio, selected && styles.radioSelected]}>
                {selected ? <Icon name="checkmark" size={14} color={colors.onAccent} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Text style={[text.caption, styles.note]} accessibilityLiveRegion="polite">{note}</Text>
      <View style={styles.section}>
        <Text style={text.overline}>Contrast</Text>
        <RowGroup>
          <Row label="Increase Contrast" detail="Stronger text and edges in every appearance. Change it in iPhone Settings → Accessibility → Display & Text Size."
            value={contrast ? 'On' : 'Off'} testID="appearance-contrast" />
        </RowGroup>
      </View>
    </Screen>
  );
}

const PREVIEW_HEIGHT = 168;

const styles = StyleSheet.create({
  options: { flexDirection: 'row', gap: space.md },
  option: { flex: 1, alignItems: 'center', gap: space.sm },
  pressed: { opacity: 0.8 },
  unavailable: { opacity: 0.45 },
  frame: { alignSelf: 'stretch', height: PREVIEW_HEIGHT, borderRadius: radius.lg, borderWidth: 2, borderColor: colors.line, overflow: 'hidden' },
  frameSelected: { borderColor: colors.accent },
  darkHalf: { position: 'absolute', top: 0, bottom: 0, left: '50%', right: 0, overflow: 'hidden' },
  darkHalfContent: { position: 'absolute', top: 0, bottom: 0, right: 0, width: '200%' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  note: { textAlign: 'center', paddingHorizontal: space.sm },
  section: { gap: space.sm, marginTop: space.sm },
  preview: { flex: 1, padding: space.sm, gap: 6 },
  previewHeader: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  previewAvatar: { width: 14, height: 14, borderRadius: 7 },
  previewLine: { height: 5, borderRadius: 2.5 },
  previewGreeting: { width: '45%' },
  previewCard: { height: 50, borderRadius: 8, borderWidth: 1, padding: 7, justifyContent: 'space-between' },
  previewCardLabel: { width: '40%' },
  previewBalance: { width: '65%', height: 9, borderRadius: 3 },
  previewList: { flex: 1, borderRadius: 8, borderWidth: 1, paddingHorizontal: 6, justifyContent: 'space-evenly' },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  previewDot: { width: 12, height: 12, borderRadius: 6 },
  previewRowLong: { width: '60%' },
  previewRowShort: { width: '42%' },
});
