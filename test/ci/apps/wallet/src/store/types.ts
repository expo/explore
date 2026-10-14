export type Currency = 'USD' | 'EUR' | 'GBP';
export type Plan = 'free' | 'premium';
export type BillingCycle = 'monthly' | 'annual';
export type TransactionKind = 'sent' | 'received' | 'topup' | 'subscription';
/** Settings → Appearance: follow the iPhone, or always light or dark. */
export type AppearancePreference = 'system' | 'light' | 'dark';

export type Transaction = {
  id: string;
  kind: TransactionKind;
  title: string;
  counterparty: string;
  /** Signed amount in minor units (cents). Negative leaves the wallet. */
  amount: number;
  /** Fee in minor units, already included in `amount`. */
  fee: number;
  at: number;
  status: 'completed' | 'failed';
  reference: string;
};

export type Card = {
  id: string;
  label: string;
  last4: string;
  expires: string;
  frozen: boolean;
  /** Monthly spending limit in minor units; absent or null is no limit. */
  monthlyLimit?: number | null;
};

export type Wallet = {
  balance: number;
  transactions: Transaction[];
  cards: Card[];
  plan: Plan;
  cycle: BillingCycle | null;
  renewsAt: number | null;
  /** Next transaction number; ids are `tx-0001`, `tx-0002`, … */
  counter: number;
  notifications: boolean;
};

export type Account = {
  name: string;
  email: string;
  passwordDigest: string;
  createdAt: number;
};

export type Session = { name: string; email: string; createdAt: number };

export type PersistedState = {
  version: 1;
  onboarded: boolean;
  currency: Currency;
  /** Device-wide, like the currency: it stays through sign-out and account deletion. */
  appearance: AppearancePreference;
  sessionEmail: string | null;
  accounts: Account[];
  wallets: Record<string, Wallet>;
};
