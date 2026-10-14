import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { now } from '@/fixtures/runtime';
import { seedWallet } from '@/fixtures/seed';
import type { Recipient } from '@/lib/recipient';
import { evaluateSend, evaluateTopUp, PREMIUM_LIMITS, PREMIUM_PRICES, type SendFailure } from '@/store/rules';
import type { AppearancePreference, BillingCycle, Currency, PersistedState, Session, Transaction, Wallet } from '@/store/types';

const STORAGE_KEY = 'wallet.state.v1';
const MONTH = 30 * 24 * 60 * 60 * 1000;
const YEAR = 365 * 24 * 60 * 60 * 1000;

const initialState: PersistedState = { version: 1, onboarded: false, currency: 'USD', appearance: 'system', sessionEmail: null, accounts: [], wallets: {} };
const APPEARANCES: readonly AppearancePreference[] = ['system', 'light', 'dark'];

export type SendResult = { ok: true; transactionId: string } | { ok: false; reason: SendFailure };
export type AuthResult = { ok: true } | { ok: false; error: string };

type Store = {
  hydrated: boolean;
  onboarded: boolean;
  currency: Currency;
  appearance: AppearancePreference;
  session: Session | null;
  wallet: Wallet | null;
  completeOnboarding: (currency: Currency) => void;
  signUp: (input: { name: string; email: string; password: string }) => Promise<AuthResult>;
  signIn: (input: { email: string; password: string }) => Promise<AuthResult>;
  signOut: () => void;
  deleteAccount: () => void;
  updateName: (name: string) => void;
  send: (input: { recipient: Recipient; amount: number }) => SendResult;
  topUp: (amount: number) => { ok: boolean };
  subscribe: (cycle: BillingCycle) => void;
  switchCycle: (cycle: BillingCycle) => void;
  cancelPlan: () => void;
  addCard: () => { ok: boolean };
  setCardFrozen: (cardId: string, frozen: boolean) => void;
  setCardLimit: (cardId: string, monthlyLimit: number | null) => void;
  setNotifications: (enabled: boolean) => void;
  setAppearance: (appearance: AppearancePreference) => void;
};

const StoreContext = createContext<Store | null>(null);

