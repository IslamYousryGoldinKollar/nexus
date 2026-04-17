import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { interactions, type Interaction, type NewInteraction } from '../schema/sessions.js';

/**
 * Idempotent insert of an interaction row.
 *
 * Exploits the `UNIQUE(channel, source_message_id)` constraint: if a row
 * already exists for the same `(channel, sourceMessageId)` tuple, we
 * return the existing row and set `inserted = false`. Otherwise we insert
 * and return `inserted = true`.
 *
 * **Why not `ON CONFLICT ... DO UPDATE`?** Webhooks retry on our 5xx
 * responses, and we don't want a second delivery to mutate fields like
 * `rawPayload` that the caller may have enriched before the first insert
 * landed. "Insert, ignore dupes, return existing" is the cleanest semantic.
 */
export async function upsertInteraction(
  db: Database,
  row: NewInteraction,
): Promise<{ interaction: Interaction; inserted: boolean }> {
  // Try the cheap path first — if the row already exists, skip the insert.
  const existing = await db
    .select()
    .from(interactions)
    .where(
      and(
        eq(interactions.channel, row.channel),
        eq(interactions.sourceMessageId, row.sourceMessageId),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return { interaction: existing[0], inserted: false };
  }

  // Race-safe insert: let the UNIQUE constraint handle concurrent inserts.
  // If two webhook deliveries land in the same millisecond, one wins, the
  // other falls through to the select in the catch.
  try {
    const [inserted] = await db.insert(interactions).values(row).returning();
    if (!inserted) {
      throw new Error('insert returned no rows');
    }
    return { interaction: inserted, inserted: true };
  } catch (err) {
    // Postgres unique-violation code = 23505
    const pgCode = (err as { code?: string } | null)?.code;
    if (pgCode !== '23505') throw err;

    const after = await db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.channel, row.channel),
          eq(interactions.sourceMessageId, row.sourceMessageId),
        ),
      )
      .limit(1);

    if (!after[0]) {
      throw new Error(
        `interactions unique-violation but row not found for ${row.channel}:${row.sourceMessageId}`,
      );
    }
    return { interaction: after[0], inserted: false };
  }
}

export async function getInteractionBySourceId(
  db: Database,
  channel: Interaction['channel'],
  sourceMessageId: string,
): Promise<Interaction | null> {
  const rows = await db
    .select()
    .from(interactions)
    .where(
      and(
        eq(interactions.channel, channel),
        eq(interactions.sourceMessageId, sourceMessageId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
