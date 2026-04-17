import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  contactIdentifiers,
  contacts,
  pendingIdentifiers,
  type Contact,
  type ContactIdentifier,
  type NewContact,
  type NewContactIdentifier,
  type NewPendingIdentifier,
  type PendingIdentifier,
} from '../schema/contacts.js';
import { interactions, type Interaction } from '../schema/sessions.js';

/**
 * Identity-resolution outcome.
 * - `matched` means we found an existing contact (direct or suggested-then-confirmed)
 * - `pending` means we queued a pending_identifier row and the contact is not yet known
 * - `created` means we bypassed HITL (IDENTITY_LEARNING_MODE=false) and auto-made a contact
 */
export type ResolutionStatus = 'matched' | 'pending' | 'created';

export interface IdentityLookupKey {
  kind: ContactIdentifier['kind'];
  value: string;
}

/** Fast path: exact lookup on (kind, value). Returns verified row if present. */
export async function findContactByIdentifier(
  db: Database,
  key: IdentityLookupKey,
): Promise<{ contact: Contact; identifier: ContactIdentifier } | null> {
  const rows = await db
    .select({
      contact: contacts,
      identifier: contactIdentifiers,
    })
    .from(contactIdentifiers)
    .innerJoin(contacts, eq(contacts.id, contactIdentifiers.contactId))
    .where(
      and(
        eq(contactIdentifiers.kind, key.kind),
        eq(contactIdentifiers.value, key.value),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Auto-create a contact + verified identifier in a single transaction. */
export async function createContactWithIdentifier(
  db: Database,
  args: {
    displayName: string;
    identifier: IdentityLookupKey;
    source?: string;
    accountId?: string | null;
  },
): Promise<{ contact: Contact; identifier: ContactIdentifier }> {
  const contactRow: NewContact = {
    displayName: args.displayName,
    accountId: args.accountId ?? null,
  };
  const identifierRow: Omit<NewContactIdentifier, 'contactId'> = {
    kind: args.identifier.kind,
    value: args.identifier.value,
    verified: true,
    source: args.source ?? 'auto',
  };

  // Drizzle's postgres-js driver supports db.transaction().
  return db.transaction(async (tx) => {
    const [contact] = await tx.insert(contacts).values(contactRow).returning();
    if (!contact) throw new Error('contact insert returned no rows');
    const [identifier] = await tx
      .insert(contactIdentifiers)
      .values({ ...identifierRow, contactId: contact.id })
      .returning();
    if (!identifier) throw new Error('identifier insert returned no rows');
    return { contact, identifier };
  });
}

/**
 * Queue an unknown identifier for HITL linkage.
 *
 * Idempotent: if a pending_identifier with the same (kind, value, state=pending)
 * already exists, we return it instead of creating a duplicate.
 */
export async function upsertPendingIdentifier(
  db: Database,
  args: {
    kind: PendingIdentifier['kind'];
    value: string;
    firstSeenInteractionId: string;
    suggestedContactId?: string | null;
    suggestionConfidence?: number | null;
  },
): Promise<{ pending: PendingIdentifier; inserted: boolean }> {
  const existing = await db
    .select()
    .from(pendingIdentifiers)
    .where(
      and(
        eq(pendingIdentifiers.kind, args.kind),
        eq(pendingIdentifiers.value, args.value),
        eq(pendingIdentifiers.state, 'pending'),
      ),
    )
    .limit(1);
  if (existing[0]) return { pending: existing[0], inserted: false };

  const row: NewPendingIdentifier = {
    kind: args.kind,
    value: args.value,
    firstSeenInteractionId: args.firstSeenInteractionId,
    suggestedContactId: args.suggestedContactId ?? null,
    suggestionConfidence:
      args.suggestionConfidence !== null && args.suggestionConfidence !== undefined
        ? String(args.suggestionConfidence)
        : null,
    state: 'pending',
  };
  const [inserted] = await db.insert(pendingIdentifiers).values(row).returning();
  if (!inserted) throw new Error('pending_identifier insert returned no rows');
  return { pending: inserted, inserted: true };
}

/** Link an interaction row to a resolved contact_id. */
export async function setInteractionContact(
  db: Database,
  interactionId: string,
  contactId: string,
): Promise<Interaction | null> {
  const [row] = await db
    .update(interactions)
    .set({ contactId })
    .where(eq(interactions.id, interactionId))
    .returning();
  return row ?? null;
}

/**
 * Resolve a pending_identifier to a specific contact.
 * Admin UI (Phase 5) + Telegram bot (Phase 9) call this.
 */
export async function linkPendingIdentifier(
  db: Database,
  args: {
    pendingId: string;
    contactId: string;
    source?: string;
  },
): Promise<{ contact: Contact; identifier: ContactIdentifier }> {
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(pendingIdentifiers)
      .where(eq(pendingIdentifiers.id, args.pendingId))
      .limit(1);
    if (!pending) throw new Error(`pending_identifier not found: ${args.pendingId}`);
    if (pending.state !== 'pending') {
      throw new Error(`pending_identifier already ${pending.state}`);
    }

    const [contact] = await tx
      .select()
      .from(contacts)
      .where(eq(contacts.id, args.contactId))
      .limit(1);
    if (!contact) throw new Error(`contact not found: ${args.contactId}`);

    const [identifier] = await tx
      .insert(contactIdentifiers)
      .values({
        contactId: contact.id,
        kind: pending.kind,
        value: pending.value,
        verified: true,
        source: args.source ?? 'hitl',
      })
      .returning();
    if (!identifier) throw new Error('identifier insert returned no rows');

    await tx
      .update(pendingIdentifiers)
      .set({ state: 'linked', resolvedAt: new Date() })
      .where(eq(pendingIdentifiers.id, pending.id));

    return { contact, identifier };
  });
}
