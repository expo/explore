import type { Recipient } from '@/lib/recipient';
import type { BillingCycle, Plan } from '@/store/types';

/** Free accounts pay 1% per transfer (at least 0.10); Premium transfers are free. */
export function feeFor(plan: Plan, amount: number): number {
  if (plan === 'premium') return 0;
  return Math.max(10, Math.round(amount / 100));
}

export type SendFailure = 'declined' | 'insufficient';
export type SendEvaluation = { ok: true; fee: number; total: number } | { ok: false; reason: SendFailure };

/**
 * Client-side outcome rules, documented in README.md:
 * - transfers to Dana Declined (on Wallet) are declined by the receiving bank;
 * - a total (amount + fee) above the balance fails with insufficient funds;
 * - every other transfer succeeds.
 */
export function evaluateSend(input: { plan: Plan; balance: number; recipient: Recipient; amount: number }): SendEvaluation {
  if (input.recipient.contact?.id === 'dana') return { ok: false, reason: 'declined' };
  const fee = feeFor(input.plan, input.amount);
  const total = input.amount + fee;
  if (total > input.balance) return { ok: false, reason: 'insufficient' };
  return { ok: true, fee, total };
}

/** Top-ups of exactly 13.00 are declined by the card issuer; every other top-up succeeds. */
export const DECLINED_TOPUP_AMOUNT = 1_300;
export const evaluateTopUp = (amount: number): { ok: boolean } => ({ ok: amount !== DECLINED_TOPUP_AMOUNT });

export const PREMIUM_PRICES: Record<BillingCycle, number> = { monthly: 499, annual: 3_999 };
export const PREMIUM_LIMITS = { freeCards: 1, premiumCards: 5 } as const;

/** Cash each plan can withdraw at ATMs each month without a fee, in minor units; after that, ATM_FEE_PERCENT. */
export const ATM_FREE_ALLOWANCE: Record<Plan, number> = { free: 20_000, premium: 80_000 };
export const ATM_FEE_PERCENT = 2;

/** Monthly spending limits a card can have, in minor units; null is no limit. */
export const CARD_LIMIT_OPTIONS: readonly (number | null)[] = [null, 25_000, 50_000, 100_000, 250_000];

export const failureMessage = (reason: string | undefined): { title: string; body: string } => {
  switch (reason) {
    case 'declined': return { title: 'Transfer declined', body: 'The recipient’s bank declined this transfer. No money left your wallet.' };
    case 'insufficient': return { title: 'Insufficient funds', body: 'This transfer, including its fee, is more than your available balance.' };
    default: return { title: 'Transfer failed', body: 'Something went wrong. No money left your wallet.' };
  }
};
