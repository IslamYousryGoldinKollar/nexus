import {
  contacts,
  eq,
  findTranscriptByAttachment,
  getAttachmentById,
  getDb,
  insertTranscript,
  interactions as interactionsTable,
  isOverMonthlyBudget,
  recordCostEvent,
} from '@nexus/db';
import {
  r2CredsFromEnv,
  signR2GetUrl,
  signSupabaseGetUrl,
  supabaseStorageCredsFromEnv,
  transcribe,
} from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Phase 3: Transcribe an audio/video attachment.
 *
 * Triggered by `nexus/transcription.requested`. Emitted from the identity
 * resolver when an interaction has attached audio/video media.
 *
 * Budget circuit-breaker: if monthly Whisper spend already exceeds
 * `WHISPER_MONTHLY_BUDGET_USD`, we skip + log without throwing.
 *
 * Idempotent: we check `findTranscriptByAttachment` first; if a
 * transcript already exists we short-circuit.
 */
export const transcribeAttachment = inngest.createFunction(
  {
    id: 'transcribe-attachment',
    name: 'Transcribe audio/video attachment (Phase 3)',
    retries: 2,
    concurrency: { limit: 4 },
  },
  { event: 'nexus/transcription.requested' },
  async ({ event, step, logger }) => {
    const { attachmentId, interactionId, preferredProvider } = event.data;

    // ---- 1. Idempotency ---------------------------------------------------
    const already = await step.run('check-existing', async () => {
      const db = getDb();
      return findTranscriptByAttachment(db, attachmentId);
    });
    if (already) {
      logger.info('transcribe.skip.already_done', { attachmentId });
      return { status: 'already-transcribed' as const, transcriptId: already.id };
    }

    // ---- 2. Load attachment + interaction metadata -----------------------
    const attachment = await step.run('load-attachment', async () => {
      const db = getDb();
      return getAttachmentById(db, attachmentId);
    });
    if (!attachment) throw new Error(`attachment not found: ${attachmentId}`);

    const interaction = await step.run('load-interaction', async () => {
      const db = getDb();
      const [row] = await db
        .select()
        .from(interactionsTable)
        .where(eq(interactionsTable.id, interactionId))
        .limit(1);
      return row ?? null;
    });

    // ---- 3. Privacy check: contact transcription permission ----------------
    if (interaction?.contactId) {
      const contact = await step.run('check-contact-permission', async () => {
        const db = getDb();
        const [row] = await db
          .select()
          .from(contacts)
          .where(eq(contacts.id, interaction.contactId!))
          .limit(1);
        return row ?? null;
      });
      if (contact && !contact.allowTranscription) {
        logger.info('transcribe.skip.contact_blocked', {
          attachmentId,
          contactId: contact.id,
        });
        return { status: 'contact-blocked' as const, contactId: contact.id };
      }
    }

    // ---- 3. Budget circuit-breaker ---------------------------------------
    const whisperBudget = Number(process.env.WHISPER_MONTHLY_BUDGET_USD ?? '100') || 100;
    const budget = await step.run('check-budget', async () => {
      const db = getDb();
      return isOverMonthlyBudget(db, 'openai_whisper', whisperBudget);
    });
    if (budget.over) {
      logger.warn('transcribe.budget_exceeded', {
        service: 'openai_whisper',
        spent: budget.spent,
        budget: whisperBudget,
      });
      return { status: 'budget-exceeded' as const, spent: budget.spent };
    }

    // ---- 4. Sign storage URL + transcribe --------------------------------
    // Support both Cloudflare R2 (legacy) and Supabase Storage (Baileys bridge).
    // Attachment `r2Key` is a path under the active bucket regardless of backend.
    const r2Creds = r2CredsFromEnv();
    const supCreds = r2Creds ? null : supabaseStorageCredsFromEnv();
    if (!r2Creds && !supCreds) {
      throw new Error(
        'No storage credentials in env: need R2_* (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) or SUPABASE_* (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET)',
      );
    }

    const audioUrl = await step.run('sign-url', async () => {
      if (r2Creds) return signR2GetUrl(r2Creds, attachment.r2Key, 15 * 60);
      return signSupabaseGetUrl(supCreds!, attachment.r2Key, 15 * 60);
    });

    const isCall = interaction?.contentType === 'call';
    const result = await step.run('transcribe', async () => {
      return transcribe({
        audioUrl,
        mimeType: attachment.mimeType,
        fileName: attachment.r2Key.split('/').pop(),
        preferredProvider,
        isMultiSpeaker: isCall,
      });
    });

    // ---- 5. Persist transcript + cost event ------------------------------
    const transcriptId = await step.run('persist', async () => {
      const db = getDb();
      const transcript = await insertTranscript(db, {
        attachmentId,
        text: result.text,
        language: result.language ?? null,
        segments: result.segments ?? null,
        provider: result.provider,
        costUsd: result.costUsdMillis,
      });

      await recordCostEvent(db, {
        service:
          result.provider === 'whisper' ? 'openai_whisper' : 'assemblyai',
        operation: 'transcription',
        costUsd: (result.costUsdMillis / 100_000).toFixed(6),
        sessionId: interaction?.sessionId ?? null,
        metadata: {
          attachmentId,
          interactionId,
          durationSec: result.durationSec,
          provider: result.provider,
        },
      });
      return transcript.id;
    });

    logger.info('transcribe.done', {
      attachmentId,
      transcriptId,
      provider: result.provider,
      durationSec: result.durationSec,
    });

    return {
      status: 'transcribed' as const,
      transcriptId,
      provider: result.provider,
      durationSec: result.durationSec,
    };
  },
);
