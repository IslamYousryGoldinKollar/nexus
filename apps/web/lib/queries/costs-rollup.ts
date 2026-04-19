import 'server-only';
import { costEvents, desc, getDb, gte, sql } from '@nexus/db';

export interface DailyCost {
  day: string; // YYYY-MM-DD
  service: string;
  usd: number;
}

export async function loadCostsLast30Days(): Promise<DailyCost[]> {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${costEvents.occurredAt}), 'YYYY-MM-DD')`,
      service: costEvents.service,
      usd: sql<string>`coalesce(sum(${costEvents.costUsd}), 0)`,
    })
    .from(costEvents)
    .where(gte(costEvents.occurredAt, since))
    .groupBy(
      sql`date_trunc('day', ${costEvents.occurredAt})`,
      costEvents.service,
    )
    .orderBy(desc(sql`date_trunc('day', ${costEvents.occurredAt})`));

  return rows.map((r) => ({
    day: r.day,
    service: r.service,
    usd: Number(r.usd),
  }));
}
