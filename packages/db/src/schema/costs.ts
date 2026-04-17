import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { costServiceEnum } from './enums';
import { sessions } from './sessions';

/**
 * CostEvents — per-operation cost ledger.
 * Every LLM call, every transcription, every R2 write inserts a row.
 * The budget watchdog and /costs dashboard query this table.
 */
export const costEvents = pgTable(
  'cost_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    service: costServiceEnum('service').notNull(),
    // e.g. 'reason-session', 'transcribe-audio', 'store-attachment'.
    operation: text('operation').notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    serviceOccurredIdx: index('cost_events_service_occurred_idx').on(
      t.service,
      t.occurredAt,
    ),
    sessionIdx: index('cost_events_session_idx').on(t.sessionId),
  }),
);

export type CostEvent = typeof costEvents.$inferSelect;
export type NewCostEvent = typeof costEvents.$inferInsert;