const normalizeEmail = (input: string) => input.trim().toLowerCase();
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const digest = (email: string, password: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${email}:${password}`);

function parseState(raw: string | null): PersistedState {
  if (!raw) return initialState;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.accounts) && parsed.wallets) {
      // State saved before Settings → Appearance existed follows the system.
      const appearance = APPEARANCES.find((value) => value === parsed.appearance) ?? initialState.appearance;
      return { ...(parsed as PersistedState), appearance };
    }
  } catch { /* Corrupt storage resets to the initial state. */ }
  return initialState;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => { if (!cancelled) { setState(parseState(raw)); setHydrated(true); } },
      () => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (hydrated) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => { /* Storage failures keep the in-memory state. */ });
  }, [hydrated, state]);

  const patch = useCallback((update: (previous: PersistedState) => PersistedState) => {
    const next = update(latest.current);
    latest.current = next;
    setState(next);
  }, []);

  const patchWallet = useCallback((update: (wallet: Wallet) => Wallet) => patch((previous) => {
    const email = previous.sessionEmail;
    const wallet = email ? previous.wallets[email] : undefined;
    if (!email || !wallet) return previous;
    return { ...previous, wallets: { ...previous.wallets, [email]: update(wallet) } };
  }), [patch]);

  const session = useMemo<Session | null>(() => {
    const account = state.accounts.find((entry) => entry.email === state.sessionEmail);
    return account ? { name: account.name, email: account.email, createdAt: account.createdAt } : null;
  }, [state.accounts, state.sessionEmail]);
  const wallet = (state.sessionEmail && state.wallets[state.sessionEmail]) || null;

  const store = useMemo<Store>(() => ({
    hydrated, onboarded: state.onboarded, currency: state.currency, appearance: state.appearance, session, wallet,
    completeOnboarding: (currency) => patch((previous) => ({ ...previous, onboarded: true, currency })),
    async signUp({ name, email: emailInput, password }) {
      const email = normalizeEmail(emailInput);
      if (!name.trim()) return { ok: false, error: 'Enter your name.' };
      if (!validEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
      if (password.length < 8) return { ok: false, error: 'Use a password with at least 8 characters.' };
      if (latest.current.accounts.some((account) => account.email === email)) return { ok: false, error: 'An account with this email already exists. Sign in instead.' };
      const passwordDigest = await digest(email, password);
      const at = now();
      patch((previous) => ({ ...previous, sessionEmail: email,
        accounts: [...previous.accounts, { name: name.trim(), email, passwordDigest, createdAt: at }],
        wallets: { ...previous.wallets, [email]: seedWallet(at) } }));
      return { ok: true };
    },
    async signIn({ email: emailInput, password }) {
      const email = normalizeEmail(emailInput);
      if (!validEmail(email)) return { ok: false, error: 'Enter a valid email address.' };
      const account = latest.current.accounts.find((entry) => entry.email === email);
      if (!account || account.passwordDigest !== await digest(email, password)) return { ok: false, error: 'Incorrect email or password.' };
      patch((previous) => ({ ...previous, sessionEmail: email }));
      return { ok: true };
    },
    signOut: () => patch((previous) => ({ ...previous, sessionEmail: null })),
    deleteAccount: () => patch((previous) => {
      const email = previous.sessionEmail;
      if (!email) return previous;
      const { [email]: _removed, ...wallets } = previous.wallets;
      return { ...previous, sessionEmail: null, accounts: previous.accounts.filter((account) => account.email !== email), wallets };
    }),
    updateName: (name) => patch((previous) => ({ ...previous,
      accounts: previous.accounts.map((account) => account.email === previous.sessionEmail ? { ...account, name: name.trim() || account.name } : account) })),
    send({ recipient, amount }) {
      const current = latest.current;
      const currentWallet = current.sessionEmail ? current.wallets[current.sessionEmail] : undefined;
      if (!currentWallet) return { ok: false, reason: 'declined' };
      const evaluation = evaluateSend({ plan: currentWallet.plan, balance: currentWallet.balance, recipient, amount });
      if (!evaluation.ok) return evaluation;
      const transactionId = `tx-${String(currentWallet.counter).padStart(4, '0')}`;
      const transaction: Transaction = { id: transactionId, kind: 'sent', title: `Sent to ${recipient.name}`, counterparty: recipient.name,
        amount: -evaluation.total, fee: evaluation.fee, at: now(), status: 'completed', reference: `WLT-${String(100_000 + currentWallet.counter * 7)}` };
      patchWallet((entry) => ({ ...entry, balance: entry.balance - evaluation.total, counter: entry.counter + 1, transactions: [transaction, ...entry.transactions] }));
      return { ok: true, transactionId };
    },
    topUp(amount) {
      const evaluation = evaluateTopUp(amount);
      if (evaluation.ok) patchWallet((entry) => ({ ...entry, balance: entry.balance + amount, counter: entry.counter + 1,
        transactions: [{ id: `tx-${String(entry.counter).padStart(4, '0')}`, kind: 'topup', title: 'Top up', counterparty: 'Visa •••• 4242', amount, fee: 0,
          at: now(), status: 'completed', reference: `WLT-${String(100_000 + entry.counter * 7)}` }, ...entry.transactions] }));
      return evaluation;
    },
    subscribe: (cycle) => patchWallet((entry) => ({ ...entry, plan: 'premium', cycle, renewsAt: now() + (cycle === 'annual' ? YEAR : MONTH), counter: entry.counter + 1,
      balance: entry.balance - PREMIUM_PRICES[cycle],
      transactions: [{ id: `tx-${String(entry.counter).padStart(4, '0')}`, kind: 'subscription', title: 'Wallet Premium', counterparty: cycle === 'annual' ? 'Annual plan' : 'Monthly plan',
        amount: -PREMIUM_PRICES[cycle], fee: 0, at: now(), status: 'completed', reference: `WLT-${String(100_000 + entry.counter * 7)}` }, ...entry.transactions] })),
    switchCycle: (cycle) => patchWallet((entry) => entry.plan === 'premium' ? { ...entry, cycle, renewsAt: now() + (cycle === 'annual' ? YEAR : MONTH) } : entry),
    // Cards beyond the Free allowance stay, frozen, until the next upgrade.
    cancelPlan: () => patchWallet((entry) => ({ ...entry, plan: 'free', cycle: null, renewsAt: null,
      cards: entry.cards.map((card, index) => (index >= PREMIUM_LIMITS.freeCards ? { ...card, frozen: true } : card)) })),
    addCard() {
      const current = latest.current;
      const currentWallet = current.sessionEmail ? current.wallets[current.sessionEmail] : undefined;
      if (!currentWallet) return { ok: false };
      const limit = currentWallet.plan === 'premium' ? PREMIUM_LIMITS.premiumCards : PREMIUM_LIMITS.freeCards;
      if (currentWallet.cards.length >= limit) return { ok: false };
      const number = currentWallet.cards.length + 1;
      patchWallet((entry) => ({ ...entry, cards: [...entry.cards, { id: `card-${number}`, label: `Wallet Virtual ${number}`, last4: String(8_000 + number * 37).slice(-4), expires: '09/29', frozen: false }] }));
      return { ok: true };
    },
    setCardFrozen: (cardId, frozen) => patchWallet((entry) => ({ ...entry, cards: entry.cards.map((card) => card.id === cardId ? { ...card, frozen } : card) })),
    setCardLimit: (cardId, monthlyLimit) => patchWallet((entry) => ({ ...entry, cards: entry.cards.map((card) => card.id === cardId ? { ...card, monthlyLimit } : card) })),
    setNotifications: (enabled) => patchWallet((entry) => ({ ...entry, notifications: enabled })),
    setAppearance: (appearance) => patch((previous) => ({ ...previous, appearance })),
  }), [hydrated, patch, patchWallet, session, state.appearance, state.currency, state.onboarded, wallet]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}
