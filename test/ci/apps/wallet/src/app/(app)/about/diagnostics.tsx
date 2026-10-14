import { router } from 'expo-router';
import { Share, StyleSheet, Text, useColorScheme, useWindowDimensions, View } from 'react-native';
import { Button } from '@/components/button';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { useToast } from '@/components/toast';
import { now } from '@/fixtures/runtime';
import { useIncreaseContrast, useReduceMotion, useReduceTransparency, useScreenReader, useTextSize } from '@/lib/accessibility';
import { appVersion, buildName, systemName } from '@/lib/app-info';
import { formatDateTime, formatDay } from '@/lib/format';
import { cachedEntries, useMemoryWarnings } from '@/lib/memory';
import { useStore } from '@/store/store';
import { space, text } from '@/theme';

const onOff = (on: boolean) => (on ? 'On' : 'Off');

/**
 * Settings → About → Diagnostics: what support asks for when something looks wrong. The version and
 * build; memory, with the last warning iOS sent; and the display and accessibility settings Wallet adapts
 * to. Every value follows the iPhone while the screen is open. Share diagnostics sends them, with what
 * Wallet has cached, through the share sheet.
 */
export default function DiagnosticsRoute() {
  const { appearance } = useStore();
  const toast = useToast();
  const scheme = useColorScheme() === 'dark' ? 'Dark' : 'Light';
  const textSize = useTextSize();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();
  const increaseContrast = useIncreaseContrast();
  const voiceOver = useScreenReader();
  const memory = useMemoryWarnings();

  const sections: Array<{ title: string; rows: Array<{ label: string; value: string; detail?: string; testID: string }> }> = [
    { title: 'App', rows: [
      { label: 'Version', value: appVersion, testID: 'diagnostics-version' },
      { label: 'Build', value: buildName, testID: 'diagnostics-build' },
      { label: 'System', value: systemName, testID: 'diagnostics-system' },
      { label: 'Screen', value: `${Math.round(width)} × ${Math.round(height)} pt`, testID: 'diagnostics-screen' },
    ] },
    { title: 'Memory', rows: [
      { label: 'Last memory warning', value: memory.last === null ? 'None' : formatDay(memory.last, now()),
        detail: [
          memory.last === null ? null : formatDateTime(memory.last),
          memory.sinceLaunch
            ? `${memory.sinceLaunch} ${memory.sinceLaunch === 1 ? 'warning' : 'warnings'} since Wallet opened; cached data was given back to iOS.`
            : 'iOS sends one when it runs low on memory, and Wallet gives back its cached data.',
        ].filter(Boolean).join('. '),
        testID: 'diagnostics-memory-warning' },
    ] },
    { title: 'Display and accessibility', rows: [
      { label: 'Appearance', value: scheme, detail: appearance === 'system' ? 'Follows the iPhone' : 'Chosen in Settings → Appearance', testID: 'diagnostics-appearance' },
      { label: 'Text size', value: `${Math.round(textSize.scale * 100)}%`, detail: textSize.name, testID: 'diagnostics-text-size' },
      { label: 'Reduce Motion', value: onOff(reduceMotion), testID: 'diagnostics-reduce-motion' },
      { label: 'Reduce Transparency', value: onOff(reduceTransparency), testID: 'diagnostics-reduce-transparency' },
      { label: 'Increase Contrast', value: onOff(increaseContrast), testID: 'diagnostics-increase-contrast' },
      { label: 'VoiceOver', value: onOff(voiceOver), testID: 'diagnostics-voiceover' },
    ] },
  ];

  // What the caches hold depends on the screens visited, so it goes in the shared report, not on screen.
  const share = () => {
    const report = sections.map(({ title, rows }) => [title, ...rows.map(({ label, value, detail }) => `${label}: ${value}${detail ? ` (${detail})` : ''}`)].join('\n'));
    report.push(['Cached data', ...cachedEntries().map(({ name, entries }) => `${name}: ${entries}`)].join('\n'));
    Share.share({ message: `Wallet diagnostics\n\n${report.join('\n\n')}` }).catch(() => toast('Couldn’t open sharing', 'danger'));
  };

  return (
    <Screen title="Diagnostics" subtitle="Details support may ask for. They stay on this iPhone unless you share them."
      backFallback={() => router.replace('/about')}>
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={text.overline}>{section.title}</Text>
          <RowGroup>
            {section.rows.map((row) => <Row key={row.label} label={row.label} value={row.value} detail={row.detail} testID={row.testID} />)}
          </RowGroup>
        </View>
      ))}
      <Button label="Share diagnostics" variant="secondary" onPress={share} testID="diagnostics-share" />
    </Screen>
  );
}

const styles = StyleSheet.create({ section: { gap: space.sm } });
