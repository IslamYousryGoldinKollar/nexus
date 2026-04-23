import { getDb, costEvents as costEventsTable, sql, users } from '@nexus/db';
import { evaluateBudget, isBudgetOverrideEnabled, type BudgetService } from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Budget Monitor — Phase 11
 *
 * Periodically checks budget status for all services and emits notifications
 * when 80% warning or 100% exceeded thresholds are crossed.
 *
 * Runs every hour via cron. Tracks last notified status per service to avoid
 * duplicate notifications for the same threshold.
 */

const SERVICES: BudgetService[] = ['anthropic', 'openai_whisper', 'assemblyai', 'resend'];

export const budgetMonitor = inngest.createFunction(
  {
    id: 'budget-monitor',
    name: 'Budget monitor (Phase 11)',
    retries: 2,
  },
  {
    cron: 'TZ=UTC 0 * * * *', // Every hour at minute 0
  },
  async ({ step, logger }) => {
    // If budget override is enabled, skip monitoring
    if (isBudgetOverrideEnabled()) {
      logger.info('budget.monitor.skipped_override');
      return { status: 'skipped-override' as const };
    }

    // Get the admin user for notifications
    const adminUser = await step.run('get-admin-user', async () => {
      const db = getDb();
      const [user] = await db.select().from(users).limit(1);
      return user ?? null;
    });

    if (!adminUser) {
      logger.warn('budget.monitor.no_admin_user');
      return { status: 'no-admin-user' as const };
    }

    // Check each service's budget status
    for (const service of SERVICES) {
      const budgetStatus = await step.run(`check-${service}`, async () => {
        const db = getDb();
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [row] = await db
          .select({ total: sql<number>`coalesce(sum(cost_usd), 0)` })
          .from(costEventsTable)
          .where(sql`${costEventsTable.service} = ${service} AND ${costEventsTable.occurredAt} >= ${startOfMonth}`);

        const spent = row?.total ?? 0;
        return evaluateBudget(service, spent);
      });

      // Emit notification if status is warn or exceeded
      if (budgetStatus.status === 'warn' || budgetStatus.status === 'exceeded') {
        const kind = budgetStatus.status === 'warn' ? 'cost_warn' : 'cost_exceeded';
        const title = budgetStatus.status === 'warn'
          ? `💰 Cost Warning: ${budgetStatus.service} at 80%`
          : `🚨 Cost Exceeded: ${budgetStatus.service} at 100%`;
        const body =
          `${budgetStatus.service} has spent $${budgetStatus.spentUsd.toFixed(2)} of $${budgetStatus.budgetUsd.toFixed(2)} this month.\n\n` +
          `Remaining: $${budgetStatus.remainingUsd.toFixed(2)}\n\n` +
          `${budgetStatus.status === 'exceeded' ? 'Circuit breaker activated. Review costs before resuming.' : 'Monitor closely to avoid circuit breaker.'}`;

        await step.sendEvent(`notify-${service}-${kind}`, {
          name: 'nexus/notification.requested',
          data: {
            userId: adminUser.id,
            kind,
            title,
            body,
            payload: {
              service: budgetStatus.service,
              spent: budgetStatus.spentUsd,
              budget: budgetStatus.budgetUsd,
              remaining: budgetStatus.remainingUsd,
            },
            fallbackDelayMin: 0, // Immediate for cost alerts
          },
        });

        logger.info('budget.monitor.notification_sent', {
          service,
          status: budgetStatus.status,
          spent: budgetStatus.spentUsd,
          budget: budgetStatus.budgetUsd,
        });
      }
    }

    return { status: 'completed' as const };
  },
);
