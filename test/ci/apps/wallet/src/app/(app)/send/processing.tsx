import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Spinner } from '@/components/spinner';
import { PROCESSING_DELAY_MS } from '@/fixtures/runtime';
import { formatMoney } from '@/lib/format';
import { useRelayoutKey } from '@/lib/accessibility';
import { alertTransferSent } from '@/lib/notifications';
import { recipientFrom, recipientParams, type RecipientParams } from '@/lib/recipient';
import { useStore } from '@/store/store';
import { colors, layout, space, text, TITLE_MAX_SCALE } from '@/theme';

/** Sends after a simulated network delay. `?hold=true` keeps this loading state on screen for capture. */
export default function ProcessingRoute() {
  const { to, name, amount, hold } = useLocalSearchParams<RecipientParams & { amount?: string; hold?: string }>();
  const { currency, wallet, send } = useStore();
  const relayout = useRelayoutKey();
  const started = useRef(false);
  // Read when the transfer completes, without restarting the timer when it changes.
  const alerts = useRef(false);
  alerts.current = !!wallet?.notifications;
  const recipient = useMemo(() => recipientFrom({ to, name }), [name, to]);
  const cents = Number(amount);

  useEffect(() => {
    if (hold === 'true' || started.current) return;
    started.current = true;
    const timer = setTimeout(() => {
      const result = recipient && Number.isInteger(cents) && cents > 0 ? send({ recipient, amount: cents }) : { ok: false as const, reason: 'declined' as const };
      if (!result.ok) {
        router.replace({ pathname: '/send/failed', params: { reason: result.reason, ...(recipient ? recipientParams(recipient) : { to: '' }), amount: amount ?? '' } });
        return;
      }
      // Transaction alerts: like Money sent, the alert gives what the recipient gets.
      if (alerts.current && recipient) {
        alertTransferSent({ transactionId: result.transactionId, amount: cents, currency, recipient: recipient.name }).catch(() => { /* The alert is best effort. */ });
      }
      router.replace({ pathname: '/send/success', params: { tx: result.transactionId } });
    }, PROCESSING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [amount, cents, currency, hold, recipient, send]);

  return (
    <View key={relayout} style={styles.root} testID="send-processing">
      <Spinner size="large" />
      <Text style={text.title} maxFontSizeMultiplier={TITLE_MAX_SCALE}>Sending…</Text>
      <Text style={[text.bodyMuted, styles.body]}>
        {recipient && cents > 0 ? `${formatMoney(cents, currency)} to ${recipient.name}` : 'Preparing your transfer'}
      </Text>
      <Text style={[text.caption, styles.caption]}>Keep the app open. This only takes a moment.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl, backgroundColor: colors.background },
  body: { textAlign: 'center', maxWidth: layout.contentMaxWidth },
  caption: { textAlign: 'center', maxWidth: layout.contentMaxWidth },
});
