import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { maskedCardNumber } from '@/lib/card';
import { memoryCache } from '@/lib/memory';
import type { Card } from '@/store/types';
import { colors, GLYPH_MAX_SCALE, layout, radius, space } from '@/theme';

/** Each card's two lights, as RGB: the first card is violet and blue, the next ones each get their own pair. */
const LIGHTS: ReadonlyArray<readonly [string, string]> = [
  ['139,92,246', '56,189,248'],
  ['16,185,129', '34,211,238'],
  ['244,63,94', '251,191,36'],
  ['59,130,246', '217,70,239'],
  ['245,158,11', '132,204,22'],
];

/** Card art is built once per card and kept until iOS runs low on memory. */
const art = memoryCache<string>('Card art');

/**
 * Two soft lights over a dark surface: the art of a card and of the backdrop behind a large card. The art
 * is dark in both appearances, so the lights are plain colors, not theme tokens.
 */
export function cardArt(card: Card): string {
  return art.get(card.id, () => {
    const number = Number(card.id.replace(/\D/g, '')) || 1;
    const [top, bottom] = LIGHTS[(number - 1) % LIGHTS.length]!;
    return `radial-gradient(circle at 100% 0%, rgba(${top},0.6) 0%, rgba(${top},0) 60%), `
      + `radial-gradient(circle at 0% 100%, rgba(${bottom},0.45) 0%, rgba(${bottom},0) 55%)`;
  });
}

/**
 * The face of a virtual card: brand, number, holder and expiry, lit by its `cardArt`. A frozen card is
 * grey and unlit. `number` shows the full number in place of the masked one.
 */
export function CardArt({ card, holder, number, style }: { card: Card; holder: string; number?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.card, card.frozen ? styles.frozen : { experimental_backgroundImage: cardArt(card) }, style]}>
      <View style={styles.top}>
        <Text style={styles.brand} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>Wallet</Text>
        {card.frozen ? <Text style={styles.frozenTag} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>Frozen</Text> : null}
      </View>
      <Text style={styles.number} maxFontSizeMultiplier={GLYPH_MAX_SCALE} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={number ? `Card number ${number}` : `Card number ending ${card.last4}`}>
        {number ?? maskedCardNumber(card)}
      </Text>
      <View style={styles.bottom}>
        <Text style={[styles.meta, styles.holder]} maxFontSizeMultiplier={GLYPH_MAX_SCALE} numberOfLines={1}>{holder.toUpperCase()}</Text>
        <Text style={styles.meta} maxFontSizeMultiplier={GLYPH_MAX_SCALE}>{card.expires}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // A card keeps about its phone size on a wide screen.
  card: { width: '100%', maxWidth: layout.cardMaxWidth, alignSelf: 'center', height: 200, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.cardLine, padding: space.xl, backgroundColor: colors.card, justifyContent: 'space-between', overflow: 'hidden' },
  frozen: { backgroundColor: colors.cardFrozen, borderColor: colors.cardFrozen },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: colors.onCard, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  frozenTag: { color: colors.card, backgroundColor: colors.onCard, fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' },
  number: { color: colors.onCard, fontSize: 20, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  holder: { flexShrink: 1 },
  meta: { color: colors.onCardMuted, fontSize: 13, fontWeight: '600', letterSpacing: 1 },
});
