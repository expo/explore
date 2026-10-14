import type { Currency } from '@/store/types';

const money = new Map<Currency, Intl.NumberFormat>();

/** Formats minor units with a fixed locale so both comparison sides render identically. */
export function formatMoney(cents: number, currency: Currency, options: { sign?: boolean } = {}): string {
  let formatter = money.get(currency);
  if (!formatter) { formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency }); money.set(currency, formatter); }
  const value = formatter.format(Math.abs(cents) / 100);
  if (options.sign) return `${cents < 0 ? '−' : '+'}${value}`;
  return cents < 0 ? `−${value}` : value;
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDateFormat = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

export const formatDate = (at: number) => dateFormat.format(at);
export const formatLongDate = (at: number) => longDateFormat.format(at);
export const formatDateTime = (at: number) => `${longDateFormat.format(at)} · ${timeFormat.format(at)} UTC`;

const dayKey = (at: number) => Math.floor(at / 86_400_000);

/** "Today", "Yesterday" or a short date, relative to the app clock. */
export function formatDay(at: number, reference: number): string {
  const difference = dayKey(reference) - dayKey(at);
  if (difference <= 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return formatDate(at);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?';
}

/** Parses "12.5", "12,50" or "1250" style input into minor units; null when not a positive amount. */
export function parseAmount(input: string): number | null {
  const normalized = input.replace(',', '.').trim();
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return cents > 0 ? cents : null;
}
