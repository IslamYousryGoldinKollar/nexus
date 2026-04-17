import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { costEvents, type CostEvent, type NewCostEvent } from '../schema/costs.js';

/**
 * Insert a cost_event row.
 *
 * Every paid API call in the system (Claude, Whisper, AssemblyAI, R2
 * storage, etc.) logs one row here. Dashboards + budget circuit
 * breakers read this table exclusively.
 */
export async function recordCostEvent(
  db: Database,
  row: NewCostEvent,
): Promise<CostEvent> {
  const [inserted] = await db.insert(costEvents).values(row).returning();
  if (!inserted) throw new Error('cost_event insert returned no rows');
  return inserted;
}

/**
 * Sum the USD cost spent on a given service within the rolling window.
 * Returns the total as a number (numeric → float).
 */
export async function sumCostForServiceSince(
  db: Database,
  service: NewCostEvent['service'],
  since: Date,
): Promise<number> {
  const rows = await db
    .select({
      total: sql<string>`coalesce(sum(${costEvents.costUsd}), 0)`,
    })
    .from(costEvents)
    .where(and(eq(costEvents.service, service), gte(costEvents.occurredAt, since)));
  const totalStr = rows[0]?.total ?? '0';
  return Number(totalStr);
}

/**
 * Convenience: has this service exceeded its monthly budget?
 * If yes, the caller should circuit-break to avoid further spend.
 */
export async function isOverMonthlyBudget(
  db: Database,
  service: NewCostEvent['service'],
  budgetUsd: number,
): Promise<{ over: boolean; spent: number }> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spent = await sumCostForServiceSince(db, service, monthStart);
  return { over: spent >= budgetUsd, spent };
}
