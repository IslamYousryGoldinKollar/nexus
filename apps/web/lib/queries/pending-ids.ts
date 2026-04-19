import 'server-only';
import { desc, eq, getDb, pendingIdentifiers, type PendingIdentifier } from '@nexus/db';

// Reserved for future fields (e.g. suggested contact name).
// Suggestions are fetched separately so the page can stay cache-friendly.
export type PendingIdentifierRow = PendingIdentifier;

export async function listPendingIdentifiers(limit = 100): Promise<PendingIdentifierRow[]> {
  const db = getDb();
  return db
    .select()
    .from(pendingIdentifiers)
    .where(eq(pendingIdentifiers.state, 'pending'))
    .orderBy(desc(pendingIdentifiers.createdAt))
    .limit(limit);
}
