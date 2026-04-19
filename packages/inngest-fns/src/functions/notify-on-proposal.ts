import {
  contacts,
  eq,
  getDb,
  proposedTasks as proposedTasksTable,
  sessions as sessionsTable,
} from '@nexus/db';
import { escapeMd, tgSendMessage } from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Phase 9 — notify the admin (Telegram fallback) on `proposal.created`.
 *
 * Strategy:
 *   t=0:    send FCM data message (Phase 7 wired to mobile, deferred here)
 *   t=N:    if no approval recorded after NOTIFY_FALLBACK_PROPOSAL_MIN
 *           minutes, escalate to Telegram with inline approve/reject buttons
 *
 * Phase 11 will add the FCM half + reply-by-Telegram-text support. For
 * Phase 9 we just send Telegram immediately if `TELEGRAM_BOT_TOKEN` is
 * configured. The `wait_for_event` fallback is wired but optional —
 * controlled by `NOTIFY_VIA_TELEGRAM_IMMEDIATE` env (default true).
 */

interface ProposalNotificationCard {
  contactName: string;
  taskCount: number;
  firstTaskTitle: string;
  firstTaskId: string;
  sessionId: string;
}

async function loadCard(
  sessionId: string,
  proposedTaskIds: string[],
): Promise<ProposalNotificationCard | null> {
  const db = getDb();
  const [session] = await db
    .select({
      id: sessionsTable.id,
      contactId: sessionsTable.contactId,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);
  if (!session) return null;

  const [contact] = session.contactId
    ? await db
        .select({ displayName: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.id, session.contactId))
        .limit(1)
    : [{ displayName: '(no contact)' }];

  if (proposedTaskIds.length === 0) return null;
  const firstId = proposedTaskIds[0]!;
  const [first] = await db
    .select({ title: proposedTasksTable.title })
    .from(proposedTasksTable)
    .where(eq(proposedTasksTable.id, firstId))
    .limit(1);

  return {
    contactName: contact?.displayName ?? '(no contact)',
    taskCount: proposedTaskIds.length,
    firstTaskTitle: first?.title ?? '(untitled)',
    firstTaskId: firstId,
    sessionId,
  };
}

export const notifyOnProposal = inngest.createFunction(
  {
    id: 'notify-on-proposal',
    name: 'Send Telegram notification on proposal.created (Phase 9)',
    retries: 2,
    concurrency: { limit: 5 },
  },
  { event: 'nexus/proposal.created' },
  async ({ event, step, logger }) => {
    const { sessionId, proposedTaskIds } = event.data;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!botToken || !chatId) {
      logger.info('notify.skip.no_telegram_config', { sessionId });
      return { status: 'no-telegram-config' as const };
    }

    const card = await step.run('load-card', () => loadCard(sessionId, proposedTaskIds));
    if (!card) {
      logger.warn('notify.no_card', { sessionId });
      return { status: 'no-card' as const };
    }

    const text =
      `*New approval awaiting* — ${escapeMd(card.contactName)}\n` +
      `${card.taskCount} task${card.taskCount === 1 ? '' : 's'}, first one:\n` +
      `_${escapeMd(card.firstTaskTitle)}_\n\n` +
      `Open the web admin to review all ${card.taskCount}, or tap below to approve/reject the first task right here\\.`;

    await step.run('send-telegram', async () => {
      return tgSendMessage({
        botToken,
        chatId,
        text,
        options: {
          parseMode: 'MarkdownV2',
          inlineKeyboard: [
            [
              { text: '✓ Approve', callbackData: `act:${card.firstTaskId}:approve` },
              { text: '✗ Reject', callbackData: `act:${card.firstTaskId}:reject` },
            ],
          ],
        },
      });
    });

    logger.info('notify.telegram.sent', { sessionId, firstTaskId: card.firstTaskId });
    return { status: 'sent' as const, firstTaskId: card.firstTaskId };
  },
);
