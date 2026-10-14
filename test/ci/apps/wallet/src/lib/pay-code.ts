import * as Linking from 'expo-linking';
import { CONTACTS, type Contact } from '@/fixtures/seed';

/**
 * What a scanned QR code means to Send:
 * - `contact`: a Wallet pay code for someone on Wallet;
 * - `unknown`: a Wallet pay code whose recipient is not on Wallet;
 * - `other`: any other code, such as a website or a ticket.
 */
export type PayCode = { kind: 'contact'; contact: Contact } | { kind: 'unknown' } | { kind: 'other' };

/**
 * Reads a Wallet pay code, `wallet://pay?to=<recipient>`. The recipient is a Wallet id (`alex`) or
 * handle (`@alexr`, with or without the @).
 */
export function readPayCode(data: string): PayCode {
  let parsed: ReturnType<typeof Linking.parse>;
  try {
    parsed = Linking.parse(data.trim());
  } catch {
    return { kind: 'other' };
  }
  if (parsed.scheme?.toLowerCase() !== 'wallet' || parsed.hostname?.toLowerCase() !== 'pay') return { kind: 'other' };
  const to = parsed.queryParams?.to;
  const recipient = (typeof to === 'string' ? to : '').trim().toLowerCase().replace(/^@/, '');
  const contact = CONTACTS.find((entry) => entry.id === recipient || entry.handle.slice(1) === recipient);
  return contact ? { kind: 'contact', contact } : { kind: 'unknown' };
}
