import { eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { emails } from '../db/schema';
import { newMessageId, sendViaSmtp } from '../smtp';
import { templates } from '../templates/registry';
import {
  PermanentFailure,
  RETRY_WINDOW_MS,
  classifyFailure,
  retryDelaySeconds,
} from './retry';

type EmailDatabase = Pick<Db, 'select' | 'insert' | 'update'>;

const senderFor = (config: Config, category: 'app' | 'marketing') =>
  category === 'app'
    ? { address: config.APP_EMAIL_SENDER, name: config.APP_EMAIL_SENDER_NAME }
    : {
        address: config.MARKETING_EMAIL_SENDER,
        name: config.MARKETING_EMAIL_SENDER_NAME,
      };

export async function createEmail(
  db: EmailDatabase,
  config: Config,
  input: {
    idempotencyKey?: string;
    template: string;
    recipient: string;
    sendingApp: string;
    values: unknown;
    subscriberConsent?: boolean;
  },
) {
  const [row] = await db
    .insert(emails)
    .values({
      idempotencyKey: input.idempotencyKey,
      category: templates[input.template]!.category,
      template: input.template,
      recipient: input.recipient,
      sendingApp: input.sendingApp,
      values: JSON.stringify(input.values),
      subscriberConsent: input.subscriberConsent,
      status: 'queued',
      messageId: newMessageId(
        senderFor(config, templates[input.template]!.category).address,
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [emails.sendingApp, emails.recipient, emails.idempotencyKey],
      set: { id: sql`${emails.id}` },
    })
    .returning();
  return row!;
}

export async function getEmail(db: EmailDatabase, id: string) {
  const [row] = await db.select().from(emails).where(eq(emails.id, id));
  return row;
}

async function update(
  db: EmailDatabase,
  id: string,
  set: Partial<typeof emails.$inferInsert>,
) {
  await db
    .update(emails)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(emails.id, id));
}

const markFailed = (
  db: EmailDatabase,
  id: string,
  attempts: number,
  reason: string,
) => update(db, id, { status: 'failed', failureReason: reason, attempts });

const markSent = (db: EmailDatabase, id: string, attempts: number) =>
  update(db, id, { status: 'sent', failureReason: null, attempts });

export async function markEnqueueFailed(
  db: EmailDatabase,
  id: string,
  err: unknown,
) {
  const email = await getEmail(db, id);
  if (email)
    await markFailed(
      db,
      id,
      email.attempts + 1,
      `Could not queue: ${err instanceof Error ? err.message : String(err)}`,
    );
}

export interface Delivery {
  /** Set when the Email stays queued and should be tried again after this long. */
  retryInSeconds?: number;
}

export async function deliverEmail(
  db: Db,
  config: Config,
  id: string,
): Promise<Delivery> {
  const email = await getEmail(db, id);
  if (!email?.idempotencyKey) return deliverLockedEmail(db, config, id);
  // Keyed request retries serialize on the same Email, including queue redelivery.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM emails WHERE id = ${id} FOR UPDATE`);
    return deliverLockedEmail(tx, config, id);
  });
}

async function deliverLockedEmail(
  db: EmailDatabase,
  config: Config,
  id: string,
): Promise<Delivery> {
  const email = await getEmail(db, id);
  if (!email || email.status !== 'queued') return {};

  // Rows queued before Message-IDs were assigned at creation have none yet.
  let messageId = email.messageId;
  if (!messageId) {
    messageId = newMessageId(senderFor(config, email.category).address);
    await db.update(emails).set({ messageId }).where(eq(emails.id, email.id));
  }

  // Recorded before sending, so a crash mid-send still counts as an attempt.
  const attempts = email.attempts + 1;
  await update(db, id, { attempts });

  try {
    const template = templates[email.template];
    if (!template)
      throw new PermanentFailure(`Unknown template ${email.template}`);
    let content;
    try {
      content = template.render(JSON.parse(email.values));
    } catch (err) {
      throw new PermanentFailure(
        `Could not render: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const sender = senderFor(config, email.category);
    await sendViaSmtp(config, {
      messageId,
      sender: sender.address,
      senderName: sender.name,
      to: email.recipient,
      subject: content.subject,
      html: content.html,
    });
  } catch (err) {
    const failure = classifyFailure(err);
    const remainingMs =
      email.createdAt.getTime() + RETRY_WINDOW_MS - Date.now();
    if (failure.kind === 'permanent' || remainingMs <= 0) {
      await markFailed(db, id, attempts, failure.reason);
      return {};
    }
    await update(db, id, { failureReason: failure.reason });
    // The last retry lands on the deadline, so the Email fails on time.
    return {
      retryInSeconds: Math.min(
        retryDelaySeconds(attempts),
        Math.ceil(remainingMs / 1000),
      ),
    };
  }

  // Outside the try: a database error here must not mark a delivered Email as failed.
  await markSent(db, id, attempts);
  return {};
}
