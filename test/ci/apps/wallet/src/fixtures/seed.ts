import type { Transaction, Wallet } from '@/store/types';

export type Contact = { id: string; name: string; handle: string };

/**
 * Recipients available in the Send flow. "Dana Declined" is the documented failure case: every
 * transfer to this contact is declined by the (simulated) receiving bank.
 */
export const CONTACTS: Contact[] = [
  { id: 'alex', name: 'Alex Rivera', handle: '@alexr' },
  { id: 'sam', name: 'Sam Okafor', handle: '@samo' },
  { id: 'mia', name: 'Mia Chen', handle: '@miac' },
  { id: 'dana', name: 'Dana Declined', handle: '@dana' },
  { id: 'noah', name: 'Noah Patel', handle: '@noahp' },
];

export const contactById = (id: string | undefined) => CONTACTS.find((contact) => contact.id === id);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Fixed starting balance in minor units: 1,250.00. */
export const SEED_BALANCE = 125_000;

/** The wallet every new account starts with. Timestamps are relative to `at`. */
export function seedWallet(at: number): Wallet {
  const history: Array<Omit<Transaction, 'id' | 'reference' | 'status'>> = [
    { kind: 'received', title: 'Payment received', counterparty: 'Alex Rivera', amount: 4_500, fee: 0, at: at - 2 * HOUR },
    { kind: 'sent', title: 'Dinner split', counterparty: 'Sam Okafor', amount: -2_825, fee: 25, at: at - 5 * HOUR },
    { kind: 'topup', title: 'Top up', counterparty: 'Visa •••• 4242', amount: 20_000, fee: 0, at: at - 1 * DAY - 3 * HOUR },
    { kind: 'sent', title: 'Concert tickets', counterparty: 'Mia Chen', amount: -9_090, fee: 90, at: at - 1 * DAY - 6 * HOUR },
    { kind: 'received', title: 'Refund', counterparty: 'Noah Patel', amount: 1_200, fee: 0, at: at - 2 * DAY - 1 * HOUR },
    { kind: 'sent', title: 'Groceries', counterparty: 'Alex Rivera', amount: -3_636, fee: 36, at: at - 3 * DAY - 2 * HOUR },
    { kind: 'sent', title: 'Coffee', counterparty: 'Sam Okafor', amount: -454, fee: 4, at: at - 3 * DAY - 9 * HOUR },
    { kind: 'topup', title: 'Top up', counterparty: 'Visa •••• 4242', amount: 50_000, fee: 0, at: at - 5 * DAY - 4 * HOUR },
    { kind: 'received', title: 'Payment received', counterparty: 'Mia Chen', amount: 8_000, fee: 0, at: at - 6 * DAY - 2 * HOUR },
    { kind: 'sent', title: 'Rent share', counterparty: 'Noah Patel', amount: -60_600, fee: 600, at: at - 8 * DAY - 5 * HOUR },
    { kind: 'received', title: 'Payment received', counterparty: 'Alex Rivera', amount: 12_000, fee: 0, at: at - 9 * DAY - 1 * HOUR },
    { kind: 'topup', title: 'Top up', counterparty: 'Visa •••• 4242', amount: 100_000, fee: 0, at: at - 10 * DAY - 3 * HOUR },
  ];
  const transactions = history.map((entry, index) => {
    const number = history.length - index;
    return { ...entry, id: `tx-${String(number).padStart(4, '0')}`, reference: `WLT-${String(100_000 + number * 7)}`, status: 'completed' as const };
  });
  return {
    balance: SEED_BALANCE,
    transactions,
    cards: [{ id: 'card-1', label: 'Wallet Virtual', last4: '4242', expires: '09/29', frozen: false }],
    plan: 'free',
    cycle: null,
    renewsAt: null,
    counter: history.length + 1,
    notifications: true,
  };
}
