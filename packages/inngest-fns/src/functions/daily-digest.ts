import {
  costEvents,
  desc,
  eq,
  getDb,
  gte,
  interactions,
  pendingIdentifiers,
  proposedTasks,
  sessions,
  sql,
} from '@nexus/db';
import { escapeMd, evaluateBudget, tgSendMessage, type BudgetService } from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Phase 11 — Daily digest cron.
 *
 * Runs once a day (default 09:00 UTC) and sends a Telegram digest to
 * TELEGRAM_ADMIN_CHAT_ID with:
 *   - 24-h ingest count by channel
 *   - 24-h sessions opened / closed
 *   - 24-h proposed tasks (approved / rejected / pending)
 *   - 24-h spend by service + monthly budget status with WARN/EXCEEDED chips
 *   - Pending identifiers backlog
 *
 * If anything is at WARN or EXCEEDED, the message uses a different
 * subject so it stands out in the Telegram chat.
 */

interface ServiceSpend {
  service: string;
  spentMonth: number;
}

async function loadDigestData() {
  const db = getDb();
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    ingestByChannel,
    sessionsOpened24h,
    sessionsClosed24h,
    tasks24h,
    pending24h,
    monthSpendByService,
    pendingIdsBacklog,
  ] = await Promise.all([
    db
      .select({
        channel: interactions.channel,
        count: sql<number>`count(*)::int`,
      })
      .from(interactions)
      .where(gte(interactions.occurredAt, day))
      .groupBy(interactions.channel),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(gte(sessions.openedAt, day)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(gte(sessions.closedAt, day)),
    db
      .select({
        state: proposedTasks.state,
        count: sql<number>`count(*)::int`,
      })
      .from(proposedTasks)
      .where(gte(proposedTasks.createdAt, day))
      .groupBy(proposedTasks.state),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(proposedTasks)
      .where(gte(proposedTasks.createdAt, day)),
    db
      .select({
        service: costEvents.service,
        spentMonth: sql<string>`coalesce(sum(${costEvents.costUsd}), 0)`,
      })
      .from(costEvents)
      .where(gte(costEvents.occurredAt, month))
      .groupBy(costEvents.service)
      .orderBy(desc(sql`sum(${costEvents.costUsd})`)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingIdentifiers)
      .where(eq(pendingIdentifiers.state, 'pending')),
  ]);

  const spend: ServiceSpend[] = monthSpendByService.map((r) => ({
    service: r.service,
    spentMonth: Number(r.spentMonth),
  }));

  return {
    ingestByChannel: ingestByChannel.map((r) => ({ channel: r.channel, count: r.count })),
    sessionsOpened24h: sessionsOpened24h[0]?.count ?? 0,
    sessionsClosed24h: sessionsClosed24h[0]?.count ?? 0,
    tasksByState: tasks24h.map((r) => ({ state: r.state, count: r.count })),
    tasks24hTotal: pending24h[0]?.count ?? 0,
    spend,
    pendingIdsBacklog: pendingIdsBacklog[0]?.count ?? 0,
  };
}

function pickEmoji(status: 'ok' | 'warn' | 'exceeded'): string {
  return status === 'exceeded' ? '🛑' : status === 'warn' ? '⚠️' : '✅';
}

function formatDigest(d: Awaited<ReturnType<typeof loadDigestData>>): {
  text: string;
  hasIssues: boolean;
} {
  let hasIssues = false;
  const lines: string[] = ['*Nexus daily digest*'];

  lines.push(
    `\n*Ingest \\(24h\\)* — ${d.ingestByChannel.reduce((s, r) => s + r.count, 0)} interactions`,
  );
  for (const r of d.ingestByChannel) {
    lines.push(`  • ${escapeMd(r.channel)}: ${r.count}`);
  }

  lines.push(
    `\n*Sessions \\(24h\\)* — ${d.sessionsOpened24h} opened, ${d.sessionsClosed24h} closed`,
  );
  lines.push(`*Tasks \\(24h\\)* — ${d.tasks24hTotal} proposed`);
  for (const r of d.tasksByState) {
    lines.push(`  • ${escapeMd(r.state)}: ${r.count}`);
  }
  if (d.pendingIdsBacklog > 0) {
    hasIssues = true;
    lines.push(`\n⚠️ *Pending identifiers backlog:* ${d.pendingIdsBacklog}`);
  }

  lines.push('\n*Monthly spend*');
  const tracked: BudgetService[] = ['anthropic', 'openai_whisper', 'assemblyai', 'resend'];
  for (const svc of tracked) {
    const spent = d.spend.find((s) => s.service === svc)?.spentMonth ?? 0;
    const evalRes = evaluateBudget(svc, spent);
    if (evalRes.status !== 'ok') hasIssues = true;
    lines.push(
      `  ${pickEmoji(evalRes.status)} ${escapeMd(svc)}: $${spent.toFixed(2)} / $${evalRes.budgetUsd.toFixed(0)}`,
    );
  }

  return { text: lines.join('\n'), hasIssues };
}

export const dailyDigest = inngest.createFunction(
  {
    id: 'daily-digest',
    name: 'Daily Telegram digest (Phase 11)',
    retries: 1,
  },
  { cron: process.env.DIGEST_CRON ?? '0 9 * * *' },
  async ({ step, logger }) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!botToken || !chatId) {
      logger.info('digest.skip.no_telegram', {});
      return { status: 'no-telegram' as const };
    }

    const data = await step.run('load-digest', loadDigestData);
    const { text, hasIssues } = formatDigest(data);

    await step.run('send-digest', () =>
      tgSendMessage({
        botToken,
        chatId,
        text: hasIssues ? `🚨 ${text}` : text,
        options: { parseMode: 'MarkdownV2' },
      }),
    );

    logger.info('digest.sent', { hasIssues });
    return { status: 'sent' as const, hasIssues };
  },
);
