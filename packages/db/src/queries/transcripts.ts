import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { attachments, type Attachment } from '../schema/sessions.js';
import {
  transcripts,
  type NewTranscript,
  type Transcript,
} from '../schema/sessions.js';

/**
 * Insert a transcript row keyed to an attachment.
 *
 * We cache-by-attachment rather than by checksum: if the same audio
 * blob arrives via two different channels the checksum dedup in R2 +
 * attachment-level fkey on transcripts means one row per interaction.
 * Good enough; revisit in Phase 11 if we want dedup by checksum
 * (saves per-blob transcription cost on forwarded media).
 */
export async function insertTranscript(
  db: Database,
  row: NewTranscript,
): Promise<Transcript> {
  const [inserted] = await db.insert(transcripts).values(row).returning();
  if (!inserted) throw new Error('transcript insert returned no rows');
  return inserted;
}

export async function findTranscriptByAttachment(
  db: Database,
  attachmentId: string,
): Promise<Transcript | null> {
  const rows = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.attachmentId, attachmentId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAttachmentById(
  db: Database,
  attachmentId: string,
): Promise<Attachment | null> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAttachmentsForInteraction(
  db: Database,
  interactionId: string,
): Promise<Attachment[]> {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.interactionId, interactionId));
}
