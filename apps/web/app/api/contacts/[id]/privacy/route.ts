import { NextResponse } from 'next/server';
import { getDb, contacts, eq } from '@nexus/db';
import { z } from 'zod';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { log } from '@/lib/logger';

const schema = z.object({
  allowTranscription: z.boolean().optional(),
  allowAction: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Require admin session authentication
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    log.warn('contacts.privacy.unauthorized', { email: session?.email ?? 'none' });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await req.json();
    const parsed = schema.parse(body);

    const db = getDb();
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);

    if (!contact) {
      return NextResponse.json({ error: 'contact_not_found' }, { status: 404 });
    }

    const updateData: Record<string, boolean> = {};
    if (parsed.allowTranscription !== undefined) {
      updateData.allowTranscription = parsed.allowTranscription;
    }
    if (parsed.allowAction !== undefined) {
      updateData.allowAction = parsed.allowAction;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 });
    }

    await db
      .update(contacts)
      .set(updateData)
      .where(eq(contacts.id, id));

    log.info('contacts.privacy.updated', { contactId: id, email: session.email });
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error('contacts.privacy.error', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
