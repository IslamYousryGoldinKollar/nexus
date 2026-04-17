import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  approvalActionEnum,
  priorityEnum,
  proposedTaskStateEnum,
  syncStateEnum,
} from './enums';
import { sessions } from './sessions';

/**
 * ReasoningRun = one execution of Claude over a session's context bundle.
 * The full `contextBundle` and `rawResponse` are preserved for debugging,
 * replay, and cost analysis.
 */
export const reasoningRuns = pgTable(
  'reasoning_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    contextBundle: jsonb('context_bundle').$type<Record<string, unknown>>().notNull(),
    rawResponse: jsonb('raw_response').$type<Record<string, unknown>>(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('reasoning_runs_session_idx').on(t.sessionId),
  }),
);

export type ReasoningRun = typeof reasoningRuns.$inferSelect;
export type NewReasoningRun = typeof reasoningRuns.$inferInsert;

/**
 * ProposedTask = what Claude suggested, pre-approval.
 * `evidence` is an array of {interactionId, quote} pairs that justify the task.
 */
export const proposedTasks = pgTable(
  'proposed_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    reasoningRunId: uuid('reasoning_run_id')
      .notNull()
      .references(() => reasoningRuns.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    assigneeGuess: text('assignee_guess'),
    priorityGuess: priorityEnum('priority_guess').notNull().default('med'),
    dueDateGuess: timestamp('due_date_guess', { withTimezone: true }),
    rationale: text('rationale').notNull(),
    evidence: jsonb('evidence')
      .$type<Array<{ interactionId: string; quote: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: proposedTaskStateEnum('state').notNull().default('proposed'),
    telegramMessageId: text('telegram_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    sessionStateIdx: index('proposed_tasks_session_state_idx').on(t.sessionId, t.state),
  }),
);

export type ProposedTask = typeof proposedTasks.$inferSelect;
export type NewProposedTask = typeof proposedTasks.$inferInsert;

/**
 * ApprovedTask = mirror of what lives in Injaz. Tracks sync state + drift.
 */
export const approvedTasks = pgTable('approved_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  proposedTaskId: uuid('proposed_task_id')
    .notNull()
    .references(() => proposedTasks.id, { onDelete: 'cascade' }),
  injazTaskId: text('injaz_task_id'),
  syncState: syncStateEnum('sync_state').notNull().default('pending'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  syncError: text('sync_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type ApprovedTask = typeof approvedTasks.$inferSelect;
export type NewApprovedTask = typeof approvedTasks.$inferInsert;

/**
 * ApprovalEvent = audit trail for HITL decisions.
 * Every approve/edit/reject from Telegram, mobile app, or web leaves a row.
 */
export const approvalEvents = pgTable(
  'approval_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposedTaskId: uuid('proposed_task_id')
      .notNull()
      .references(() => proposedTasks.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id'),
    actorTelegramId: text('actor_telegram_id'),
    actorDeviceId: uuid('actor_device_id'),
    actorSurface: text('actor_surface').notNull(), // 'telegram' | 'mobile' | 'web'
    action: approvalActionEnum('action').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    proposedTaskIdx: index('approval_events_proposed_task_idx').on(t.proposedTaskId),
  }),
);

export type ApprovalEvent = typeof approvalEvents.$inferSelect;
export type NewApprovalEvent = typeof approvalEvents.$inferInsert;

// Suppress unused-bigint lint — reserved for future cost precision upgrade.
void bigint;
