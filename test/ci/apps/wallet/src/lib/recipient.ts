import { CONTACTS, contactById, type Contact } from '@/fixtures/seed';

/**
 * Someone to pay: a Wallet contact, or a person picked from the iPhone's contacts, whom Wallet knows
 * only by name. `detail` is the line under the name.
 */
export type Recipient = { name: string; detail: string; contact: Contact | null };

/** How the Send screens name a recipient in their links: `to` for a Wallet contact, `name` otherwise. */
export type RecipientParams = { to?: string; name?: string };

const FROM_CONTACTS = 'From your contacts';

/** The recipient that a Send screen's params name, or null when they name no one Wallet can pay. */
export function recipientFrom({ to, name }: RecipientParams): Recipient | null {
  if (to) {
    const contact = contactById(to);
    return contact ? { name: contact.name, detail: contact.handle, contact } : null;
  }
  const trimmed = name?.trim();
  return trimmed ? { name: trimmed, detail: FROM_CONTACTS, contact: null } : null;
}

/**
 * A person from the iPhone's contacts. Someone already on Wallet under the same name is paid as that
 * Wallet contact.
 */
export function recipientNamed(name: string): Recipient {
  const trimmed = name.trim();
  const contact = CONTACTS.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase());
  return contact ? { name: contact.name, detail: contact.handle, contact } : { name: trimmed, detail: FROM_CONTACTS, contact: null };
}

/** The params that name `recipient` on the next Send screen. */
export function recipientParams(recipient: Recipient): { to: string } | { name: string } {
  return recipient.contact ? { to: recipient.contact.id } : { name: recipient.name };
}
