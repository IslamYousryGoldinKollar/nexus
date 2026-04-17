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
