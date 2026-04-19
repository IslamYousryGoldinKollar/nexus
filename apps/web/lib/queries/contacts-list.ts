import 'server-only';
import {
  asc,
  contactIdentifiers,
  contacts,
  desc,
  eq,
  getDb,
  inArray,
  sql,
  type Contact,
  type ContactIdentifier,
} from '@nexus/db';

export interface ContactListRow {
  contact: Contact;
  identifiers: ContactIdentifier[];
  sessionCount: number;
}

export async function listContacts(limit = 200): Promise<ContactListRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(contacts)
    .orderBy(desc(contacts.updatedAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [identifiers, counts] = await Promise.all([
    db
      .select()
      .from(contactIdentifiers)
      .where(inArray(contactIdentifiers.contactId, ids))
      .orderBy(asc(contactIdentifiers.kind)),
    db
      .select({
        contactId: sql<string>`contact_id`,
        count: sql<number>`count(*)::int`,
      })
      .from(sql`sessions`)
      .where(sql`contact_id = any(${ids})`)
      .groupBy(sql`contact_id`),
  ]);

  const identsByContact = new Map<string, ContactIdentifier[]>();
  for (const i of identifiers) {
    const list = identsByContact.get(i.contactId) ?? [];
    list.push(i);
    identsByContact.set(i.contactId, list);
  }
  const countsByContact = new Map<string, number>();
  for (const c of counts as unknown as Array<{ contactId: string; count: number }>) {
    countsByContact.set(c.contactId, Number(c.count));
  }

  return rows.map((c) => ({
    contact: c,
    identifiers: identsByContact.get(c.id) ?? [],
    sessionCount: countsByContact.get(c.id) ?? 0,
  }));
}

export async function getContactById(id: string): Promise<Contact | null> {
  const db = getDb();
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
  return row ?? null;
}
