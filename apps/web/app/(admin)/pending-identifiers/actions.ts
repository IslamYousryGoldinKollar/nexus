'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  asc,
  contacts,
  eq,
  getDb,
  linkPendingIdentifier,
  pendingIdentifiers,
  sql,
} from '@nexus/db';
import { readSession } from '@/lib/auth/session';
import { log } from '@/lib/logger';

/**
 * Pending-identifier resolution actions.
 *
 *   linkToContact     → confirm the suggestion (or pick a contact) and
 *                       create a verified contact_identifiers row, mark
 *                       pending state=linked
 *   createContact     → mint a brand-new contact + identifier from the
 *                       pending row's value, mark linked
 *   ignore            → mark state=ignored (won't be auto-suggested
 *                       again; spam/wrong-number)
 */

async function ensureAdmin(): Promise<{ email: string }> {
  const session = await readSession();
  if (!session) throw new Error('not_authenticated');
  return { email: session.email };
}

const idSchema = z.string().uuid();

export async function linkToContact(formData: FormData): Promise<void> {
  const admin = await ensureAdmin();
  const pendingId = idSchema.parse(formData.get('pendingId'));
  const contactId = idSchema.parse(formData.get('contactId'));

  const db = getDb();
  await linkPendingIdentifier(db, {
    pendingId,
    contactId,
    source: `web:${admin.email}`,
  });

  log.info('pending.link', { pendingId, contactId, by: admin.email });
  revalidatePath('/pending-identifiers');
  revalidatePath('/dashboard');
}

export async function createContactFromPending(formData: FormData): Promise<void> {
  const admin = await ensureAdmin();
  const pendingId = idSchema.parse(formData.get('pendingId'));
  const displayName = ((formData.get('displayName') as string | null) ?? '').trim();
  if (!displayName) throw new Error('display_name_required');

  const db = getDb();
  await db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(pendingIdentifiers)
      .where(eq(pendingIdentifiers.id, pendingId))
      .limit(1);
    if (!pending) throw new Error('pending_not_found');
    if (pending.state !== 'pending') throw new Error(`already_${pending.state}`);

    const [contact] = await tx
      .insert(contacts)
      .values({ displayName })
      .returning();
    if (!contact) throw new Error('contact_insert_failed');

    await tx
      .update(pendingIdentifiers)
      .set({ state: 'linked', resolvedAt: new Date() })
      .where(eq(pendingIdentifiers.id, pendingId));

    // Create the verified identifier row.
    await tx.execute(
      sql`insert into contact_identifiers (contact_id, kind, value, verified, source)
          values (${contact.id}, ${pending.kind}, ${pending.value}, true, ${'web:' + admin.email})`,
    );
  });

  log.info('pending.create_contact', { pendingId, displayName, by: admin.email });
  revalidatePath('/pending-identifiers');
  revalidatePath('/dashboard');
}

export async function ignorePending(formData: FormData): Promise<void> {
  const admin = await ensureAdmin();
  const pendingId = idSchema.parse(formData.get('pendingId'));

  const db = getDb();
  await db
    .update(pendingIdentifiers)
    .set({ state: 'ignored', resolvedAt: new Date() })
    .where(eq(pendingIdentifiers.id, pendingId));

  log.info('pending.ignore', { pendingId, by: admin.email });
  revalidatePath('/pending-identifiers');
  revalidatePath('/dashboard');
}

/** Read-only contact picker source for the link form. */
export async function searchContacts(_formData: FormData): Promise<void> {
  // Unused placeholder — the page server-renders the contact list.
  // Kept here to make the file structure explicit for future search UI.
}

void asc;
