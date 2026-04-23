import {
  eq,
  getDb,
  notifications as notificationsTable,
} from '@nexus/db';
import { inngest } from '../client.js';

/**
 * Notification Router — Phase 9
 *
 * Listens for `nexus/notification.requested` events, creates notification records,
 * sends immediate FCM push (if device tokens exist), and schedules Telegram fallback
 * after delay if still unread.
 *
 * Default fallback delays:
 * - proposal: 30 min
 * - pending_identifier: 10 min
 * - session_error: 0 min (immediate)
 * - cost_warn: 0 min (immediate)
 * - cost_exceeded: 0 min (immediate + circuit break)
 * - injaz_sync_fail: 60 min
 * - digest: scheduled at 21:00 local
 */

const DEFAULT_FALLBACK_DELAYS: Record<string, number> = {
  proposal: 30,
  pending_identifier: 10,
  session_error: 0,
  cost_warn: 0,
  cost_exceeded: 0,
  injaz_sync_fail: 60,
  digest: 0,
};

export const notificationRouter = inngest.createFunction(
  {
    id: 'notification-router',
    name: 'Notification router (Phase 9)',
    retries: 2,
  },
  { event: 'nexus/notification.requested' },
  async ({ event, step, logger }) => {
    const { userId, kind, title, body, payload, fallbackDelayMin } = event.data;

    // ---- 1. Create notification record ------------------------------------
    const notification = await step.run('create-notification', async () => {
      const db = getDb();
      const delay = fallbackDelayMin ?? DEFAULT_FALLBACK_DELAYS[kind] ?? 30;
      const fallbackDueAt = delay > 0 ? new Date(Date.now() + delay * 60 * 1000) : null;

      const [notif] = await db
        .insert(notificationsTable)
        .values({
          userId,
          kind,
          title,
          body,
          payload,
          deliveredChannels: [],
          fallbackDueAt,
        })
        .returning();

      return notif;
    });

    if (!notification) {
      logger.error('notification.creation_failed', { userId, kind });
      return { status: 'creation-failed' as const };
    }

    logger.info('notification.created', {
      notificationId: notification.id,
      kind,
      fallbackDueAt: notification.fallbackDueAt,
    });

    // ---- 2. Send immediate FCM push (if device tokens exist) -------------
    await step.run('send-fcm-push', async () => {
      // TODO: Implement FCM push sending
      // For now, we'll skip this and rely on Telegram fallback
      logger.info('notification.fcm_skipped', {
        notificationId: notification.id,
        reason: 'fcm_not_implemented_yet',
      });
    });

    // ---- 3. Schedule Telegram fallback if delay > 0 ---------------------
    if (notification.fallbackDueAt) {
      await step.sleepUntil('wait-for-fallback', notification.fallbackDueAt);

      // Check if notification is still unread
      const stillUnread = await step.run('check-read-status', async () => {
        const db = getDb();
        const [notif] = await db
          .select()
          .from(notificationsTable)
          .where(eq(notificationsTable.id, notification.id))
          .limit(1);
        return notif?.readAt === null;
      });

      if (stillUnread) {
        // Emit event for Telegram fallback
        await step.sendEvent('trigger-telegram-fallback', {
          name: 'nexus/telegram.fallback.requested',
          data: { notificationId: notification.id },
        });
      } else {
        logger.info('notification.already_read', { notificationId: notification.id });
      }
    } else {
      // Immediate fallback (delay = 0)
      await step.sendEvent('trigger-telegram-fallback-immediate', {
        name: 'nexus/telegram.fallback.requested',
        data: { notificationId: notification.id },
      });
    }

    return {
      status: 'routed' as const,
      notificationId: notification.id,
    };
  },
);
