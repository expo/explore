import { Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { Sheet } from '@/components/sheet';
import { useToast } from '@/components/toast';
import { CONTACTS } from '@/fixtures/seed';
import { formatDateTime, formatMoney } from '@/lib/format';
import type { Currency, Transaction } from '@/store/types';
import { colors, radius, space, text } from '@/theme';

const REASONS = ['I don’t recognise this', 'Wrong amount', 'Something else'];

/** The receipt a transaction shares: what, how much, with whom, when, and the reference to quote. */
function receiptOf(transaction: Transaction, currency: Currency): string {
  return [
    `Wallet receipt: ${transaction.title}`,
    `${formatMoney(transaction.amount, currency, { sign: true })} ${transaction.amount > 0 ? 'from' : 'to'} ${transaction.counterparty}`,
    formatDateTime(transaction.at),
    `Fee: ${transaction.fee ? formatMoney(transaction.fee, currency) : 'None'}`,
    `Status: ${transaction.status === 'completed' ? 'Completed' : 'Failed'}`,
    `Reference: ${transaction.reference}`,
  ].join('\n');
}

const namesOf = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '');

/**
 * A transaction's native bottom toolbar: Share receipt (the system share sheet), Split (request shares
 * from contacts) and Report a problem. Split is off for money that came in.
 */
export function TransactionActions({ transaction, currency }: { transaction: Transaction; currency: Currency }) {
  const toast = useToast();
  const [panel, setPanel] = useState<'split' | 'report' | null>(null);
  const [splitWith, setSplitWith] = useState<string[]>([]);
  const splittable = transaction.amount < 0 && transaction.status === 'completed';
  // The payment itself, without Wallet's fee, is what gets split; everyone pays an equal share, you included.
  const total = -transaction.amount - transaction.fee;
  const share = Math.round(total / (splitWith.length + 1));
  const people = CONTACTS.filter((contact) => contact.name !== transaction.counterparty);

  const shareReceipt = () => {
    Share.share({ message: receiptOf(transaction, currency) }).catch(() => toast('Couldn’t open sharing', 'danger'));
  };
  const openSplit = () => { setSplitWith([]); setPanel('split'); };
  const toggle = (id: string) => setSplitWith((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  const requestShares = () => {
    const names = people.filter((contact) => splitWith.includes(contact.id)).map((contact) => contact.name.split(' ')[0]!);
    setPanel(null);
    toast(`Requested ${formatMoney(share, currency)} from ${namesOf(names)}`, 'success');
  };

  return (
    <>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button icon="square.and.arrow.up" tintColor={colors.ink} onPress={shareReceipt}>Share receipt</Stack.Toolbar.Button>
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="person.2" tintColor={colors.ink} disabled={!splittable} onPress={openSplit}>Split</Stack.Toolbar.Button>
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="exclamationmark.bubble" tintColor={colors.ink} onPress={() => setPanel('report')}>Report a problem</Stack.Toolbar.Button>
      </Stack.Toolbar>

      <Sheet visible={panel === 'split'} onClose={() => setPanel(null)} title="Split this payment" testID="split-sheet">
        <Text style={text.bodyMuted}>Choose who shares the {formatMoney(total, currency)}. Everyone pays the same, you included.</Text>
        <View style={styles.people}>
          {people.map((contact, index) => {
            const checked = splitWith.includes(contact.id);
            return (
              <Pressable key={contact.id} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={contact.name} onPress={() => toggle(contact.id)}
                style={({ pressed }) => [styles.person, index < people.length - 1 && styles.divider, pressed && styles.pressed]}>
                <Avatar name={contact.name} size={36} />
                <Text style={[text.body, styles.name]}>{contact.name}</Text>
                <View style={[styles.check, checked && styles.checked]}>
                  {checked ? <Icon name="checkmark" size={14} color={colors.onAccent} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
        <Button label={splitWith.length ? `Request ${formatMoney(share, currency)} each` : 'Choose people to split with'} disabled={!splitWith.length}
          onPress={requestShares} testID="split-request" />
      </Sheet>

      <Sheet visible={panel === 'report'} onClose={() => setPanel(null)} title="What went wrong?" testID="report-sheet">
        {REASONS.map((reason) => (
          <Button key={reason} label={reason} variant="secondary" onPress={() => { setPanel(null); toast('Thanks — we’ll look into it', 'success'); }} />
        ))}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  people: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg },
  person: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.7 },
  name: { flex: 1 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center' },
  checked: { borderColor: colors.accent, backgroundColor: colors.accent },
});
