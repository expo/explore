import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { formatMoney } from '@/lib/format';
import { useMotion } from '@/lib/motion';
import type { Currency } from '@/store/types';
import { AMOUNT_MAX_SCALE, colors } from '@/theme';

const DURATION_MS = 700;

/**
 * The balance counts up to its value when it first appears, and from the old value to the new one when
 * it changes. Without motion (Reduce Motion, or the explore profile) it shows the value at once.
 */
export function Balance({ cents, currency }: { cents: number; currency: Currency }) {
  const motion = useMotion();
  const [shown, setShown] = useState(motion ? 0 : cents);
  const latest = useRef(shown);
  latest.current = shown;
  useEffect(() => {
    const from = latest.current;
    if (!motion || from === cents) { setShown(cents); return; }
    const start = Date.now();
    let frame = 0;
    const tick = () => {
      const progress = Math.min(1, (Date.now() - start) / DURATION_MS);
      setShown(Math.round(from + (cents - from) * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cents, motion]);
  return <Text style={styles.amount} accessibilityLabel={formatMoney(cents, currency)} testID="home-balance"
    maxFontSizeMultiplier={AMOUNT_MAX_SCALE} numberOfLines={1} adjustsFontSizeToFit>{formatMoney(shown, currency)}</Text>;
}

const styles = StyleSheet.create({ amount: { fontSize: 40, fontWeight: '700', letterSpacing: -1.2, color: colors.onCard, fontVariant: ['tabular-nums'] } });
