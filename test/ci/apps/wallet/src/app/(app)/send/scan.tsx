import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { GlassButton } from '@/components/glass-button';
import { Icon } from '@/components/icon';
import { LightStatusBar } from '@/components/status-bar';
import { isExploreProfile } from '@/fixtures/runtime';
import { useAnnouncement, useRelayoutKey } from '@/lib/accessibility';
import { useOnActive } from '@/lib/app-state';
import { goBack } from '@/lib/navigation';
import { readPayCode } from '@/lib/pay-code';
import { colors, layout, radius, space, TITLE_MAX_SCALE } from '@/theme';

const VIEWFINDER = 248;
// The scanner is a camera view: like the iPhone's Camera, its words grow only so far, so the viewfinder keeps its room.
/** How long a message about a code stays up, and how long the same code is then ignored. */
const NOTICE_MS = 2_500;
const IGNORE_SAME_CODE_MS = 4_000;

type Notice = { title: string; body: string };

/**
 * Scan to pay: point the camera at a Wallet pay code (`wallet://pay?to=alex`) to open Send with that
 * recipient. The camera is asked for only when Scan a code is pressed; once allowed, it starts at
 * once on later visits, except in the explore profile, which always waits for the button.
 */
export default function ScanRoute() {
  const insets = useSafeAreaInsets();
  const relayout = useRelayoutKey();
  // Reads the permission when the screen opens; asking waits for the button.
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [started, setStarted] = useState(false);
  const [torch, setTorch] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const done = useRef(false);
  const ignored = useRef<{ data: string; at: number } | null>(null);

  useOnActive(() => { getPermission().catch(() => { /* Keep the last known permission. */ }); });
  // Besides a haptic, the notice is the only answer to a code, and it clears itself while scanning waits.
  useAnnouncement(notice ? `${notice.title}. ${notice.body}` : null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const live = !!permission?.granted && (started || !isExploreProfile);
  // Outside the explore profile a camera allowed earlier starts at once: show no button until that is known.
  const checking = !permission && !isExploreProfile;
  const denied = !!permission && !permission.granted && !permission.canAskAgain;
  const close = () => goBack(() => router.replace('/send'));

  const start = () => {
    const answer = permission?.granted ? Promise.resolve(permission) : requestPermission();
    answer.then((result) => { if (result.granted) setStarted(true); }, () => { /* No camera on this device. */ });
  };

  const onScanned = ({ data }: BarcodeScanningResult) => {
    if (done.current) return;
    const at = Date.now();
    if (ignored.current && ignored.current.data === data && at - ignored.current.at < IGNORE_SAME_CODE_MS) return;
    const code = readPayCode(data);
    if (code.kind === 'contact') {
      done.current = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => { /* No haptics on this device. */ });
      router.replace({ pathname: '/send/amount', params: { to: code.contact.id } });
      return;
    }
    ignored.current = { data, at };
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => { /* No haptics on this device. */ });
    setNotice(code.kind === 'unknown'
      ? { title: 'No one on Wallet has this code', body: 'Ask them for their latest Wallet code, or find them in Send.' }
      : { title: 'That’s not a Wallet code', body: 'Scan the pay code in a friend’s Wallet app.' });
  };

  return (
    <View style={styles.root}>
      <LightStatusBar />
      {live ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={notice ? undefined : onScanned} />
      ) : null}

      <View key={`bar-${relayout}`} style={[styles.bar, { paddingTop: insets.top + space.sm }]}>
        <GlassButton icon="close" label="Close" onPress={close} />
        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_MAX_SCALE}>Scan to pay</Text>
        {live ? (
          <GlassButton icon={torch ? 'flashlight' : 'flashlight-outline'} label={torch ? 'Turn off torch' : 'Turn on torch'} onPress={() => setTorch((on) => !on)} />
        ) : <View style={styles.barSpacer} />}
      </View>

      <View style={styles.middle}>
        <View style={[styles.viewfinder, !live && styles.viewfinderIdle]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {CORNERS.map((corner) => <View key={corner} style={[styles.corner, styles[corner]]} />)}
          {!live ? <Icon name="qr-code-outline" size={72} color={colors.onCardFaint} /> : null}
        </View>
      </View>

      <View key={`bottom-${relayout}`} style={[styles.bottom, { paddingBottom: insets.bottom + space.xl }]}>
        {notice ? (
          <View style={styles.notice} accessibilityLiveRegion="polite" testID="scan-notice">
            <Icon name="information-circle" size={22} color={colors.onCard} />
            <View style={styles.noticeTexts}>
              <Text style={styles.noticeTitle} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{notice.title}</Text>
              <Text style={styles.noticeBody} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{notice.body}</Text>
            </View>
          </View>
        ) : null}
        {checking ? null : live ? (
          <Text style={styles.hint} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Point your camera at a Wallet pay code. It scans by itself.</Text>
        ) : denied ? (
          <>
            <Text style={styles.heading} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Camera access is off</Text>
            <Text style={styles.hint} maxFontSizeMultiplier={TITLE_MAX_SCALE}>To scan pay codes, allow camera access in Settings → Wallet → Camera.</Text>
            <Button label="Open Settings" variant="inverse" onPress={() => Linking.openSettings()} testID="scan-settings" style={styles.stretch} />
          </>
        ) : (
          <>
            <Text style={styles.heading} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Pay with a QR code</Text>
            <Text style={styles.hint} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Scan a friend’s Wallet pay code to send them money. Wallet uses the camera only while you scan.</Text>
            <Button label="Scan a code" variant="inverse" onPress={start} testID="scan-start" style={styles.stretch} />
          </>
        )}
      </View>
    </View>
  );
}

const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const;
const CORNER = 36;
const EDGE = 4;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.brand },
  bar: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xl },
  barSpacer: { width: 44 },
  title: { flex: 1, textAlign: 'center', color: colors.onCard, fontSize: 17, fontWeight: '600' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewfinder: { width: VIEWFINDER, height: VIEWFINDER, alignItems: 'center', justifyContent: 'center' },
  viewfinderIdle: { backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: radius.xl },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: colors.onCard },
  topLeft: { top: 0, left: 0, borderTopWidth: EDGE, borderLeftWidth: EDGE, borderTopLeftRadius: radius.xl },
  topRight: { top: 0, right: 0, borderTopWidth: EDGE, borderRightWidth: EDGE, borderTopRightRadius: radius.xl },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: EDGE, borderLeftWidth: EDGE, borderBottomLeftRadius: radius.xl },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: EDGE, borderRightWidth: EDGE, borderBottomRightRadius: radius.xl },
  bottom: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center', paddingHorizontal: space.xl, gap: space.md, alignItems: 'center' },
  heading: { color: colors.onCard, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  hint: { color: colors.onCardMuted, fontSize: 15, textAlign: 'center' },
  stretch: { alignSelf: 'stretch', marginTop: space.sm },
  notice: { alignSelf: 'stretch', flexDirection: 'row', gap: space.md, alignItems: 'center', padding: space.lg, borderRadius: radius.lg, backgroundColor: 'rgba(0,0,0,0.72)' },
  noticeTexts: { flex: 1, gap: 2 },
  noticeTitle: { color: colors.onCard, fontSize: 15, fontWeight: '600' },
  noticeBody: { color: colors.onCardMuted, fontSize: 13 },
});
