import { memoryCache } from '@/lib/memory';
import type { Transaction } from '@/store/types';

const MINUTE = 60_000;
const WINDOW = 30 * 24 * 60 * MINUTE;

/** Money out over the last 30 days: the total and how many payments made it. */
export type SpendingInsight = { spent: number; payments: number };

/** A few recent summaries, rebuilt after a memory warning. */
const insights = memoryCache<SpendingInsight>('Spending insights', { limit: 8 });

/**
 * Spending over the 30 days before `reference`, for the wallet of `owner`. Worked out once per owner,
 * activity and minute, which is as fine as any screen shows it.
 */
export function spendingInsight(owner: string, transactions: readonly Transaction[], reference: number): SpendingInsight {
  const minute = Math.floor(reference / MINUTE);
  const key = `${owner}:${transactions.length}:${transactions[0]?.id ?? ''}:${minute}`;
  return insights.get(key, () => {
    const since = minute * MINUTE - WINDOW;
    const payments = transactions.filter((entry) => entry.amount < 0 && entry.at > since);
    return { spent: payments.reduce((sum, entry) => sum - entry.amount, 0), payments: payments.length };
  });
}
