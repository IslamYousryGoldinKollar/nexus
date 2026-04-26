import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, contacts, eq } from '@nexus/db';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/contacts/[id]/injaz — set or clear the Injaz party/project
 * mapping on a contact. Either field may be null to clear.
 *
 * Both values are stored as free text because Injaz's MCP create_task
 * takes `projectName` (not an ID), and the list endpoints don't expose
 * stable IDs anyway. The sync cron passes `injazProjectName` as
 * `projectName` when creating tasks for any session whose contact has
 * a mapping set.
 */
const schema = z.object({
  injazPartyName: z.string().min(1).max(200).nullable(),
  injazProjectName: z.string().min(1).max(200).nullable(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    log.warn('contacts.injaz.unauthorized', { email: session?.email ?? 'none' });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await req.json();
    const parsed = schema.parse(body);

    const db = getDb();
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);
    if (!contact) {
      return NextResponse.json({ error: 'contact_not_found' }, { status: 404 });
    }

    await db
      .update(contacts)
      .set({
        injazPartyName: parsed.injazPartyName,
        injazProjectName: parsed.injazProjectName,
      })
      .where(eq(contacts.id, id));

    log.info('contacts.injaz.updated', {
      contactId: id,
      partyName: parsed.injazPartyName,
      projectName: parsed.injazProjectName,
      email: session.email,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'invalid_payload', issues: err.issues },
        { status: 400 },
      );
    }
    log.error('contacts.injaz.error', {
      err: (err as Error).message,
      stack: (err as Error).stack,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
