import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Banner } from '@/components/banner';
import { Button } from '@/components/button';
import { CardArt } from '@/components/card-art';
import { Row, RowGroup } from '@/components/row';
import { Screen } from '@/components/screen';
import { Sheet } from '@/components/sheet';
import { useToast } from '@/components/toast';
import { PREMIUM_LIMITS } from '@/store/rules';
import { useStore } from '@/store/store';
import type { Card } from '@/store/types';
import { space, text } from '@/theme';

export default function CardsRoute() {
  const { session, wallet, setCardFrozen, addCard } = useStore();
  const toast = useToast();
  const [confirming, setConfirming] = useState<Card | null>(null);
  if (!session || !wallet) return null;
  const limit = wallet.plan === 'premium' ? PREMIUM_LIMITS.premiumCards : PREMIUM_LIMITS.freeCards;
  const atLimit = wallet.cards.length >= limit;

  const onAdd = () => {
    if (atLimit && wallet.plan === 'free') { router.push('/paywall'); return; }
    if (addCard().ok) toast('Virtual card added', 'success'); else toast(`You can have up to ${limit} cards`, 'danger');
  };

  return (
    <Screen title="Cards" subtitle={`${wallet.cards.length} of ${limit} virtual cards`}>
      {wallet.cards.map((card) => (
        <View key={card.id} style={styles.cardBlock}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${card.label}, ending ${card.last4}${card.frozen ? ', frozen' : ''}`} accessibilityHint="Opens the card's details"
            onPress={() => router.push({ pathname: '/cards/[id]', params: { id: card.id } })} style={({ pressed }) => pressed && styles.pressed}>
            <CardArt card={card} holder={session.name} />
          </Pressable>
          <RowGroup>
            <Row label="Freeze card" detail={card.frozen ? 'Payments with this card are blocked' : 'Temporarily block payments'}
              right={<Switch accessibilityLabel={`Freeze ${card.label}`} value={card.frozen} onValueChange={(frozen) => (frozen ? setConfirming(card) : (setCardFrozen(card.id, false), toast('Card unfrozen')))} />} />
            <Row label="Details and limits" detail="Card number, security code and monthly limit"
              onPress={() => router.push({ pathname: '/cards/[id]', params: { id: card.id } })} />
          </RowGroup>
        </View>
      ))}
      {atLimit && wallet.plan === 'free' ? (
        <Banner tone="premium" title="Need another card?" body="Premium includes up to 5 virtual cards." />
      ) : null}
      <Button label="Add virtual card" variant="secondary" onPress={onAdd} testID="cards-add" />

      <Sheet visible={confirming !== null} onClose={() => setConfirming(null)} title="Freeze this card?" testID="freeze-sheet">
        <Text style={text.bodyMuted}>Payments and withdrawals with •••• {confirming?.last4} will be declined until you unfreeze it.</Text>
        <Button label="Freeze card" onPress={() => { if (confirming) setCardFrozen(confirming.id, true); setConfirming(null); toast('Card frozen'); }} testID="freeze-confirm" />
        <Button label="Cancel" variant="ghost" onPress={() => setConfirming(null)} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardBlock: { gap: space.md },
  pressed: { opacity: 0.85 },
});
