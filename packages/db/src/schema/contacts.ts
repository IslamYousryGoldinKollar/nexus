import { sql } from 'drizzle-orm';
import {
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { identifierKindEnum, pendingIdentifierStateEnum } from './enums';

/**
 * A Contact = a real human we communicate with.
 * Can belong to an Account (client company) or be freelance (accountId null).
 */
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  notes: text('notes'),
  // Optional mapping into Injaz so synced tasks land under the right
  // client/project. Both fields are free-text names because Injaz's
  // MCP create_task takes `projectName` (not an ID), and the list
  // endpoints don't expose stable IDs anyway. Update via PATCH
  // /api/contacts/[id].
  injazPartyName: text('injaz_party_name'),
  injazProjectName: text('injaz_project_name'),
  allowTranscription: boolean('allow_transcription').notNull().default(true),
  allowAction: boolean('allow_action').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;

/**
 * A ContactIdentifier = one way to reach a human (phone/email/handle).
 * Identity resolution queries this table.
 * UNIQUE(kind, value) guarantees no duplicate identifiers system-wide.
 */
export const contactIdentifiers = pgTable(
  'contact_identifiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    kind: identifierKindEnum('kind').notNull(),
    value: text('value').notNull(),
    verified: boolean('verified').notNull().default(false),
    source: text('source').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueKindValue: unique('contact_identifiers_kind_value_uq').on(t.kind, t.value),
  }),
);

export type ContactIdentifier = typeof contactIdentifiers.$inferSelect;
export type NewContactIdentifier = typeof contactIdentifiers.$inferInsert;

/**
 * PendingIdentifiers = unknown identifiers awaiting human linkage.
 * Every WhatsApp msg from a new number creates a row here until resolved.
 */
export const pendingIdentifiers = pgTable('pending_identifiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: identifierKindEnum('kind').notNull(),
  value: text('value').notNull(),
  firstSeenInteractionId: uuid('first_seen_interaction_id'),
  suggestedContactId: uuid('suggested_contact_id').references(() => contacts.id, {
    onDelete: 'set null',
  }),
  suggestionConfidence: numeric('suggestion_confidence', { precision: 4, scale: 3 }),
  state: pendingIdentifierStateEnum('state').notNull().default('pending'),
  telegramMessageId: text('telegram_message_id'),
  notificationId: uuid('notification_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export type PendingIdentifier = typeof pendingIdentifiers.$inferSelect;
export type NewPendingIdentifier = typeof pendingIdentifiers.$inferInsert;
