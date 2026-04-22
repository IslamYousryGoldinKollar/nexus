import {
  attachInteractionToSession,
  createContactWithIdentifier,
  eq,
  findContactByIdentifier,
  getDb,
  interactions as interactionsTable,
  listAttachmentsForInteraction,
  setInteractionContact,
  upsertPendingIdentifier,
} from '@nexus/db';
import { inngest } from '../client.js';
import { extractIdentifier } from './extract-identifier.js';

// MIME prefixes that qualify for transcription.
const TRANSCRIBABLE_MIME_PREFIXES = ['audio/', 'video/'];

/**
 * Phase 2: resolve identity, attach interaction to a session, schedule
 * reasoning debounce. Replaces the Phase 1 logger.
 *
 * Behaviour is controlled by two env vars:
 *   - IDENTITY_LEARNING_MODE (boolean, default false)
 *       true  → every non-exact identifier goes to `pending_identifiers`
 *       false → auto-create a contact + verified identifier
 *   - SESSION_COOLDOWN_MIN  (number, default 120)
 *       minutes of silence after which a session is reasoned over
 *
 * We keep the function id stable across phases so Inngest deploys cleanly.
 */
export const resolveAndAttach = inngest.createFunction(
  {
    id: 'interaction-ingested',
    name: 'Resolve identity + attach session (Phase 2)',
    // Limit concurrent resolution per contact so we don't race ourselves
    // on the session-extend path. `null` bucket + 8 slots is plenty.
    concurrency: { limit: 5 },
  },
  { event: 'nexus/interaction.ingested' },
  async ({ event, step, logger }) => {
    const { interactionId, channel } = event.data;

    const learningMode =
      (process.env.IDENTITY_LEARNING_MODE ?? 'false').toLowerCase() === 'true' ||
      process.env.IDENTITY_LEARNING_MODE === '1';
    const cooldownMin = Number(process.env.SESSION_COOLDOWN_MIN ?? '120') || 120;

    // ---- 1. Load interaction ---------------------------------------------
    const interaction = await step.run('load-interaction', async () => {
      const db = getDb();
      const [row] = await db
        .select()
        .from(interactionsTable)
        .where(eq(interactionsTable.id, interactionId))
        .limit(1);
      if (!row) throw new Error(`interaction not found: ${interactionId}`);
      return row;
    });

    // ---- 2. Extract identifier -------------------------------------------
    const identified = extractIdentifier(
      channel,
      interaction.rawPayload,
      interaction.sourceMessageId,
    );
    if (!identified) {
      logger.warn('resolve.no_identifier', { interactionId, channel });
      return { status: 'no_identifier' as const };
    }

    // ---- 3. Match or queue -----------------------------------------------
    const matched = await step.run('match-contact', async () => {
      const db = getDb();
      return findContactByIdentifier(db, {
        kind: identified.kind,
        value: identified.value,
      });
    });

    let contactId: string | null = matched?.contact.id ?? null;
    let status: 'matched' | 'pending' | 'created' = 'matched';

    if (!matched) {
      if (learningMode) {
        await step.run('queue-pending', async () => {
          const db = getDb();
          await upsertPendingIdentifier(db, {
            kind: identified.kind,
            value: identified.value,
            firstSeenInteractionId: interactionId,
          });
        });
        status = 'pending';
      } else {
        const created = await step.run('auto-create-contact', async () => {
          const db = getDb();
          return createContactWithIdentifier(db, {
            displayName: identified.displayHint ?? identified.value,
            identifier: { kind: identified.kind, value: identified.value },
            source: `auto:${channel}`,
          });
        });
        contactId = created.contact.id;
        status = 'created';
      }
    }

    // ---- 4. Attach interaction.contact_id --------------------------------
    if (contactId) {
      await step.run('set-interaction-contact', async () => {
        const db = getDb();
        await setInteractionContact(db, interactionId, contactId!);
      });
    }

    // ---- 5. Attach to session + fire cooldown heartbeat ------------------
    let sessionId: string | null = null;
    if (contactId) {
      const attached = await step.run('attach-session', async () => {
        const db = getDb();
        return attachInteractionToSession(db, {
          interactionId,
          contactId: contactId!,
          // step.run return values round-trip through JSON, so timestamps
          // arrive as ISO strings — re-hydrate to Date for Drizzle.
          occurredAt: new Date(interaction.occurredAt as unknown as string),
          cooldownMinutes: cooldownMin,
        });
      });
      sessionId = attached.session.id;

      await step.sendEvent('emit-cooldown-heartbeat', {
        name: 'nexus/session.cooldown.heartbeat',
        data: {
          sessionId: attached.session.id,
          interactionId,
        },
      });
    }

    // ---- 6. Emit transcription request for any audio/video attachments ---
    const transcribable = await step.run('find-transcribable-attachments', async () => {
      const db = getDb();
      const atts = await listAttachmentsForInteraction(db, interactionId);
      return atts.filter((a) =>
        TRANSCRIBABLE_MIME_PREFIXES.some((p) => a.mimeType.toLowerCase().startsWith(p)),
      );
    });

    if (transcribable.length > 0) {
      await step.sendEvent(
        'emit-transcription',
        transcribable.map((a) => ({
          name: 'nexus/transcription.requested' as const,
          data: {
            attachmentId: a.id,
            interactionId,
          },
        })),
      );
    }

    return {
      status,
      contactId,
      sessionId,
      identifierKind: identified.kind,
      transcriptionEmitted: transcribable.length,
    };
  },
);
