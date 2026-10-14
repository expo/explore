import type { Card } from '@/store/types';

/**
 * A virtual card's full number and security code. Both follow from its last four digits, so a card
 * shows the same details on every launch and in every capture. They are sample values, not card numbers.
 */
export const cardNumber = (card: Card) => `4000 0000 0000 ${card.last4}`;
export const cardSecurityCode = (card: Card) => String(100 + ((Number(card.last4) * 7) % 900));
export const maskedCardNumber = (card: Card) => `•••• •••• •••• ${card.last4}`;
