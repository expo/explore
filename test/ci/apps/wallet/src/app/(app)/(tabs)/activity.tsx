import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card } from '@/components/card';
import { Screen } from '@/components/screen';
import { SearchField } from '@/components/search-field';
import { TransactionRow } from '@/components/transaction-row';
import { now } from '@/fixtures/runtime';
import { useAnnouncement } from '@/lib/accessibility';
import { formatDay, formatMoney } from '@/lib/format';
import { spendingInsight } from '@/lib/insights';
import { useStore } from '@/store/store';
import type { Currency, Transaction } from '@/store/types';
import { space, text } from '@/theme';

/** How long typing must pause before VoiceOver reads how many transactions match. */
const RESULTS_ANNOUNCEMENT_DELAY_MS = 700;

/** Whether a transaction matches a search: its title, who it was with, its reference or its amount. */
function matches(transaction: Transaction, needle: string, currency: Currency): boolean {
  const amount = formatMoney(transaction.amount, currency);
  return [transaction.title, transaction.counterparty, transaction.reference, amount, amount.replace(/[^\d.]/g, '')]
    .some((field) => field.toLowerCase().includes(needle));
}

export default function ActivityRoute() {
  const { session, wallet, currency } = useStore();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = !wallet ? [] : needle ? wallet.transactions.filter((transaction) => matches(transaction, needle, currency)) : wallet.transactions;
  const results = !needle ? null : shown.length
    ? `${shown.length} ${shown.length === 1 ? 'transaction' : 'transactions'} match “${query.trim()}”`
    : `No transactions match “${query.trim()}”. Try a name, a reference or an amount.`;
  useAnnouncement(results, RESULTS_ANNOUNCEMENT_DELAY_MS);
  if (!session || !wallet) return null;
  const reference = now();
  const groups: Array<{ day: string; items: Transaction[] }> = [];
  for (const transaction of shown) {
    const day = formatDay(transaction.at, reference);
    const group = groups.at(-1);
    if (group?.day === day) group.items.push(transaction); else groups.push({ day, items: [transaction] });
  }
  const { spent } = spendingInsight(session.email, wallet.transactions, reference);
  return (
    <Screen title="Activity" subtitle={`${formatMoney(spent, currency)} spent in the last 30 days`}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Search transactions" testID="activity-search" />
      {results ? <Text style={text.caption} accessibilityLiveRegion="polite" testID="activity-results">{results}</Text> : null}
      {groups.map((group) => (
        <View key={group.day} style={styles.group}>
          <Text style={text.overline}>{group.day}</Text>
          <Card style={styles.card}>
            {group.items.map((transaction, index) => (
              <TransactionRow key={transaction.id} transaction={transaction} currency={currency} last={index === group.items.length - 1}
                onPress={() => router.push({ pathname: '/transactions/[id]', params: { id: transaction.id } })} />
            ))}
          </Card>
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({ group: { gap: space.sm }, card: { paddingVertical: space.xs } });
