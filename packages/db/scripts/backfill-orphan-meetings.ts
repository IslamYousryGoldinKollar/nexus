#!/usr/bin/env tsx
/**
 * One-shot: link every orphan meeting interaction (session_id IS NULL)
 * to the synthetic "Meetings" contact + a fresh session. Mirrors what
 * `attachMeetingToSession` in lib/channels/meeting/ingest.ts now does
 * automatically for new uploads.
 *
 * Safe to re-run — only touches interactions where session_id IS NULL
 * AND content_type='meeting'.
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');

  const client = postgres(url, { max: 1 });
  try {
    // Ensure the bucket contact exists.
    let [contact] = await client`
      SELECT id FROM contacts WHERE display_name = 'Meetings' LIMIT 1
    `;
    if (!contact) {
      const created = await client`
        INSERT INTO contacts (display_name, notes)
        VALUES ('Meetings', 'Auto-created bucket for browser-extension meeting recordings.')
        RETURNING id
      `;
      contact = created[0];
      console.log(`[backfill] created Meetings contact: ${contact!.id}`);
    } else {
      console.log(`[backfill] Meetings contact: ${contact.id}`);
    }

    const orphans = await client`
      SELECT id, occurred_at
      FROM interactions
      WHERE content_type = 'meeting' AND session_id IS NULL
      ORDER BY occurred_at
    `;
    console.log(`[backfill] orphan meetings: ${orphans.length}`);

    for (const o of orphans) {
      // Backdate so auto-reason picks it up on the next tick.
      const backdated = new Date(new Date(o.occurred_at).getTime() - 10 * 60 * 1000);
      const [session] = await client`
        INSERT INTO sessions (contact_id, state, opened_at, last_activity_at)
        VALUES (${contact!.id}, 'open', ${o.occurred_at}, ${backdated})
        RETURNING id
      `;
      await client`
        UPDATE interactions SET session_id = ${session!.id} WHERE id = ${o.id}
      `;
      console.log(`[backfill] interaction ${o.id} → session ${session!.id}`);
    }
  } finally {
    await client.end();
  }
}

void main().catch((e) => {
  console.error('backfill-orphan-meetings failed:', e);
  process.exit(1);
});
