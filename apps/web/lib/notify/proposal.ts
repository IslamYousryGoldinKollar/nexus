import 'server-only';
import {
  contacts,
  eq,
  proposedTasks as proposedTasksTable,
  sessions as sessionsTable,
  type Database,
} from '@nexus/db';
import { escapeMd, tgSendMessage } from '@nexus/services';
import { log } from '@/lib/logger';

interface NotifyArgs {
  sessionId: string;
  proposedTaskIds: string[];
}

/**
 * Inline copy of the Phase 9 `notifyOnProposal` Inngest function.
 *
 * Reasoning is now driven by Vercel Crons (auto-reason) and the manual
 * /api/admin/direct-reasoning endpoint instead of Inngest, so the
 * `nexus/proposal.created` event is no longer reliably fired. Calling
 * this helper directly from the reasoning path keeps Telegram alerts
 * working end-to-end without depending on Inngest.
 *
 * Best-effort: failures are logged but never thrown.
 */
export async function notifyProposalCreated(
  db: Database,
  args: NotifyArgs,
): Promise<{ status: 'sent' | 'no-config' | 'no-card' | 'no-tasks' | 'failed' }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    log.info('notify.proposal.no_telegram_config', { sessionId: args.sessionId });
    return { status: 'no-config' };
  }

  if (args.proposedTaskIds.length === 0) {
    return { status: 'no-tasks' };
  }

  const [session] = await db
    .select({
      id: sessionsTable.id,
      contactId: sessionsTable.contactId,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, args.sessionId))
    .limit(1);
  if (!session) {
    log.warn('notify.proposal.no_session', { sessionId: args.sessionId });
    return { status: 'no-card' };
  }

  const [contact] = session.contactId
    ? await db
        .select({ displayName: contacts.displayName })
        .from(contacts)
        .where(eq(contacts.id, session.contactId))
        .limit(1)
    : [{ displayName: '(no contact)' }];

  const firstId = args.proposedTaskIds[0]!;
  const [first] = await db
    .select({ title: proposedTasksTable.title })
    .from(proposedTasksTable)
    .where(eq(proposedTasksTable.id, firstId))
    .limit(1);

  const contactName = contact?.displayName ?? '(no contact)';
  const taskCount = args.proposedTaskIds.length;
  const firstTitle = first?.title ?? '(untitled)';

  const text =
    `*New approval awaiting* — ${escapeMd(contactName)}\n` +
    `${taskCount} task${taskCount === 1 ? '' : 's'}, first one:\n` +
    `_${escapeMd(firstTitle)}_\n\n` +
    `Open the web admin to review all ${taskCount}, or tap below to approve/reject the first task right here\\.`;

  try {
    await tgSendMessage({
      botToken,
      chatId,
      text,
      options: {
        parseMode: 'MarkdownV2',
        inlineKeyboard: [
          [
            { text: '✓ Approve', callbackData: `act:${firstId}:approve` },
            { text: '✗ Reject', callbackData: `act:${firstId}:reject` },
          ],
        ],
      },
    });
    log.info('notify.proposal.sent', { sessionId: args.sessionId, firstTaskId: firstId });
    return { status: 'sent' };
  } catch (err) {
    log.error('notify.proposal.failed', {
      sessionId: args.sessionId,
      err: (err as Error).message,
    });
    return { status: 'failed' };
  }
}
