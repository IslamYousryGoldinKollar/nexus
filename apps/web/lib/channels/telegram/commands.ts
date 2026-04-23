import {
  approvalEvents,
  eq,
  getDb,
  getProposedTaskById,
  pendingIdentifiers,
  proposedTasks,
  sessions,
  sql,
} from '@nexus/db';
import { tgSendMessage, escapeMd } from '@nexus/services';
import { serverEnv } from '../../env';
import { log } from '../../logger';
import { inngest } from '../../inngest';

/**
 * Telegram text command handlers for /approve, /reject, /edit, /link.
 *
 * These complement the inline button callback handlers in approval.ts.
 * Commands are useful for users who prefer typing or when inline buttons
 * aren't available (e.g., when messages are forwarded).
 */

interface Message {
  message_id: number;
  chat: { id: number };
  from: { id: number; username?: string };
  text: string;
}

function parseAdminIds(): Set<string> {
  return new Set(
    serverEnv.TELEGRAM_ADMIN_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export async function handleTelegramCommand(msg: Message): Promise<void> {
  const botToken = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    log.error('tg.command.no_bot_token', {});
    return;
  }

  const admins = parseAdminIds();
  if (!admins.has(String(msg.from.id))) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: 'You are not authorized to use commands.',
    });
    log.warn('tg.command.unauthorized', { fromId: msg.from.id });
    return;
  }

  const text = msg.text.trim();
  if (!text.startsWith('/')) {
    return; // Not a command
  }

  const [command, ...args] = text.split(' ');
  const arg = args.join(' ').trim();

  switch (command) {
    case '/approve':
      await handleApprove(msg, botToken, arg);
      break;
    case '/reject':
      await handleReject(msg, botToken, arg);
      break;
    case '/edit':
      await handleEdit(msg, botToken, arg);
      break;
    case '/link':
      await handleLink(msg, botToken, arg);
      break;
    case '/help':
      await handleHelp(msg, botToken);
      break;
    default:
      await tgSendMessage({
        botToken,
        chatId: msg.chat.id,
        text: `Unknown command: ${command}\n\nUse /help for available commands.`,
      });
  }
}

async function handleApprove(msg: Message, botToken: string, taskId: string): Promise<void> {
  if (!taskId) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: 'Usage: /approve <task_id>',
    });
    return;
  }

  const db = getDb();
  const task = await getProposedTaskById(db, taskId);
  if (!task) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Task not found: ${taskId}`,
    });
    return;
  }

  if (task.state !== 'proposed' && task.state !== 'edited') {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Task is already ${task.state}.`,
    });
    return;
  }

  await db
    .update(proposedTasks)
    .set({ state: 'approved', updatedAt: sql`now()` })
    .where(eq(proposedTasks.id, taskId));

  await db.insert(approvalEvents).values({
    proposedTaskId: taskId,
    actorSurface: 'telegram',
    actorTelegramId: String(msg.from.id),
    action: 'approved',
  });

  await inngest.send({
    name: 'nexus/injaz.sync.requested',
    data: { proposedTaskId: taskId },
  });

  // Maybe close the session
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

  await tgSendMessage({
    botToken,
    chatId: msg.chat.id,
    text: `✅ Approved: ${escapeMd(task.title)}`,
  });

  log.info('tg.command.approve', { taskId, fromId: msg.from.id });
}

async function handleReject(msg: Message, botToken: string, taskId: string): Promise<void> {
  if (!taskId) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: 'Usage: /reject <task_id>',
    });
    return;
  }

  const db = getDb();
  const task = await getProposedTaskById(db, taskId);
  if (!task) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Task not found: ${taskId}`,
    });
    return;
  }

  if (task.state !== 'proposed' && task.state !== 'edited') {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Task is already ${task.state}.`,
    });
    return;
  }

  await db
    .update(proposedTasks)
    .set({ state: 'rejected', updatedAt: sql`now()` })
    .where(eq(proposedTasks.id, taskId));

  await db.insert(approvalEvents).values({
    proposedTaskId: taskId,
    actorSurface: 'telegram',
    actorTelegramId: String(msg.from.id),
    action: 'rejected',
  });

  // Maybe close the session
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

  await tgSendMessage({
    botToken,
    chatId: msg.chat.id,
    text: `❌ Rejected: ${escapeMd(task.title)}`,
  });

  log.info('tg.command.reject', { taskId, fromId: msg.from.id });
}

async function handleEdit(msg: Message, botToken: string, taskId: string): Promise<void> {
  if (!taskId) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: 'Usage: /edit <task_id>',
    });
    return;
  }

  const db = getDb();
  const task = await getProposedTaskById(db, taskId);
  if (!task) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Task not found: ${taskId}`,
    });
    return;
  }

  if (task.state !== 'proposed' && task.state !== 'edited') {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Task is already ${task.state}.`,
    });
    return;
  }

  // For now, just show the task details. Full inline editing would require
  // a multi-step conversation flow.
  await tgSendMessage({
    botToken,
    chatId: msg.chat.id,
    text:
      `*Task Details*\n\n` +
      `Title: ${escapeMd(task.title)}\n\n` +
      `Description: ${escapeMd(task.description.slice(0, 500))}${task.description.length > 500 ? '…' : ''}\n\n` +
      `To edit, use the web app or inline button.`,
  });

  log.info('tg.command.edit', { taskId, fromId: msg.from.id });
}

async function handleLink(msg: Message, botToken: string, identifierId: string): Promise<void> {
  if (!identifierId) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: 'Usage: /link <identifier_id> <contact_id>',
    });
    return;
  }

  const [id, contactId] = identifierId.split(' ');
  if (!id || !contactId) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: 'Usage: /link <identifier_id> <contact_id>',
    });
    return;
  }

  const db = getDb();
  const [identifier] = await db
    .select()
    .from(pendingIdentifiers)
    .where(eq(pendingIdentifiers.id, id))
    .limit(1);

  if (!identifier) {
    await tgSendMessage({
      botToken,
      chatId: msg.chat.id,
      text: `Identifier not found: ${id}`,
    });
    return;
  }

  // Link the identifier to the contact by updating suggestedContactId and state
  await db
    .update(pendingIdentifiers)
    .set({ suggestedContactId: contactId, state: 'linked', resolvedAt: new Date() })
    .where(eq(pendingIdentifiers.id, id));

  await tgSendMessage({
    botToken,
    chatId: msg.chat.id,
    text: `🔗 Linked identifier to contact ${contactId}`,
  });

  log.info('tg.command.link', { identifierId: id, contactId, fromId: msg.from.id });
}

async function handleHelp(msg: Message, botToken: string): Promise<void> {
  const helpText =
    `*Available Commands*\n\n` +
    `/approve <task_id> — Approve a proposed task\n` +
    `/reject <task_id> — Reject a proposed task\n` +
    `/edit <task_id> — View task details\n` +
    `/link <identifier_id> <contact_id> — Link identifier to contact\n` +
    `/help — Show this message\n\n` +
    `You can also use inline buttons in notification messages.`;

  await tgSendMessage({
    botToken,
    chatId: msg.chat.id,
    text: helpText,
  });
}
