import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { notificationKindEnum } from './enums';
import { users } from './users';

/**
 * Notifications — the persistent record of every ping the user received or
 * should receive. Feeds the in-app inbox and the Inngest fallback workflows
 * (FCM → sleep → Telegram if still unread).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKindEnum('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // Deep link payload, e.g. { proposedTaskId: "...", sessionId: "..." }
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    readAt: timestamp('read_at', { withTimezone: true }),
    // Channels this notification actually reached: ['fcm'] or ['fcm','telegram'] etc.
    deliveredChannels: text('delivered_channels').array().notNull().default([]),
    // When the Telegram fallback is due, if any.
    fallbackDueAt: timestamp('fallback_due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userReadIdx: index('notifications_user_read_idx').on(t.userId, t.readAt),
    kindIdx: index('notifications_kind_idx').on(t.kind),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
