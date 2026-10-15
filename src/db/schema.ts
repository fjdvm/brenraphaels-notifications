import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
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
