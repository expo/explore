import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { CardArt, cardArt } from '@/components/card-art';
import { GlassButton } from '@/components/glass-button';
import { Icon } from '@/components/icon';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { Sheet } from '@/components/sheet';
import { LightStatusBar } from '@/components/status-bar';
import { useToast } from '@/components/toast';
import { useRelayoutKey } from '@/lib/accessibility';
import { cardNumber, cardSecurityCode } from '@/lib/card';
import { formatMoney } from '@/lib/format';
import { goBack } from '@/lib/navigation';
import { CARD_LIMIT_OPTIONS } from '@/store/rules';
import { useStore } from '@/store/store';
import type { Card, Currency } from '@/store/types';
import { colors, layout, radius, space, text, TITLE_MAX_SCALE } from '@/theme';

type Panel = 'freeze' | 'details' | 'limits' | null;

const limitLabel = (limit: number | null | undefined, currency: Currency) => (limit ? formatMoney(limit, currency) : 'No limit');

/**
 * One virtual card: its art large on top, with glass controls over it, and a native bottom toolbar to
 * freeze it, show its details or set a monthly limit.
 */
export default function CardRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, wallet, currency, setCardFrozen, setCardLimit } = useStore();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [numberShown, setNumberShown] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const card = wallet?.cards.find((entry) => entry.id === id);
  if (!session || !wallet) return null;
  if (!card) {
    return <Screen title="Card not found" subtitle="It may have been removed from your wallet."
      backFallback={() => router.replace('/cards')}><View /></Screen>;
  }

  const toggleFrozen = () => {
    if (!card.frozen) { setPanel('freeze'); return; }
    setCardFrozen(card.id, false);
    toast('Card unfrozen');
  };
  const chooseLimit = (limit: number | null) => {
    setPanel(null);
    if (limit === (card.monthlyLimit ?? null)) return;
    setCardLimit(card.id, limit);
    toast(limit ? `Monthly limit set to ${formatMoney(limit, currency)}` : 'Monthly limit removed', 'success');
  };

  return (
    <View style={styles.root}>
      <LightStatusBar />
      {/* The bottom toolbar is part of this screen's safe area, which only a provider inside the screen sees. The
          sheets stay outside it: they cover the toolbar. */}
      <SafeAreaProvider>
        <ToolbarScrollView>
          {/* The backdrop carries the card's lights; a frozen card is unlit. */}
          <View style={[styles.hero, !card.frozen && { experimental_backgroundImage: cardArt(card) }, { paddingTop: insets.top + space.sm }]}>
            <View style={[styles.heroBar, styles.cardWidth]}>
              <GlassButton icon="chevron-back" label="Back" onPress={() => goBack(() => router.replace('/cards'))} />
              <Text style={styles.heroTitle} accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{card.label}</Text>
              <GlassButton icon={numberShown ? 'eye-off-outline' : 'eye-outline'} label={numberShown ? 'Hide card number' : 'Show card number'}
                onPress={() => setNumberShown((shown) => !shown)} testID="card-number-toggle" />
            </View>
            <CardArt card={card} holder={session.name} number={numberShown ? cardNumber(card) : undefined} style={styles.art} />
            <Text style={[styles.heroCaption, styles.cardWidth]}>Virtual debit card · {card.frozen ? 'Frozen' : 'Active'}</Text>
          </View>

          <View style={[styles.body, styles.readable]}>
            {card.frozen ? (
              <Banner tone="info" title="This card is frozen" body="Payments and withdrawals are declined until you unfreeze it." testID="card-frozen" />
            ) : null}
            <View style={styles.section}>
              <Text style={text.overline}>Spending</Text>
              <RowGroup>
                <Row label="Monthly limit" value={limitLabel(card.monthlyLimit, currency)} onPress={() => setPanel('limits')} testID="card-limit" />
              </RowGroup>
            </View>
            <View style={styles.section}>
              <Text style={text.overline}>Card</Text>
              <RowGroup>
                <Row label="Status" value={card.frozen ? 'Frozen' : 'Active'} />
                <Row label="Number" value={`•••• ${card.last4}`} />
                <Row label="Expires" value={card.expires} />
                <Row label="Type" value="Virtual debit" />
              </RowGroup>
            </View>
            <Text style={[text.caption, styles.note]}>
              Use this card for online and in-app payments. Freezing it blocks new payments at once; unfreeze it whenever you like.
            </Text>
          </View>
        </ToolbarScrollView>
      </SafeAreaProvider>

      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button icon={card.frozen ? 'sun.max' : 'snowflake'} tintColor={colors.ink} onPress={toggleFrozen}>
          {card.frozen ? 'Unfreeze' : 'Freeze'}
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="creditcard.and.123" tintColor={colors.ink} onPress={() => setPanel('details')}>Details</Stack.Toolbar.Button>
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="gauge.with.needle" tintColor={colors.ink} onPress={() => setPanel('limits')}>Limits</Stack.Toolbar.Button>
      </Stack.Toolbar>

      <Sheet visible={panel === 'freeze'} onClose={() => setPanel(null)} title="Freeze this card?" testID="freeze-sheet">
        <Text style={text.bodyMuted}>Payments and withdrawals with •••• {card.last4} will be declined until you unfreeze it.</Text>
        <Button label="Freeze card" onPress={() => { setCardFrozen(card.id, true); setPanel(null); toast('Card frozen'); }} testID="freeze-confirm" />
        <Button label="Cancel" variant="ghost" onPress={() => setPanel(null)} />
      </Sheet>

      <Sheet visible={panel === 'details'} onClose={() => setPanel(null)} title="Card details" testID="card-details-sheet">
        <CardDetails card={card} holder={session.name} />
        <Text style={text.caption}>Enter these at checkout. Wallet never asks for your security code by phone, email or message.</Text>
        <Button label="Done" variant="secondary" onPress={() => setPanel(null)} testID="card-details-done" />
      </Sheet>

      <Sheet visible={panel === 'limits'} onClose={() => setPanel(null)} title="Monthly spending limit" testID="card-limits-sheet">
        <Text style={text.bodyMuted}>Card payments over the limit are declined until the 1st of next month.</Text>
        <View style={styles.options} accessibilityRole="radiogroup">
          {CARD_LIMIT_OPTIONS.map((limit) => {
            const selected = limit === (card.monthlyLimit ?? null);
            const label = limitLabel(limit, currency);
            return (
              <Pressable key={label} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label} onPress={() => chooseLimit(limit)}
                style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
                <Text style={text.body}>{label}</Text>
                {selected ? <Icon name="checkmark" size={20} color={colors.ink} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </View>
  );
}

/** Scrolls the page to its end above the bottom toolbar; laid out again when the text size changes. */
function ToolbarScrollView({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView key={useRelayoutKey()} contentInsetAdjustmentBehavior="never" contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}>
      {children}
    </ScrollView>
  );
}

/** Number, expiry, security code and name, selectable for pasting into a checkout form. */
function CardDetails({ card, holder }: { card: Card; holder: string }) {
  const lines: Array<[string, string]> = [
    ['Card number', cardNumber(card)],
    ['Expires', card.expires],
    ['Security code', cardSecurityCode(card)],
    ['Name on card', holder],
  ];
  return (
    <View style={styles.details}>
      {lines.map(([label, value]) => (
        <View key={label} style={styles.detail}>
          <Text style={text.caption}>{label}</Text>
          <Text style={styles.detailValue} selectable>{value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  hero: { backgroundColor: colors.cardBackdrop, paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.lg },
  heroBar: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // On a wide screen the controls line up with the card, and the details below keep a readable width.
  cardWidth: { width: '100%', maxWidth: layout.cardMaxWidth, alignSelf: 'center' },
  readable: { width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
  heroTitle: { flex: 1, textAlign: 'center', color: colors.onCard, fontSize: 17, fontWeight: '600' },
  art: { borderColor: colors.onCardTrack },
  heroCaption: { color: colors.onCardMuted, fontSize: 13, textAlign: 'center' },
  body: { padding: space.xl, gap: space.lg },
  section: { gap: space.sm },
  note: { textAlign: 'center', paddingHorizontal: space.sm },
  options: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  option: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { backgroundColor: colors.accentSoft },
  details: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md },
  detail: { gap: 2 },
  detailValue: { fontSize: 18, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'], letterSpacing: 0.5 },
});
