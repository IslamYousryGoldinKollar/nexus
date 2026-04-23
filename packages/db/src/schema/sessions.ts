import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { contacts } from './contacts';
import {
  channelEnum,
  contentTypeEnum,
  directionEnum,
  sessionStateEnum,
  sessionTriggerEnum,
  transcriptProviderEnum,
} from './enums';

/**
 * A Session = a bounded conversation context with a contact or account.
 * This is the "staging area" where interactions accumulate before reasoning.
 * State machine transitions are in packages/db/src/session-machine.ts.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    channel: channelEnum('channel'),
    threadId: text('thread_id'),
    state: sessionStateEnum('state').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    trigger: sessionTriggerEnum('trigger'),
    reasoningRunId: uuid('reasoning_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    contactStateIdx: index('sessions_contact_state_idx').on(t.contactId, t.state),
    lastActivityIdx: index('sessions_last_activity_idx').on(t.lastActivityAt),
    threadIdIdx: index('sessions_thread_id_idx').on(t.threadId),
  }),
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * An Interaction = a single atomic input/output event.
 * Polymorphic via `contentType`. ONE query to read a session's history.
 * UNIQUE(channel, source_message_id) gives us idempotent webhook retries.
 */
export const interactions = pgTable(
  'interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    channel: channelEnum('channel').notNull(),
    direction: directionEnum('direction').notNull(),
    contentType: contentTypeEnum('content_type').notNull(),
    text: text('text'),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    sourceMessageId: text('source_message_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelMsgUq: unique('interactions_channel_msg_uq').on(t.channel, t.sourceMessageId),
    sessionOccurredIdx: index('interactions_session_occurred_idx').on(
      t.sessionId,
      t.occurredAt,
    ),
  }),
);

export type Interaction = typeof interactions.$inferSelect;
export type NewInteraction = typeof interactions.$inferInsert;

/**
 * Attachments = binary blobs stored in R2.
 * `checksum` deduplicates identical files across different interactions
 * (e.g., the same voice note forwarded to two chats).
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    interactionId: uuid('interaction_id')
      .notNull()
      .references(() => interactions.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    driveUrl: text('drive_url'),
    checksum: text('checksum').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    checksumIdx: index('attachments_checksum_idx').on(t.checksum),
  }),
);

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

/**
 * Transcripts = processed audio/video text.
 * Stored separately because transcription is expensive and we cache by checksum.
 */
export const transcripts = pgTable('transcripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  attachmentId: uuid('attachment_id')
    .notNull()
    .references(() => attachments.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  segments: jsonb('segments').$type<
    Array<{ speaker?: string; start: number; end: number; text: string }>
  >(),
  language: text('language'),
  provider: transcriptProviderEnum('provider').notNull(),
  costUsd: bigint('cost_usd_millis', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Transcript = typeof transcripts.$inferSelect;
export type NewTranscript = typeof transcripts.$inferInsert;
