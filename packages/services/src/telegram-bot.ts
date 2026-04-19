/**
 * Thin Telegram Bot API client — outgoing only.
 *
 * The incoming side (webhook + signature verify) lives in the
 * Next.js app. This module is the OUTGOING messaging surface: send
 * approval cards, status messages, daily digests.
 *
 * Inline keyboard semantics:
 *   - callback_data is a short string (max 64 bytes) that uniquely
 *     identifies an action. We use `act:<taskId>:<verb>` (~50 bytes for
 *     a uuid taskId + verb).
 */

const BASE = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface SendMessageOptions {
  parseMode?: 'MarkdownV2' | 'HTML';
  inlineKeyboard?: InlineButton[][];
  disableNotification?: boolean;
}

export async function tgSendMessage(args: {
  botToken: string;
  chatId: string | number;
  text: string;
  options?: SendMessageOptions;
}): Promise<{ messageId: number }> {
  const body: Record<string, unknown> = {
    chat_id: args.chatId,
    text: args.text,
    parse_mode: args.options?.parseMode ?? 'MarkdownV2',
    disable_notification: args.options?.disableNotification ?? false,
  };
  if (args.options?.inlineKeyboard) {
    body.reply_markup = {
      inline_keyboard: args.options.inlineKeyboard.map((row) =>
        row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
      ),
    };
  }

  const res = await fetch(`${BASE}/bot${args.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new TelegramError(
      `tg sendMessage failed: ${res.status} ${txt.slice(0, 300)}`,
      res.status,
    );
  }
  const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
  if (!data.ok || !data.result) throw new TelegramError(`tg sendMessage rejected: ${JSON.stringify(data)}`);
  return { messageId: data.result.message_id };
}

export async function tgEditMessageText(args: {
  botToken: string;
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML';
  removeKeyboard?: boolean;
}): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: args.chatId,
    message_id: args.messageId,
    text: args.text,
    parse_mode: args.parseMode ?? 'MarkdownV2',
  };
  if (args.removeKeyboard) {
    body.reply_markup = { inline_keyboard: [] };
  }
  const res = await fetch(`${BASE}/bot${args.botToken}/editMessageText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new TelegramError(`tg editMessageText failed: ${res.status} ${txt.slice(0, 300)}`, res.status);
  }
}

export async function tgAnswerCallbackQuery(args: {
  botToken: string;
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: args.callbackQueryId,
    show_alert: args.showAlert ?? false,
  };
  if (args.text) body.text = args.text;
  await fetch(`${BASE}/bot${args.botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Escape user-supplied text for MarkdownV2. Telegram's spec is harsh. */
export function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (c) => `\\${c}`);
}
