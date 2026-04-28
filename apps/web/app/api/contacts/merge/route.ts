import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  contactIdentifiers,
  contacts,
  eq,
  getDb,
  inArray,
  sessions,
} from '@nexus/db';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/contacts/merge — collapse N contacts into one.
 *
 * The same human shows up as multiple contact rows because each
 * channel's auto-create path keys on its own identifier kind:
 *   email ingest → "lidia.sami@eand.com.eg"
 *   WhatsApp     → "Lidia Sami"
 *   phone        → "Lidia"
 *
 * Merging is purely relational — no schema migration. We:
 *   1. move every contact_identifier from `drop[*]` to `keep`
 *      (UNIQUE(kind,value) means the value is already globally unique;
 *      a re-parent via UPDATE is enough)
 *   2. reassign sessions.contact_id from each `drop[*]` to `keep`
 *   3. delete the dropped contacts (CASCADE handles approval_events
 *      etc. via the existing FK chain)
 *
 * Wrapped in a single transaction so a failure mid-flight rolls back
 * the whole merge instead of leaving orphaned identifiers/sessions.
 *
 * Body: { keep: <uuid>, drop: <uuid[]> } — `drop` must be non-empty
 * and must not contain `keep`.
 */
const schema = z.object({
  keep: z.string().uuid(),
  drop: z.array(z.string().uuid()).min(1).max(50),
});

export async function POST(req: Request) {
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    log.warn('contacts.merge.unauthorized', { email: session?.email ?? 'none' });
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { keep, drop } = parsed.data;
  if (drop.includes(keep)) {
    return NextResponse.json(
      { error: 'keep_id_in_drop_list' },
      { status: 400 },
    );
  }

  const db = getDb();

  // Sanity-check that keep + every drop exists before mutating anything.
  const found = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(inArray(contacts.id, [keep, ...drop]));
  const foundIds = new Set(found.map((r) => r.id));
  if (!foundIds.has(keep)) {
    return NextResponse.json({ error: 'keep_not_found' }, { status: 404 });
  }
  const missing = drop.filter((id) => !foundIds.has(id));
  if (missing.length) {
    return NextResponse.json(
      { error: 'drop_ids_not_found', missing },
      { status: 404 },
    );
  }

  try {
    const summary = await db.transaction(async (tx) => {
      // 1. Re-parent identifiers. UNIQUE(kind, value) globally means
      //    no conflict is possible — distinct contacts can't already
      //    share an identifier. A bulk UPDATE is sufficient.
      const idsMoved = await tx
        .update(contactIdentifiers)
        .set({ contactId: keep })
        .where(inArray(contactIdentifiers.contactId, drop))
        .returning({ id: contactIdentifiers.id });

      // 2. Re-parent sessions.
      const sessMoved = await tx
        .update(sessions)
        .set({ contactId: keep })
        .where(inArray(sessions.contactId, drop))
        .returning({ id: sessions.id });

      // 3. Delete the dropped contacts. CASCADE on FKs from
      //    interactions/notifications/etc. handles the rest where
      //    they exist; tables that point at contacts via FK with
      //    onDelete='set null' (e.g. accounts, pendingIdentifiers
      //    suggestion) will null out cleanly.
      const dropped = await tx
        .delete(contacts)
        .where(inArray(contacts.id, drop))
        .returning({ id: contacts.id });

      return {
        identifiersMoved: idsMoved.length,
        sessionsMoved: sessMoved.length,
        contactsDeleted: dropped.length,
      };
    });

    log.info('contacts.merge.done', {
      adminEmail: session.email,
      keep,
      drop,
      ...summary,
    });

    return NextResponse.json({ ok: true, keep, drop, ...summary });
  } catch (err) {
    log.error('contacts.merge.failed', {
      keep,
      drop,
      err: (err as Error).message,
    });
    return NextResponse.json(
      { error: 'merge_failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
