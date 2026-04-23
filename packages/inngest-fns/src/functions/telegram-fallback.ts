import {
  eq,
  getDb,
  notifications as notificationsTable,
  sql,
} from '@nexus/db';
import { tgSendMessage, escapeMd, type InlineButton } from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Telegram Fallback — Phase 9
 *
 * Listens for `nexus/telegram.fallback.requested` events, formats the notification
 * for Telegram, and sends it via the Telegram Bot API. Updates the notification's
 * delivered_channels to include 'telegram'.
 */

export const telegramFallback = inngest.createFunction(
  {
    id: 'telegram-fallback',
    name: 'Telegram fallback (Phase 9)',
    retries: 3,
  },
  { event: 'nexus/telegram.fallback.requested' },
  async ({ event, step, logger }) => {
    const { notificationId } = event.data;

    // ---- 1. Load notification ---------------------------------------------
    const notification = await step.run('load-notification', async () => {
      const db = getDb();
      const [notif] = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.id, notificationId))
        .limit(1);
      return notif ?? null;
    });

    if (!notification) {
      logger.warn('telegram.fallback.notification_not_found', { notificationId });
      return { status: 'not-found' as const };
    }

    // ---- 2. Check if already delivered via Telegram --------------------
    if (notification.deliveredChannels.includes('telegram')) {
      logger.info('telegram.fallback.already_delivered', { notificationId });
      return { status: 'already-delivered' as const };
    }

    // ---- 3. Format message for Telegram ---------------------------------
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const adminIds = process.env.TELEGRAM_ADMIN_IDS?.split(',').map((s) => s.trim()) || [];

    if (!botToken || adminIds.length === 0) {
      logger.warn('telegram.fallback.no_credentials', { notificationId });
      return { status: 'no-credentials' as const };
    }

    let text: string;
    let inlineKeyboard: InlineButton[][] | undefined;

    switch (notification.kind) {
      case 'proposal':
        text = formatProposalNotification(notification);
        inlineKeyboard = formatProposalButtons(notification);
        break;
      case 'pending_identifier':
        text = formatIdentifierNotification(notification);
        inlineKeyboard = formatIdentifierButtons(notification);
        break;
      case 'session_error':
        text = formatErrorNotification(notification);
        break;
      case 'cost_warn':
        text = formatCostWarnNotification(notification);
        break;
      case 'cost_exceeded':
        text = formatCostExceededNotification(notification);
        break;
      case 'injaz_sync_fail':
        text = formatInjazSyncFailNotification(notification);
        break;
      case 'digest':
        text = formatDigestNotification(notification);
        break;
      default:
        text = `*${escapeMd(notification.title)}*\n\n${escapeMd(notification.body)}`;
    }

    // ---- 4. Send to all admin Telegram IDs -----------------------------
    for (const adminId of adminIds) {
      await step.run(`send-to-${adminId}`, async () => {
        try {
          await tgSendMessage({
            botToken,
            chatId: adminId,
            text,
            options: {
              parseMode: 'MarkdownV2',
              inlineKeyboard,
              disableNotification: notification.kind === 'digest',
            },
          });
          logger.info('telegram.fallback.sent', {
            notificationId,
            adminId,
          });
        } catch (err) {
          logger.error('telegram.fallback.send_failed', {
            notificationId,
            adminId,
            error: (err as Error).message,
          });
          throw err;
        }
      });
    }

    // ---- 5. Update notification delivered channels ----------------------
    await step.run('mark-delivered', async () => {
      const db = getDb();
      await db
        .update(notificationsTable)
        .set({
          deliveredChannels: sql`array_append(delivered_channels, 'telegram')`,
        })
        .where(eq(notificationsTable.id, notificationId));
    });

    return {
      status: 'delivered' as const,
      notificationId,
      kind: notification.kind,
    };
  },
);

// ---- Notification formatters -------------------------------------------

interface ProposalPayload {
  proposedTaskIds?: string[];
  sessionId?: string;
}

interface IdentifierPayload {
  identifierId?: string;
  kind?: string;
  value?: string;
}

interface DbNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
}

function formatProposalNotification(notification: DbNotification): string {
  const payload = notification.payload as ProposalPayload | undefined;
  const taskIds = payload?.proposedTaskIds || [];
  const taskCount = taskIds.length;

  return (
    `*📋 New Proposal${taskCount > 1 ? `s (${taskCount})` : ''}*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}\n\n` +
    `Review in the app or use the buttons below:`
  );
}

function formatProposalButtons(notification: DbNotification): InlineButton[][] {
  const payload = notification.payload as ProposalPayload | undefined;
  const taskIds = payload?.proposedTaskIds || [];

  if (taskIds.length === 0) return [];

  // For multiple tasks, show a "View in app" button
  if (taskIds.length > 1) {
    return [[{ text: '📱 View in App', callbackData: `view:${taskIds[0]}` }]];
  }

  // For single task, show approve/reject buttons
  const taskId = taskIds[0];
  return [
    [
      { text: '✅ Approve', callbackData: `act:${taskId}:approve` },
      { text: '❌ Reject', callbackData: `act:${taskId}:reject` },
    ],
    [{ text: '✏️ Edit', callbackData: `edit:${taskId}` }],
  ];
}

function formatIdentifierNotification(notification: DbNotification): string {
  const payload = notification.payload as IdentifierPayload | undefined;
  const kind = payload?.kind || 'unknown';
  const value = payload?.value || 'unknown';

  return (
    `*🔔 New Identifier Detected*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}\n\n` +
    `Identifier: ${escapeMd(kind)}=${escapeMd(value)}\n\n` +
    `Link to an existing contact or create a new one.`
  );
}

function formatIdentifierButtons(notification: DbNotification): InlineButton[][] {
  const payload = notification.payload as IdentifierPayload | undefined;
  const identifierId = payload?.identifierId;

  if (!identifierId) return [];

  return [[{ text: '🔗 Link Contact', callbackData: `link:${identifierId}` }]];
}

function formatErrorNotification(notification: DbNotification): string {
  return (
    `*⚠️ Error*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}`
  );
}

function formatCostWarnNotification(notification: DbNotification): string {
  return (
    `*💰 Cost Warning (80%)*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}`
  );
}

function formatCostExceededNotification(notification: DbNotification): string {
  return (
    `*🚨 Cost Limit Exceeded (100%)*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}\n\n` +
    `Circuit breaker activated. Review costs before resuming.`
  );
}

function formatInjazSyncFailNotification(notification: DbNotification): string {
  return (
    `*❌ Injaz Sync Failed*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}\n\n` +
    `Manual sync may be required.`
  );
}

function formatDigestNotification(notification: DbNotification): string {
  return (
    `*📊 Daily Digest*\n\n` +
    `${escapeMd(notification.title)}\n\n` +
    `${escapeMd(notification.body)}`
  );
}
