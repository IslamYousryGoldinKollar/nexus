import {
  approvalEvents,
  eq,
  getDb,
  getProposedTaskById,
  proposedTasks,
  sessions,
  sql,
} from '@nexus/db';
import { tgAnswerCallbackQuery, tgEditMessageText, escapeMd } from '@nexus/services';
import { serverEnv } from '../../env';
import { log } from '../../logger';
import { inngest } from '../../inngest';

/**
 * Telegram callback_query handler for approval inline buttons.
 *
 * Callback data shape: `act:<taskId>:<verb>` where verb ∈ approve|reject.
 *
 * Edits the original message to a terminal "approved/rejected" form so
 * the same button can't be tapped twice from the chat history.
 *
 * Admin gating: the `from.id` of the callback must be in
 * TELEGRAM_ADMIN_IDS. Hostile inline-button injection (someone forwards
 * the message to a public channel) is blocked here.
 */

interface CallbackQuery {
  id: string;
  from: { id: number; username?: string };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

function parseAdminIds(): Set<string> {
  return new Set(
    serverEnv.TELEGRAM_ADMIN_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export async function handleTelegramCallback(cb: CallbackQuery): Promise<void> {
  const botToken = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    log.error('tg.callback.no_bot_token', {});
    return;
  }

  const admins = parseAdminIds();
  if (!admins.has(String(cb.from.id))) {
    await tgAnswerCallbackQuery({
      botToken,
      callbackQueryId: cb.id,
      text: 'You are not allowed to approve.',
      showAlert: true,
    });
    log.warn('tg.callback.unauthorized', { fromId: cb.from.id });
    return;
  }

  const m = /^act:([0-9a-f-]+):(approve|reject)$/.exec(cb.data ?? '');
  if (!m || !m[1] || !m[2]) {
    await tgAnswerCallbackQuery({
      botToken,
      callbackQueryId: cb.id,
      text: 'Invalid action.',
    });
    return;
  }
  const taskId = m[1];
  const verb = m[2] as 'approve' | 'reject';

  const db = getDb();
  const task = await getProposedTaskById(db, taskId);
  if (!task) {
    await tgAnswerCallbackQuery({ botToken, callbackQueryId: cb.id, text: 'Task not found.' });
    return;
  }

  // Idempotency: if the task already moved past `proposed`, just ACK.
  if (task.state !== 'proposed' && task.state !== 'edited') {
    await tgAnswerCallbackQuery({
      botToken,
      callbackQueryId: cb.id,
      text: `Already ${task.state}.`,
    });
    return;
  }

  const newState = verb === 'approve' ? 'approved' : 'rejected';
  await db
    .update(proposedTasks)
    .set({ state: newState, updatedAt: sql`now()` })
    .where(eq(proposedTasks.id, taskId));

  await db.insert(approvalEvents).values({
    proposedTaskId: taskId,
    actorSurface: 'telegram',
    actorTelegramId: String(cb.from.id),
    action: newState,
  });

  if (verb === 'approve') {
    await inngest.send({
      name: 'nexus/injaz.sync.requested',
      data: { proposedTaskId: taskId },
    });
  }

  // Maybe close the session.
  const allTasks = await db
    .select({ state: proposedTasks.state })
    .from(proposedTasks)
    .where(eq(proposedTasks.sessionId, task.sessionId));
  const allTerminal = allTasks.every(
    (r) => r.state === 'approved' || r.state === 'rejected' || r.state === 'synced',
  );
  if (allTerminal) {
    const anyApproved = allTasks.some((r) => r.state === 'approved' || r.state === 'synced');
    await db
      .update(sessions)
      .set({
        state: anyApproved ? 'approved' : 'rejected',
        closedAt: new Date(),
        updatedAt: sql`now()`,
      })
      .where(eq(sessions.id, task.sessionId));
  }

  await tgAnswerCallbackQuery({
    botToken,
    callbackQueryId: cb.id,
    text: verb === 'approve' ? 'Approved ✓' : 'Rejected ✗',
  });

  // Strip the inline keyboard from the original message so it can't be
  // tapped again from history.
  if (cb.message) {
    await tgEditMessageText({
      botToken,
      chatId: cb.message.chat.id,
      messageId: cb.message.message_id,
      text:
        `*${verb === 'approve' ? '✓ Approved' : '✗ Rejected'}*\n` +
        `_${escapeMd(task.title)}_\n\n` +
        `${escapeMd(task.description.slice(0, 300))}${task.description.length > 300 ? '…' : ''}`,
      removeKeyboard: true,
    }).catch((err) => {
      log.warn('tg.callback.edit_failed', { err: (err as Error).message });
    });
  }

  log.info('tg.callback.success', {
    taskId,
    verb,
    fromId: cb.from.id,
  });
}
