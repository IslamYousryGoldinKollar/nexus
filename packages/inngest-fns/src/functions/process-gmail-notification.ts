import {
  contacts,
  contactIdentifiers,
  eq,
  getDb,
  sessions as sessionsTable,
  upsertInteraction,
} from '@nexus/db';
import {
  getGmailAccessToken,
  getGmailHistory,
  getGmailMessage,
  reasonOverSession,
  GPT_4O_MINI,
} from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Phase 1.5/Phase 2: Process Gmail Pub/Sub notifications.
 *
 * Triggered by `nexus/gmail.notification.received` event.
 * Fetches email content from Gmail API, creates interactions,
 * and triggers reasoning for task extraction.
 */
export const processGmailNotification = inngest.createFunction(
  {
    id: 'process-gmail-notification',
    name: 'Process Gmail notification and extract tasks (Phase 1.5)',
    retries: 2,
    concurrency: { limit: 4 },
  },
  { event: 'nexus/gmail.notification.received' },
  async ({ event, step, logger }) => {
    const { emailAddress, historyId, messageId } = event.data;

    // ---- 1. Get access token --------------------------------------------
    const accessToken = await step.run('get-access-token', async () => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Google OAuth credentials not configured');
      }

      return getGmailAccessToken(clientId, clientSecret, refreshToken);
    });

    // ---- 2. Fetch history since last known history ID ------------------
    const history = await step.run('fetch-history', async () => {
      return getGmailHistory(accessToken, historyId);
    });

    if (!history || !history.history || history.history.length === 0) {
      logger.info('gmail.no_new_messages', { emailAddress, historyId });
      return { status: 'no-new-messages' as const };
    }

    // ---- 3. Process new messages ----------------------------------------
    const messageIds: string[] = [];
    for (const h of history.history) {
      if (h.messagesAdded) {
        for (const msg of h.messagesAdded) {
          messageIds.push(msg.message.id);
        }
      }
    }

    if (messageIds.length === 0) {
      logger.info('gmail.no_message_ids', { emailAddress, historyId });
      return { status: 'no-message-ids' as const };
    }

    // ---- 4. Fetch and parse each message --------------------------------
    const emails = await step.run('fetch-messages', async () => {
      const results: Array<{ id: string; email: any | null; error?: string }> = [];
      for (const id of messageIds) {
        try {
          const email = await getGmailMessage(accessToken, id);
          if (email) {
            results.push({ id, email });
          }
        } catch (err) {
          results.push({ id, email: null, error: (err as Error).message });
        }
      }
      return results;
    });

    // ---- 5. Create interactions for each email --------------------------
    const interactionIds: string[] = [];
    for (const { id, email, error } of emails) {
      if (error || !email) {
        logger.warn('gmail.fetch_failed', { messageId: id, error });
        continue;
      }

      const interactionId = await step.run(`create-interaction-${id}`, async () => {
        const db = getDb();

        // Resolve or create contact from email sender
        const fromEmail = email.from.match(/<(.+)>/)?.[1] || email.from;
        const existingContact = await db
          .select()
          .from(contactIdentifiers)
          .innerJoin(contacts, eq(contacts.id, contactIdentifiers.contactId))
          .where(eq(contactIdentifiers.value, fromEmail))
          .limit(1);

        let contactId: string;
        if (existingContact[0]) {
          contactId = existingContact[0].contacts.id;
        } else {
          // Create new contact
          const newContact = await db
            .insert(contacts)
            .values({
              displayName: email.from.replace(/<.+>/, '').trim(),
            })
            .returning();
          if (!newContact || !newContact[0]) throw new Error('Failed to create contact');
          contactId = newContact[0].id;

          await db.insert(contactIdentifiers).values({
            contactId,
            kind: 'email',
            value: fromEmail,
            verified: true,
            source: 'gmail',
          });
        }

        // Create or find session based on thread ID
        let sessionId: string;
        const existingSession = await db
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.threadId, email.threadId))
          .limit(1);

        if (existingSession[0]) {
          sessionId = existingSession[0].id;
        } else {
          const newSession = await db
            .insert(sessionsTable)
            .values({
              contactId,
              channel: 'gmail',
              threadId: email.threadId,
              state: 'open',
            })
            .returning();
          if (!newSession || !newSession[0]) throw new Error('Failed to create session');
          sessionId = newSession[0].id;
        }

        // Create interaction
        const { interaction } = await upsertInteraction(db, {
          sessionId: sessionId,
          contactId,
          channel: 'gmail',
          direction: 'inbound',
          contentType: 'text',
          text: email.subject + '\n\n' + email.body,
          rawPayload: email,
          sourceMessageId: email.id,
          occurredAt: new Date(email.timestamp),
        });

        return interaction.id;
      });

      interactionIds.push(interactionId);
    }

    logger.info('gmail.processed', {
      emailAddress,
      historyId,
      messageCount: messageIds.length,
      interactionCount: interactionIds.length,
    });

    // ---- 6. Trigger reasoning for new interactions ----------------------
    for (const sessionId of [...new Set(interactionIds)]) {
      await step.run(`trigger-reasoning-${sessionId}`, async () => {
        const db = getDb();
        const [session] = await db
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.id, sessionId))
          .limit(1);

        if (!session) return;

        // Update session state to trigger reasoning
        await db
          .update(sessionsTable)
          .set({ state: 'aggregating' })
          .where(eq(sessionsTable.id, sessionId));
      });
    }

    return {
      status: 'processed' as const,
      messageCount: messageIds.length,
      interactionCount: interactionIds.length,
    };
  },
);
