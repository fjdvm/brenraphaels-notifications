import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const emails = pgTable('emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category', { enum: ['app', 'marketing'] }).notNull(),
  template: text('template').notNull(),
  recipient: text('recipient').notNull(),
  sendingApp: text('sending_app').notNull(),
  values: text('values').notNull(),
  /** Marketing only: the caller's assertion that the recipient is a Subscriber. */
  subscriberConsent: boolean('subscriber_consent'),
  status: text('status', { enum: ['queued', 'sent', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  messageId: text('message_id'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const notifications = pgTable(
  'notifications',
  {
    idempotencyKey: text('idempotency_key'),
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    sendingApp: text('sending_app').notNull(),
    targetApp: text('target_app').notNull(),
    userId: text('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('notifications_event_recipient_idx').on(
      t.sendingApp,
      t.targetApp,
      t.userId,
      t.idempotencyKey,
    ),
    index('notifications_inbox_idx').on(
      t.targetApp,
      t.userId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
