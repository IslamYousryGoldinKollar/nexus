import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { accounts, type Account } from '../schema/accounts.js';
import {
  contactIdentifiers,
  contacts,
  type Contact,
  type ContactIdentifier,
} from '../schema/contacts.js';
import {
  attachments,
  interactions,
  sessions,
  transcripts,
  type Attachment,
  type Interaction,
  type Session,
  type Transcript,
} from '../schema/sessions.js';
import {
  proposedTasks,
  reasoningRuns,
  type NewProposedTask,
  type NewReasoningRun,
  type ProposedTask,
  type ReasoningRun,
} from '../schema/reasoning.js';

export interface SessionContext {
  session: Session;
  contact: Contact | null;
  account: Account | null;
  identifiers: ContactIdentifier[];
  interactions: Array<{
    interaction: Interaction;
    attachments: Attachment[];
    transcripts: Transcript[];
  }>;
}

/**
 * Gather everything Claude needs for a reasoning run on a session.
 * One read, one JOIN-flavored pass, one interaction-ordered array out.
 */
export async function loadSessionContext(
  db: Database,
  sessionId: string,
): Promise<SessionContext | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return null;

  const [contact] = session.contactId
    ? await db.select().from(contacts).where(eq(contacts.id, session.contactId)).limit(1)
    : [null];

  const [account] = session.accountId
    ? await db.select().from(accounts).where(eq(accounts.id, session.accountId)).limit(1)
    : contact?.accountId
      ? await db.select().from(accounts).where(eq(accounts.id, contact.accountId)).limit(1)
      : [null];

  const identifiers = contact
    ? await db
        .select()
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, contact.id))
    : [];

  const inters = await db
    .select()
    .from(interactions)
    .where(eq(interactions.sessionId, sessionId))
    .orderBy(asc(interactions.occurredAt));

  if (inters.length === 0) {
    return { session, contact: contact ?? null, account: account ?? null, identifiers, interactions: [] };
  }

  const interactionIds = inters.map((i) => i.id);
  const atts = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.interactionId, interactionIds));
  const attachmentIds = atts.map((a) => a.id);

  const trans = attachmentIds.length
    ? await db
        .select()
        .from(transcripts)
        .where(inArray(transcripts.attachmentId, attachmentIds))
    : [];

  const attByInteraction = new Map<string, Attachment[]>();
  for (const a of atts) {
    const list = attByInteraction.get(a.interactionId) ?? [];
    list.push(a);
    attByInteraction.set(a.interactionId, list);
  }
  const transByAttachment = new Map<string, Transcript>();
  for (const t of trans) {
    transByAttachment.set(t.attachmentId, t);
  }

  return {
    session,
    contact: contact ?? null,
    account: account ?? null,
    identifiers,
    interactions: inters.map((interaction) => {
      const interAtts = attByInteraction.get(interaction.id) ?? [];
      const interTrans = interAtts
        .map((a) => transByAttachment.get(a.id))
        .filter((t): t is Transcript => !!t);
      return { interaction, attachments: interAtts, transcripts: interTrans };
    }),
  };
}

export async function insertReasoningRun(
  db: Database,
  row: NewReasoningRun,
): Promise<ReasoningRun> {
  const [inserted] = await db.insert(reasoningRuns).values(row).returning();
  if (!inserted) throw new Error('reasoning_run insert returned no rows');
  return inserted;
}

export async function insertProposedTasks(
  db: Database,
  rows: NewProposedTask[],
): Promise<ProposedTask[]> {
  if (rows.length === 0) return [];
  return db.insert(proposedTasks).values(rows).returning();
}
