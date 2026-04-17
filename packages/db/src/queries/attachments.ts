import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { attachments, type Attachment, type NewAttachment } from '../schema/sessions.js';

/**
 * Insert an attachment row. Deduplication by `checksum` is done at the
 * ingestion layer (see R2 uploader), not here — two interactions can
 * legitimately both point at the same physical blob via separate rows.
 */
export async function insertAttachment(
  db: Database,
  row: NewAttachment,
): Promise<Attachment> {
  const [inserted] = await db.insert(attachments).values(row).returning();
  if (!inserted) throw new Error('attachment insert returned no rows');
  return inserted;
}

export async function findAttachmentByChecksum(
  db: Database,
  checksum: string,
): Promise<Attachment | null> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.checksum, checksum))
    .limit(1);
  return rows[0] ?? null;
}
